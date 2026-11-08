// Sign in with Google, and Gmail labels.
//
// Signing up or in with Google also gives MailSpy permission to add labels in
// your Gmail (the same permission Mailsuite asks for). With it, MailSpy marks
// each tracked email you send:
//     ✔   sent, not opened yet
//     ✔✔  opened
// The labels are the same ones Mailsuite uses, so there's one set of checkmarks.
// They're updated within seconds of an open (and swept every few minutes by
// the scheduled job), whether or not your computer is on.
//
// Needs two secrets from a Google Cloud OAuth client: GOOGLE_CLIENT_ID and
// GOOGLE_CLIENT_SECRET (see SETUP.md). Without them the Google buttons are hidden.
//
// The Gmail refresh token is stored encrypted (AES-GCM, key derived from
// SESSION_SECRET), and is only ever used to find your sent tracked emails and
// add or remove these two labels, for auto-try (retry.js), and to spot replies
// in their threads from the From/Date headers alone (replies.js).

import { now, randomToken } from "./util.js";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const SCOPES = ["openid", "email", "profile", GMAIL_SCOPE].join(" ");
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
export const LABEL_SENT = "✔";          // ✔
export const LABEL_OPENED = "✔✔";  // ✔✔
const LABEL_DAYS = 30;

export const googleEnabled = cfg => !!(cfg.googleClientId && cfg.googleClientSecret);
export const redirectUri = base => `${base}/auth/google/callback`;

// ------------------------------------------------------------------ schema
// Columns are added on first use, so no manual database step is needed.
let schemaReady = false;
export async function ensureGoogleSchema(db) {
  if (schemaReady) return;
  const cols = [
    ["users", "google_sub", "TEXT"],
    ["users", "gmail_token", "TEXT"],     // encrypted refresh token
    ["users", "gmail_email", "TEXT"],     // which Gmail account is connected
    ["users", "gmail_labels", "TEXT"],    // {"sent": "<label id>", "opened": "<label id>"}
    ["users", "gmail_error", "TEXT"],     // why labelling stopped, if it did
    ["emails", "gmail_msg", "TEXT"],      // the sent message's Gmail id, once found
    ["emails", "gmail_label", "TEXT"],    // label applied: sent | opened | nomatch
    ["emails", "retry_json", "TEXT"],     // auto-try plan and progress (src/retry.js)
    ["emails", "replied_at", "REAL"],     // when the first reply arrived (src/replies.js), NULL = no reply seen
    ["emails", "replied_by", "TEXT"],     // who replied: their name, or their address
    ["emails", "replied_addr", "TEXT"],   // who replied: their address
    ["emails", "reply_thread", "TEXT"],   // Gmail thread id of gmail_msg (cached for reply checks)
    ["emails", "reply_checked", "REAL"],  // last time the thread was checked for a reply
  ];
  for (const [t, c, type] of cols) {
    try { await db.prepare(`ALTER TABLE ${t} ADD COLUMN ${c} ${type}`).run(); }
    catch (e) { if (!/duplicate column/i.test(String(e && e.message))) throw e; }
  }
  schemaReady = true;
}

// ------------------------------------------------------------------ crypto
const te = new TextEncoder(), td = new TextDecoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

async function aesKey(secret) {
  const raw = await crypto.subtle.digest("SHA-256", te.encode("mailspy-gmail-token:" + secret));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function sealToken(secret, token) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), te.encode(token));
  return b64u(iv) + "." + b64u(ct);
}
export async function openToken(secret, sealed) {
  try {
    const [iv, ct] = String(sealed || "").split(".");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(iv) }, await aesKey(secret), unb64u(ct));
    return td.decode(pt);
  } catch { return ""; }
}

async function hmac(secret, data) {
  const k = await crypto.subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", k, te.encode(data)));
}

// Signed, short-lived state for the round trip to Google.
export async function makeState(secret, data) {
  const body = b64u(te.encode(JSON.stringify({ ...data, n: randomToken(9), exp: Math.floor(now()) + 900 })));
  return body + "." + (await hmac(secret, body));
}
export async function readState(secret, state) {
  const [body, sig] = String(state || "").split(".");
  if (!body || !sig || (await hmac(secret, body)) !== sig) return null;
  try {
    const d = JSON.parse(td.decode(unb64u(body)));
    return d.exp > now() ? d : null;
  } catch { return null; }
}

// ------------------------------------------------------------------ OAuth
// mode: signin | signup | connect | ext   (ext = signing in the Chrome extension)
export function authUrl(cfg, base, state, { consent = false, hint = "" } = {}) {
  const q = new URLSearchParams({
    client_id: cfg.googleClientId, redirect_uri: redirectUri(base), response_type: "code",
    scope: SCOPES, access_type: "offline", include_granted_scopes: "true", state,
    prompt: consent ? "consent" : "select_account",
  });
  if (hint) q.set("login_hint", hint);
  return `${AUTH_URL}?${q}`;
}

