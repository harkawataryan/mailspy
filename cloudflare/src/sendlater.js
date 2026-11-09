// Send later, by MailSpy instead of Gmail's Schedule send.
//
// Gmail's own scheduled emails can't be edited through any API, and editing one in
// Gmail means cancelling and scheduling it again, which Gmail starts refusing after
// a lot of it in one day ("Message could not be sent"). So MailSpy can hold the
// emails as ordinary Gmail drafts and send them itself:
//   queue  find the user's draft to each address (one draft per address, or it's
//          refused) and remember it with the time to send it;
//   edit   change the text of queued drafts through the Gmail API (drafts.get raw,
//          rewrite the text parts, drafts.update). Headers, attachments and the
//          tracking image stay byte for byte;
//   send   the scheduled sweep (every 5 minutes) sends drafts that are due with
//          drafts.send, so they go out from the user's Gmail like any email.
// Only drafts that were explicitly queued are ever sent.
//
// States: queued -> sending -> sent, or failed / cancelled. "sending" is claimed
// before the API call; a claim left over from an interrupted run is only retried
// after checking the draft still exists (if it's gone, it was sent).

import { now, shortCode } from "./util.js";
import { ensureGoogleSchema, accessToken, gmail } from "./google.js";
import { rewrite, b64urlToBin, binToB64url } from "./sentcopy.js";
import { alertStmt } from "./tracking.js";

const PER_RUN = 20;          // drafts sent per scheduled run (Cloudflare allows ~50 subrequests)
const STALE = 600;           // a "sending" claim older than this was interrupted
const MAX_TRIES = 3;

