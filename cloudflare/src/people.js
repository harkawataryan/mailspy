// People and Companies: everyone you've emailed, and the companies they work at,
// with how they've responded (opens, clicks, replies) and when they usually open.

import { now } from "./util.js";
import { WEBMAIL } from "./templates.js";
import { ensureGoogleSchema } from "./google.js";
import { sentRef } from "./tracking.js";

export const PERSONAL = "personal";        // the "company" for gmail.com, outlook.com and the like
const OPEN_GAP = 1800;                     // opens of one email closer together than this count once
const MAX_OPENS = 100;                     // open times kept per person, for the pattern
const SLD = new Set(["co", "com", "ac", "org", "net", "gov", "edu", "or", "ne", "go"]);   // acme.co.uk, acme.com.au

export const domainOf = addr => {
  const a = String(addr || "").trim().toLowerCase();
  const i = a.lastIndexOf("@");
  return i >= 0 ? a.slice(i + 1) : "";
};

// "eu.jobs.stripe.com" -> "stripe.com", "mail.acme.co.uk" -> "acme.co.uk"
export function orgDomain(domain) {
  const p = String(domain || "").toLowerCase().replace(/\.+$/, "").split(".").filter(Boolean);
  if (p.length <= 2) return p.join(".");
  const n = p[p.length - 1].length === 2 && SLD.has(p[p.length - 2]) ? 3 : 2;
  return p.slice(-n).join(".");
}

export const isPersonal = domain => !!domain && WEBMAIL.test(orgDomain(domain));