// Code -> { email, name, sub, refreshToken, gmail (bool: Gmail permission granted) }
export async function exchangeCode(cfg, base, code) {
  const r = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: cfg.googleClientId, client_secret: cfg.googleClientSecret,
      redirect_uri: redirectUri(base), grant_type: "authorization_code" }) });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.id_token) return { error: t.error_description || t.error || "Google sign-in failed." };
  // The ID token came straight from Google over HTTPS, so its contents can be trusted as-is.
  let claims = {};
  try { claims = JSON.parse(td.decode(unb64u(t.id_token.split(".")[1]))); } catch { return { error: "Google sign-in failed." }; }
  if (claims.aud !== cfg.googleClientId || !claims.email || claims.email_verified === false) return { error: "Google didn't confirm that email address." };
  return {
    email: String(claims.email).toLowerCase(), name: claims.name || "", sub: claims.sub,
    refreshToken: t.refresh_token || "", accessToken: t.access_token || "", expiresIn: t.expires_in || 0,
    gmail: String(t.scope || "").split(" ").includes(GMAIL_SCOPE),
  };
}

export async function saveGmail(db, cfg, userId, g) {
  await ensureGoogleSchema(db);
  const stmts = [db.prepare("UPDATE users SET google_sub=COALESCE(google_sub, ?) WHERE id=?").bind(g.sub, userId)];
  if (g.gmail && g.refreshToken) {
    stmts.push(db.prepare("UPDATE users SET gmail_token=?, gmail_email=?, gmail_error=NULL WHERE id=?")
      .bind(await sealToken(cfg.sessionSecret, g.refreshToken), g.email, userId));
  }
  await db.batch(stmts);
}

export async function disconnectGmail(db, cfg, userId) {
  await ensureGoogleSchema(db);
  const u = await db.prepare("SELECT gmail_token FROM users WHERE id=?").bind(userId).first();
  const token = u && u.gmail_token ? await openToken(cfg.sessionSecret, u.gmail_token) : "";
  if (token) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" }).catch(() => {});
  await db.prepare("UPDATE users SET gmail_token=NULL, gmail_email=NULL, gmail_labels=NULL, gmail_error=NULL WHERE id=?").bind(userId).run();
}

export async function gmailStatus(db, userId) {
  await ensureGoogleSchema(db);
  const u = await db.prepare("SELECT gmail_email, gmail_error, gmail_token IS NOT NULL AS on_ FROM users WHERE id=?").bind(userId).first();
  return { connected: !!(u && u.on_), email: u && u.gmail_email || "", error: u && u.gmail_error || "" };
}

// ------------------------------------------------------------------ Gmail API
const accessCache = new Map(); // userId -> { token, exp }

export async function accessToken(db, cfg, user) {
  const hit = accessCache.get(user.id);
  if (hit && hit.exp > Date.now() + 60000) return hit.token;
  const refresh = await openToken(cfg.sessionSecret, user.gmail_token);
  if (!refresh) return null;
  const r = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.googleClientId, client_secret: cfg.googleClientSecret,
      refresh_token: refresh, grant_type: "refresh_token" }) });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) {
    if (t.error === "invalid_grant") {
      // Access was removed in the Google account: stop trying until they reconnect.
      await db.prepare("UPDATE users SET gmail_token=NULL, gmail_error=? WHERE id=?")
        .bind("Gmail access was removed. Sign in with Google again to turn labels back on.", user.id).run();
    }
    return null;
  }
  accessCache.set(user.id, { token: t.access_token, exp: Date.now() + (t.expires_in || 3600) * 1000 });
  return t.access_token;
}

