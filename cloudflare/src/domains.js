// Your own tracking domain on this server (Settings → "Your tracking domain").
//
// Someone types go.theirdomain.com. MailSpy registers it with Cloudflare
// ("custom hostnames", part of Cloudflare for SaaS) and routes it to this
// Worker; they add one CNAME record pointing at SAAS_TARGET. Once Cloudflare
// has checked the record and issued a certificate, their emails, PDFs and
// short links use their domain instead of TRACK_URL. Until then, nothing
// changes for them.
//
// Needs, set once by whoever runs this server:
//   SAAS_TARGET    (wrangler.toml var) the record people point their CNAME at,
//                  for example saas.aryanh.dev. It's also the fallback origin.
//   CF_API_TOKEN   (secret) a Cloudflare API token for that zone with
//                  "SSL and Certificates: Edit" and "Workers Routes: Edit".
// Without both, the setting doesn't appear.

import { now } from "./util.js";

const API = "https://api.cloudflare.com/client/v4";
const WORKER = "mailspy";   // wrangler.toml name

export const domainsEnabled = env => !!(env && env.CF_API_TOKEN && env.SAAS_TARGET);

export async function ensureDomainSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS track_domains (
    user_id INTEGER PRIMARY KEY,
    hostname TEXT UNIQUE NOT NULL,
    cf_id TEXT, route_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',   -- pending | active | error
    error TEXT, created_at REAL, checked_at REAL)`).run();
}

// "https://Go.Example.com/" -> "go.example.com", or throws a message for the user.
export function cleanHostname(raw, reserved = []) {
  let h = String(raw || "").trim().toLowerCase();
  h = h.replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/\.$/, "");
  if (!h) throw new Error("Enter a domain, for example go.yourdomain.com.");
  if (h.length > 253 || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(h)) {
    throw new Error("That isn't a valid domain. Use something like go.yourdomain.com.");
  }
  if (/^\d+(\.\d+){3}$/.test(h)) throw new Error("Use a domain name, not an IP address.");
  if (h.split(".").length < 3) {
    throw new Error("Use a subdomain, like go." + h + ". The bare domain can't point at MailSpy, and it's usually your website.");
  }
  for (const r of reserved.filter(Boolean)) {
    if (h === r || h.endsWith("." + r)) throw new Error("That domain belongs to this MailSpy server. Use one of your own.");
  }
  return h;
}

// ---- Cloudflare API
async function cf(env, method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.success === false) {
    const e = new Error(((d.errors || [])[0] || {}).message || `Cloudflare said ${r.status}`);
    e.code = ((d.errors || [])[0] || {}).code;
    e.status = r.status;
    throw e;
  }
  return d.result;
}

// The zone SAAS_TARGET lives in (saas.aryanh.dev -> aryanh.dev's zone id).
let zoneCache = null;
export async function zoneId(env) {
  if (env.CF_ZONE_ID) return env.CF_ZONE_ID;
  if (zoneCache && zoneCache.target === env.SAAS_TARGET) return zoneCache.id;
  const parts = String(env.SAAS_TARGET).split(".");
  for (let i = 1; i <= parts.length - 2; i++) {
    const name = parts.slice(i).join(".");
    const z = await cf(env, "GET", `/zones?name=${encodeURIComponent(name)}`);
    if (z && z[0]) { zoneCache = { target: env.SAAS_TARGET, id: z[0].id }; return z[0].id; }
  }
  throw new Error(`Couldn't find the Cloudflare zone for ${env.SAAS_TARGET}.`);
}

// What a Cloudflare custom hostname's state means for us.
export function hostnameState(h) {
  if (!h) return { status: "error", error: "Cloudflare no longer has this domain. Remove it and add it again." };
  const ssl = h.ssl || {};
  if (h.status === "active" && ssl.status === "active") return { status: "active", error: null };
  const errs = [...(h.verification_errors || []), ...((ssl.validation_errors || []).map(e => e.message))].filter(Boolean);
  if (["blocked", "moved", "deleted"].includes(h.status)) return { status: "error", error: errs[0] || `Cloudflare marked it ${h.status}.` };
  return { status: "pending", error: errs[0] || null };
}

// ---- reading
export async function userDomain(db, uid) {
  try { return await db.prepare("SELECT * FROM track_domains WHERE user_id=?").bind(uid).first(); }
  catch (e) { return null; }   // table not made yet
}