// "acme-labs.com" -> "Acme Labs"
export function companyLabel(domain) {
  const label = orgDomain(domain).split(".")[0] || "";
  return label.split(/[-_]+/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// Names the email finder learned (KV find:org:<domain>), else the domain's label.
export async function companyNames(env, orgs) {
  const out = new Map();
  await Promise.all([...new Set(orgs)].slice(0, 500).map(async d => {
    let known = null;
    if (env && env.DOCS) known = await env.DOCS.get(`find:org:${d}`).catch(() => null);
    out.set(d, known || companyLabel(d));
  }));
  return out;
}

// Keep one open per burst: reopening the same email within half an hour counts once.
function spread(times) {
  const kept = [];
  for (const t of [...times].sort((a, b) => a - b)) if (!kept.length || t - kept[kept.length - 1] >= OPEN_GAP) kept.push(t);
  return kept;
}

const sql = {
  emails: `SELECT e.id, e.to_addr, e.to_name, e.subject, e.created_at, e.scheduled_at, e.opens, e.clicks, e.last_open,
      e.replied_at, e.replied_by, e.replied_addr,
      CASE WHEN json_valid(e.retry_json) THEN json_extract(e.retry_json, '$.name') END AS plan_name,
      (SELECT MAX(v.ts) FROM events v WHERE v.email_id=e.id AND v.kind='click' AND v.is_bot=0) AS last_click
    FROM emails e WHERE e.user_id=?1`,
  // Genuine opens only: no scanners, prefetches, your own views, or anything flagged as automatic.
  opens: `SELECT v.email_id, v.ts FROM events v JOIN emails e ON e.id=v.email_id
    WHERE e.user_id=?1 AND v.kind='open' AND v.is_bot=0 AND v.flagged IS NULL`,
};

// emails: rows from sql.emails, newest first. opens: rows from sql.opens.
export function groupPeople(emails, opens = []) {
  const t = now();
  const people = new Map(), byEmail = new Map();
  for (const e of emails) {
    const addr = String(e.to_addr || "").trim().toLowerCase();
    if (!addr) continue;
    let p = people.get(addr);
    if (!p) {
      const domain = domainOf(addr);
      p = { addr, name: "", domain, org: orgDomain(domain), personal: isPersonal(domain),
            sent: 0, opened: 0, clicked: 0, replied: 0, last_contact: 0, last_activity: 0, opens: [] };
      people.set(addr, p);
    }
    const replier = e.replied_addr === addr && e.replied_by && e.replied_by !== addr ? e.replied_by : "";
    if (!p.name) p.name = String(e.to_name || replier || e.plan_name || "").trim();
    p.sent++;
    if (e.opens > 0) p.opened++;
    if (e.clicks > 0) p.clicked++;
    if (e.replied_at) p.replied++;
    const s = sentRef(e);
    if (s > 0 && s <= t) p.last_contact = Math.max(p.last_contact, s);
    p.last_activity = Math.max(p.last_activity, e.last_open || 0, e.last_click || 0, e.replied_at || 0);
    byEmail.set(e.id, { p, times: [] });
  }
  for (const o of opens) { const x = byEmail.get(o.email_id); if (x) x.times.push(o.ts); }
  for (const { p, times } of byEmail.values()) p.opens.push(...spread(times));
  const list = [...people.values()];
  for (const p of list) p.opens = p.opens.sort((a, b) => b - a).slice(0, MAX_OPENS);
  // Most recent first: whichever is later, your last email or their last response.
  return list.sort((a, b) => Math.max(b.last_activity, b.last_contact) - Math.max(a.last_activity, a.last_contact) || a.addr.localeCompare(b.addr));
}

export function groupCompanies(people, names = new Map()) {
  const groups = new Map();
  for (const p of people) {
    const key = p.personal ? PERSONAL : p.org || p.domain;
    if (!key) continue;
    let c = groups.get(key);
    if (!c) {
      c = { key, personal: p.personal, domain: p.personal ? "" : key,
            name: p.personal ? "Personal addresses" : names.get(key) || companyLabel(key),
            people: [], sent: 0, opened: 0, clicked: 0, replied: 0, last_contact: 0, last_activity: 0 };
      groups.set(key, c);
    }
    c.people.push(p);
    for (const k of ["sent", "opened", "clicked", "replied"]) c[k] += p[k];
    c.last_contact = Math.max(c.last_contact, p.last_contact);
    c.last_activity = Math.max(c.last_activity, p.last_activity);
  }
  // Most recent first; personal addresses aren't a company, so they go last.
  return [...groups.values()].sort((a, b) => (a.personal - b.personal)
    || Math.max(b.last_activity, b.last_contact) - Math.max(a.last_activity, a.last_contact) || a.name.localeCompare(b.name));
}

export async function loadPeople(db, uid) {
  await ensureGoogleSchema(db);
  const emails = await db.prepare(sql.emails + " ORDER BY e.id DESC").bind(uid).all();
  const opens = await db.prepare(sql.opens + " ORDER BY v.ts DESC LIMIT 20000").bind(uid).all();
  return groupPeople(emails.results, opens.results);
}

// One person: their summary and every email to them (full rows, for statuses).
export async function loadPerson(db, uid, addr) {
  await ensureGoogleSchema(db);
  const a = String(addr || "").trim().toLowerCase();
  const rows = await db.prepare(sql.emails + " AND lower(trim(e.to_addr))=?2 ORDER BY COALESCE(NULLIF(e.scheduled_at, -1), e.created_at) DESC, e.id DESC").bind(uid, a).all();
  if (!rows.results.length) return null;
  const opens = await db.prepare(sql.opens + " AND lower(trim(e.to_addr))=?2 ORDER BY v.ts DESC LIMIT 5000").bind(uid, a).all();
  return { person: groupPeople(rows.results, opens.results)[0], emails: rows.results };
}

// ---- open-time pattern ----
// The hour of day depends on the viewer's time zone, so this runs in the browser
// (views.js puts it in the page). It's kept as source text, not functions:
// Wrangler's bundler rewrites function bodies (adding __name calls), which would
// break them in the page. The unit tests run this exact text.
//
// usualWindow(hours): local hours of someone's opens -> the 2-hour window most of
//   them fall in, { start, n, total }, or null with fewer than 3 opens or no clear favourite.
// hourRange(start): 9 -> "9–11 AM", 11 -> "11 AM–1 PM"
export const OPEN_PATTERN_JS = `
function usualWindow(hours) {
  var total = hours.length;
  if (total < 3) return null;
  var c = [];
  for (var i = 0; i < 24; i++) c.push(0);
  hours.forEach(function (h) { c[((Math.floor(h) % 24) + 24) % 24]++; });
  var best = -1, start = 0;
  for (var h = 0; h < 24; h++) {
    var n = c[h] + c[(h + 1) % 24];
    if (n > best) { best = n; start = h; }
  }
  if (best < Math.max(2, Math.ceil(total * 0.4))) return null;
  return { start: start, n: best, total: total };
}
function hourRange(start) {
  function f(h) { h = ((h % 24) + 24) % 24; return (h % 12 || 12) + (h < 12 ? " AM" : " PM"); }
  var a = f(start), b = f(start + 2);
  return a.slice(-2) === b.slice(-2) ? a.slice(0, -3) + "\\u2013" + b : a + "\\u2013" + b;
}
`;