export async function gmail(token, path, opts = {}) {
  const r = await fetch(GMAIL + path, { ...opts, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(opts.headers || {}) } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Gmail ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? {} : r.json();
}

// The ✔ / ✔✔ label ids (created if missing, reused if Mailsuite already made them).
async function labelIds(db, token, user) {
  let ids = {};
  try { ids = JSON.parse(user.gmail_labels || "{}"); } catch {}
  if (ids.sent && ids.opened) return ids;
  const list = (await gmail(token, "/labels")) || {};
  const find = name => (list.labels || []).find(l => l.name === name);
  const make = async name => (await gmail(token, "/labels", { method: "POST",
    body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show" }) })).id;
  ids = { sent: (find(LABEL_SENT) || {}).id || await make(LABEL_SENT), opened: (find(LABEL_OPENED) || {}).id || await make(LABEL_OPENED) };
  await db.prepare("UPDATE users SET gmail_labels=? WHERE id=?").bind(JSON.stringify(ids), user.id).run();
  return ids;
}

const norm = s => String(s || "").replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, "").trim().toLowerCase();

// The sent message for a tracked email: same recipient, around the send time, same subject.
export async function findSent(token, e) {
  const sent = e.scheduled_at && e.scheduled_at > 0 ? e.scheduled_at : e.created_at;
  const q = `in:sent to:${e.to_addr} after:${Math.floor(sent) - 300} before:${Math.floor(sent) + 3 * 86400}`;
  const list = await gmail(token, `/messages?maxResults=5&q=${encodeURIComponent(q)}`);
  const want = norm(e.subject);
  let best = null, gap = Infinity;
  for (const m of (list && list.messages) || []) {
    const msg = await gmail(token, `/messages/${m.id}?format=metadata&metadataHeaders=Subject`);
    if (!msg) continue;
    const subj = ((msg.payload && msg.payload.headers) || []).find(h => h.name.toLowerCase() === "subject");
    if (want && want !== "(no subject)" && norm(subj && subj.value) !== want) continue;
    const g = Math.abs(Number(msg.internalDate) / 1000 - sent);
    if (g < gap) { best = msg.id; gap = g; }
  }
  return best;
}

const wantOf = e => (e.opens > 0 || e.clicks > 0) ? "opened" : "sent";

// Bring one tracked email's label up to date. Safe to call any time.
export async function labelEmail(env, cfg, emailId) {
  if (!googleEnabled(cfg)) return;
  const db = env.DB;
  await ensureGoogleSchema(db);
  const e = await db.prepare(`SELECT e.id, e.to_addr, e.subject, e.created_at, e.scheduled_at, e.opens, e.clicks,
      e.gmail_msg, e.gmail_label, u.id AS uid, u.gmail_token, u.gmail_labels
    FROM emails e JOIN users u ON u.id = e.user_id WHERE e.id=?`).bind(emailId).first();
  if (!e || !e.gmail_token || e.gmail_label === "nomatch") return;
  const want = wantOf(e);
  if (e.gmail_label === want) return;
  const user = { id: e.uid, gmail_token: e.gmail_token, gmail_labels: e.gmail_labels };
  const token = await accessToken(db, cfg, user);
  if (!token) return;
  try {
    let msg = e.gmail_msg;
    if (!msg) {
      msg = await findSent(token, e);
      if (!msg) {
        // Not in Sent yet (still sending, or scheduled). Give up after a day.
        const sent = e.scheduled_at && e.scheduled_at > 0 ? e.scheduled_at : e.created_at;
        if (now() - sent > 86400) await db.prepare("UPDATE emails SET gmail_label='nomatch' WHERE id=?").bind(e.id).run();
        return;
      }
    }
    const ids = await labelIds(db, token, user);
    const add = want === "opened" ? ids.opened : ids.sent, remove = want === "opened" ? ids.sent : ids.opened;
    const res = await gmail(token, `/messages/${msg}/modify`, { method: "POST", body: JSON.stringify({ addLabelIds: [add], removeLabelIds: [remove] }) });
    if (res === null) {           // message deleted: forget it, find it again next time
      await db.prepare("UPDATE emails SET gmail_msg=NULL WHERE id=?").bind(e.id).run();
      return;
    }
    await db.prepare("UPDATE emails SET gmail_msg=?, gmail_label=? WHERE id=?").bind(msg, want, e.id).run();
  } catch (err) {
    if (/Gmail 404/.test(String(err))) {
      // a label was deleted in Gmail: make them again next time
      await db.prepare("UPDATE users SET gmail_labels=NULL WHERE id=?").bind(user.id).run();
    }
    console.error("gmail label:", err);
  }
}

// Scheduled sweep: label anything recent that's out of date (new sends, missed opens).
export async function sweepLabels(env, cfg) {
  if (!googleEnabled(cfg)) return;
  const db = env.DB;
  await ensureGoogleSchema(db);
  const t = now();
  const rows = await db.prepare(`SELECT e.id FROM emails e JOIN users u ON u.id = e.user_id
    WHERE u.gmail_token IS NOT NULL AND e.created_at > ? AND (e.scheduled_at IS NULL OR e.scheduled_at <= ?)
      AND COALESCE(e.gmail_label, '') != 'nomatch'
      AND COALESCE(e.gmail_label, '') != CASE WHEN e.opens > 0 OR e.clicks > 0 THEN 'opened' ELSE 'sent' END
    ORDER BY e.id DESC LIMIT 4`).bind(t - LABEL_DAYS * 86400, t).all();
  for (const r of rows.results) await labelEmail(env, cfg, r.id);
}