export async function ensureSendSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS send_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    draft_id TEXT NOT NULL,
    to_addr TEXT NOT NULL,
    subject TEXT,
    send_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued',
    tries INTEGER NOT NULL DEFAULT 0,
    claimed_at INTEGER,
    sent_msg TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(user_id, draft_id))`).run();
}

async function tokenFor(env, cfg, uid) {
  await ensureGoogleSchema(env.DB);
  const u = await env.DB.prepare("SELECT id, gmail_token FROM users WHERE id=?").bind(uid).first();
  if (!u || !u.gmail_token) return null;
  return accessToken(env.DB, cfg, u);
}

const hdr = (msg, name) => ((msg.payload && msg.payload.headers) || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";
const addrsIn = v => [...String(v || "").toLowerCase().matchAll(/[^\s<>,;"']+@[^\s<>,;"']+/g)].map(m => m[0]);

// ------------------------------------------------------------------ text edits
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const htmlEsc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// The phrase as it can appear in a part: any run of whitespace (plain text is
// hard-wrapped) and, in HTML, an apostrophe written as &#39; / &#x27; / &rsquo;.
function phraseRe(from, html) {
  const parts = (html ? htmlEsc(from) : from).split(/\s+/).map(w => w.split("'").map(escRe).join(html ? "(?:'|&#39;|&#x27;|&rsquo;|’)" : "['’]"));
  return new RegExp(parts.join("\\s+"), "g");
}
export function editText(text, type, replace) {
  const html = type === "text/html";
  let out = text, hits = 0;
  for (const [from, to] of replace) {
    out = out.replace(phraseRe(from, html), () => { hits++; return html ? htmlEsc(to).replace(/'/g, "&#39;") : to; });
  }
  return { out, hits };
}
// The raw message (binary string) with the replacements made in its text and HTML parts.
export function editRaw(raw, replace) {
  const NL = raw.includes("\r\n") ? "\r\n" : "\n";
  let hits = 0;
  const out = rewrite(raw, NL, (text, type) => { const r = editText(text, type, replace); hits += r.hits; return r.out; }, 0, ["text/plain", "text/html"]);
  return { raw: out === null ? raw : out, hits };
}

// ------------------------------------------------------------------ link tracking
// Links copied out of an email open in Gmail come wrapped in Google's redirect
// (https://www.google.com/url?q=REAL&source=gmail&ust=EXPIRY…). Once it expires,
// recipients see a "Redirect notice" page instead of the site. Unwrap those.
const GOOGLE_RE = /https?:\/\/www\.google\.com\/url\?q=([^&"'\s<>]+)(?:&(?:amp;)?[^"'\s<>]*)*/gi;
export function unwrapGoogle(text) {
  return text.replace(GOOGLE_RE, (m, q) => { try { return decodeURIComponent(q); } catch { return m; } });
}
const HREF = /(<a\b[^>]*?\bhref\s*=\s*)(["'])(.*?)\2/gis;
// The raw message with Google redirects unwrapped and every web link turned into a
// tracked one. track(url) returns the tracked address (the same one for the same url),
// so the plain-text copy points where the HTML does. Links already on base stay.
// Returns { raw, token (the open pixel's), changed }.
export function linkRaw(raw, base, track) {
  const NL = raw.includes("\r\n") ? "\r\n" : "\n";
  const ours = base.replace(/\/$/, "") + "/";
  const want = u => /^https?:\/\//i.test(u) && !u.startsWith(ours);
  let token = null;
  const out = rewrite(raw, NL, (text, type) => {
    if (type === "text/html") {
      const px = text.match(/\/img\/([A-Za-z0-9_-]{6,})\.gif/);
      if (px) token = px[1];
      return text.replace(HREF, (m, pre, q, href) => {
        const url = unwrapGoogle(href.trim().replace(/&amp;/g, "&"));
        return want(url) ? `${pre}${q}${track(url)}${q}` : (url === href ? m : `${pre}${q}${url.replace(/&/g, "&amp;")}${q}`);
      });
    }
    // plain text: links appear as <url>
    return unwrapGoogle(text).replace(/<(https?:\/\/[^>\s]+)>/g, (m, url) => want(url) ? `<${track(url)}>` : m);
  }, 0, ["text/plain", "text/html"]);
  return { raw: out === null ? raw : out, token, changed: out !== null };
}

// Track the links in queued drafts, a page at a time. Each draft's open pixel says
// which email it is; its links are recorded against that email like any tracked link.
export async function trackQueuedLinks(env, cfg, uid, base, after = 0, limit = 15) {
  await ensureSendSchema(env.DB);
  const token = await tokenFor(env, cfg, uid);
  if (!token) return { error: "Connect Gmail first." };
  const rows = (await env.DB.prepare("SELECT id, draft_id, to_addr FROM send_queue WHERE user_id=? AND state='queued' AND id>? ORDER BY id LIMIT ?")
    .bind(uid, after, limit).all()).results;
  const results = [];
  for (const r of rows) {
    try {
      const d = await gmail(token, `/drafts/${r.draft_id}?format=raw`);
      if (!d || !d.message) { results.push({ to: r.to_addr, error: "draft not found" }); continue; }
      const raw = b64urlToBin(d.message.raw);
      const px = linkRaw(raw, base, u => u).token;    // dry run: find the email first
      const email = px && await env.DB.prepare("SELECT id FROM emails WHERE token=? AND user_id=?").bind(px, uid).first();
      if (!email) { results.push({ to: r.to_addr, error: "no MailSpy pixel in this draft" }); continue; }
      const codes = new Map();
      const res = linkRaw(raw, base, u => { if (!codes.has(u)) codes.set(u, shortCode(7)); return base.replace(/\/$/, "") + "/" + codes.get(u); });
      if (!res.changed) { results.push({ to: r.to_addr, links: 0 }); continue; }
      if (codes.size) await env.DB.batch([...codes].map(([u, c]) => env.DB.prepare("INSERT INTO links(email_id,token,url) VALUES(?,?,?)").bind(email.id, c, u)));
      await gmail(token, `/drafts/${r.draft_id}`, { method: "PUT", body: JSON.stringify({ id: r.draft_id, message: { raw: binToB64url(res.raw), threadId: d.message.threadId } }) });
      results.push({ to: r.to_addr, links: codes.size, urls: [...codes.keys()] });
    } catch (e) { results.push({ to: r.to_addr, error: String(e.message || e).slice(0, 200) }); }
  }
  const next = rows.length === limit ? rows[rows.length - 1].id : null;
  return { results, next };
}

// ------------------------------------------------------------------ queue
// to: addresses; at: unix seconds. One draft per address, or that address is refused.
export async function queueDrafts(env, cfg, uid, to, at) {
  await ensureSendSchema(env.DB);
  if (!(Number(at) > now())) return { error: "Pick a time in the future." };
  const token = await tokenFor(env, cfg, uid);
  if (!token) return { error: "Connect Gmail first." };
  const out = [];
  for (const raw of to.slice(0, 20)) {
    const addr = String(raw).trim().toLowerCase();
    try {
      const list = (await gmail(token, `/drafts?q=${encodeURIComponent("to:" + addr)}&maxResults=10`)) || {};
      const found = [];
      for (const d of list.drafts || []) {
        const full = await gmail(token, `/drafts/${d.id}?format=metadata`);
        if (full && full.message && addrsIn(hdr(full.message, "To")).includes(addr)) found.push({ id: d.id, subject: hdr(full.message, "Subject") });
      }
      if (found.length !== 1) { out.push({ to: addr, error: found.length ? `${found.length} drafts to this address` : "no draft to this address" }); continue; }
      await env.DB.prepare(`INSERT INTO send_queue(user_id,draft_id,to_addr,subject,send_at,created_at) VALUES(?,?,?,?,?,?)
          ON CONFLICT(user_id,draft_id) DO UPDATE SET send_at=excluded.send_at, state=CASE WHEN state IN ('sent','sending') THEN state ELSE 'queued' END, tries=0, error=NULL`)
        .bind(uid, found[0].id, addr, found[0].subject, Math.floor(at), now()).run();
      out.push({ to: addr, draft: found[0].id, subject: found[0].subject });
    } catch (e) { out.push({ to: addr, error: String(e.message || e).slice(0, 200) }); }
  }
  return { queued: out.filter(r => r.draft).length, results: out };
}

export async function listQueue(db, uid) {
  await ensureSendSchema(db);
  return (await db.prepare("SELECT id, draft_id, to_addr, subject, send_at, state, tries, sent_msg, error FROM send_queue WHERE user_id=? ORDER BY send_at, id").bind(uid).all()).results;
}

export async function cancelQueued(db, uid, ids) {
  await ensureSendSchema(db);
  let n = 0;
  for (const id of ids) n += (await db.prepare("UPDATE send_queue SET state='cancelled' WHERE id=? AND user_id=? AND state='queued'").bind(id, uid).run()).meta.changes;
  return { cancelled: n };
}

// Edit queued drafts, a page at a time (2 Gmail calls each). after: last queue id done.
export async function editQueued(env, cfg, uid, replace, after = 0, limit = 15) {
  await ensureSendSchema(env.DB);
  const pairs = (replace || []).filter(p => Array.isArray(p) && p.length === 2 && String(p[0]).trim()).map(([a, b]) => [String(a), String(b)]);
  if (!pairs.length) return { error: "Nothing to replace." };
  if (pairs.some(([a, b]) => /[^\x20-\x7e]/.test(a + b))) return { error: "Plain ASCII text only." };
  const token = await tokenFor(env, cfg, uid);
  if (!token) return { error: "Connect Gmail first." };
  const rows = (await env.DB.prepare("SELECT id, draft_id, to_addr FROM send_queue WHERE user_id=? AND state='queued' AND id>? ORDER BY id LIMIT ?")
    .bind(uid, after, limit).all()).results;
  const results = [];
  for (const r of rows) {
    try {
      const d = await gmail(token, `/drafts/${r.draft_id}?format=raw`);
      if (!d || !d.message) { results.push({ to: r.to_addr, error: "draft not found" }); continue; }
      const res = editRaw(b64urlToBin(d.message.raw), pairs);
      if (res.hits) {
        await gmail(token, `/drafts/${r.draft_id}`, { method: "PUT", body: JSON.stringify({ id: r.draft_id, message: { raw: binToB64url(res.raw), threadId: d.message.threadId } }) });
      }
      results.push({ to: r.to_addr, changed: res.hits });
    } catch (e) { results.push({ to: r.to_addr, error: String(e.message || e).slice(0, 200) }); }
  }
  const next = rows.length === limit ? rows[rows.length - 1].id : null;
  return { results, next };
}

// ------------------------------------------------------------------ send
// The tracked email was registered when the draft was written, maybe days ago.
// Record when it really goes out, so the hits that come right after sending
// (Google's own scan of outgoing mail, link scanners, bounce processing) fall in
// the "just sent" window and aren't counted as the recipient opening it.
async function markSendTime(db, q, t) {
  const rows = (await db.prepare("SELECT id, subject FROM emails WHERE user_id=? AND lower(to_addr)=lower(?) ORDER BY id DESC LIMIT 5")
    .bind(q.user_id, q.to_addr).all()).results;
  const e = rows.find(r => r.subject === q.subject) || (rows.length === 1 ? rows[0] : null);
  if (e) await db.prepare("UPDATE emails SET scheduled_at=? WHERE id=?").bind(t, e.id).run();
}

export async function sendDue(env, cfg, t = now()) {
  const db = env.DB;
  await ensureSendSchema(db);
  // interrupted claims: sent if the draft is gone, otherwise back in the queue
  const stale = (await db.prepare("SELECT id, user_id, draft_id FROM send_queue WHERE state='sending' AND claimed_at<? LIMIT 5").bind(t - STALE).all()).results;
  for (const s of stale) {
    const token = await tokenFor(env, cfg, s.user_id).catch(() => null);
    if (!token) continue;
    const d = await gmail(token, `/drafts/${s.draft_id}?format=minimal`).catch(() => undefined);
    if (d === null) await db.prepare("UPDATE send_queue SET state='sent', error='sent (confirmed after an interrupted run)' WHERE id=?").bind(s.id).run();
    else if (d) await db.prepare("UPDATE send_queue SET state='queued', claimed_at=NULL WHERE id=? AND state='sending'").bind(s.id).run();
  }
  const due = (await db.prepare("SELECT * FROM send_queue WHERE state='queued' AND send_at<=? ORDER BY send_at, id LIMIT ?").bind(t, PER_RUN).all()).results;
  let sent = 0;
  for (const q of due) {
    const claim = await db.prepare("UPDATE send_queue SET state='sending', claimed_at=?, tries=tries+1 WHERE id=? AND state='queued'").bind(t, q.id).run();
    if (!claim.meta.changes) continue;                       // someone else has it
    try {
      const token = await tokenFor(env, cfg, q.user_id);
      if (!token) throw new Error("Gmail isn't connected");
      await markSendTime(db, q, now());
      const msg = await gmail(token, "/drafts/send", { method: "POST", body: JSON.stringify({ id: q.draft_id }) });
      if (msg === null) {                                    // the draft was deleted (or already sent by hand)
        await db.prepare("UPDATE send_queue SET state='cancelled', error='draft no longer exists' WHERE id=?").bind(q.id).run();
        continue;
      }
      await db.prepare("UPDATE send_queue SET state='sent', sent_msg=?, error=NULL WHERE id=?").bind(msg.id || "", q.id).run();
      sent++;
    } catch (e) {
      const err = String(e.message || e).slice(0, 300);
      // It may have gone out even though the call failed: a sent draft disappears.
      const token = await tokenFor(env, cfg, q.user_id).catch(() => null);
      const still = token ? await gmail(token, `/drafts/${q.draft_id}?format=minimal`).catch(() => undefined) : undefined;
      if (still === null) { await db.prepare("UPDATE send_queue SET state='sent', error=? WHERE id=?").bind("sent (the reply was lost: " + err + ")", q.id).run(); sent++; continue; }
      if (still === undefined) {   // can't tell: leave it claimed; the stale check sorts it out later
        await db.prepare("UPDATE send_queue SET error=? WHERE id=?").bind(err, q.id).run();
        continue;
      }
      const last = q.tries + 1 >= MAX_TRIES;
      await db.prepare("UPDATE send_queue SET state=?, claimed_at=NULL, error=? WHERE id=?").bind(last ? "failed" : "queued", err, q.id).run();
      if (last) await alertStmt(db, null, "retry", `Couldn't send "${q.subject}" to ${q.to_addr}: ${err}. It's still in your Drafts.`, t, q.user_id).run();
    }
  }
  return { sent, due: due.length };
}