// "https://go.theirdomain.com" once it works, else "".
export async function userTrackBase(env, uid) {
  if (!domainsEnabled(env)) return "";
  const d = await userDomain(env.DB, uid);
  return d && d.status === "active" ? "https://" + d.hostname : "";
}

// Is this request's host someone's working tracking domain? Cached for a minute.
const hostCache = new Map();
export async function isUserDomain(env, host) {
  if (!domainsEnabled(env) || !host) return false;
  const c = hostCache.get(host);
  if (c && Date.now() - c.at < 60000) return c.ok;
  let ok = false;
  try {
    ok = !!(await env.DB.prepare("SELECT 1 FROM track_domains WHERE hostname=? AND status='active'").bind(host).first());
  } catch (e) {}
  if (hostCache.size > 500) hostCache.clear();
  hostCache.set(host, { ok, at: Date.now() });
  return ok;
}

// ---- changing
export async function setDomain(env, uid, raw, reserved = []) {
  const db = env.DB;
  await ensureDomainSchema(db);
  const hostname = cleanHostname(raw, [...reserved, env.SAAS_TARGET]);
  const old = await userDomain(db, uid);
  if (old && old.hostname === hostname) return refreshDomain(env, old);
  const taken = await db.prepare("SELECT user_id FROM track_domains WHERE hostname=?").bind(hostname).first();
  if (taken && taken.user_id !== uid) throw new Error("Someone on this server already uses that domain.");
  if (old) await removeDomain(env, uid);

  const zone = await zoneId(env);
  let h;
  try {
    h = await cf(env, "POST", `/zones/${zone}/custom_hostnames`, { hostname, ssl: { method: "http", type: "dv" } });
  } catch (e) {
    if (e.code === 1406 || /already exists/i.test(e.message)) throw new Error("Cloudflare already has that domain on another account or server.");
    throw e;
  }
  let route = null;
  try {
    route = await cf(env, "POST", `/zones/${zone}/workers/routes`, { pattern: `${hostname}/*`, script: WORKER });
  } catch (e) {
    await cf(env, "DELETE", `/zones/${zone}/custom_hostnames/${h.id}`).catch(() => {});
    throw e;
  }
  const st = hostnameState(h);
  await db.prepare(`INSERT INTO track_domains (user_id, hostname, cf_id, route_id, status, error, created_at, checked_at)
    VALUES (?,?,?,?,?,?,?,?)`).bind(uid, hostname, h.id, route && route.id, st.status, st.error, now(), now()).run();
  hostCache.delete(hostname);
  return userDomain(db, uid);
}

export async function refreshDomain(env, row) {
  if (!row || !row.cf_id) return row;
  const zone = await zoneId(env);
  let h = null;
  try { h = await cf(env, "GET", `/zones/${zone}/custom_hostnames/${row.cf_id}`); }
  catch (e) { if (e.status !== 404) throw e; }
  const st = hostnameState(h);
  await env.DB.prepare("UPDATE track_domains SET status=?, error=?, checked_at=? WHERE user_id=?")
    .bind(st.status, st.error, now(), row.user_id).run();
  hostCache.delete(row.hostname);
  return { ...row, ...st, checked_at: now() };
}

export async function removeDomain(env, uid) {
  const row = await userDomain(env.DB, uid);
  if (!row) return;
  const zone = await zoneId(env);
  if (row.route_id) await cf(env, "DELETE", `/zones/${zone}/workers/routes/${row.route_id}`).catch(() => {});
  if (row.cf_id) await cf(env, "DELETE", `/zones/${zone}/custom_hostnames/${row.cf_id}`).catch(() => {});
  await env.DB.prepare("DELETE FROM track_domains WHERE user_id=?").bind(uid).run();
  hostCache.delete(row.hostname);
}

// Cron: check domains still waiting on their DNS record (each at most every 10 minutes).
export async function checkPendingDomains(env, limit = 10) {
  if (!domainsEnabled(env)) return;
  let rows;
  try {
    rows = await env.DB.prepare(`SELECT * FROM track_domains WHERE status='pending' AND COALESCE(checked_at,0) < ?
      ORDER BY checked_at LIMIT ?`).bind(now() - 600, limit).all();
  } catch (e) { return; }
  for (const r of rows.results) await refreshDomain(env, r).catch(err => console.error("domain check:", r.hostname, err.message));
}
