// Auto-try: send to the most likely address, and if it bounces, send the same
// email to the next one, until one gets through (or you run out of guesses).
//
// It goes one at a time on purpose: the person never gets more than one copy,
// even at companies whose mail servers accept every address ("catch-all"),
// where nothing ever bounces and sending to several at once would deliver them all.
//
// Needs the sender's Gmail connected (google.js). For each step it:
//   1. finds the copy in Sent,
//   2. looks for Gmail's "Address not found" bounce (in the same conversation,
//      or anywhere from mailer-daemon / postmaster mentioning that address),
//   3. on a bounce: moves the failed copy and the bounce notice to Trash, and
//      sends the same message (same tracking) to the next address,
//   4. with no bounce after a couple of minutes: counts it as delivered, and
//      keeps an eye out for a late bounce for a day.
// Steps run whenever the Gmail tab asks (every few seconds right after Send)
// and on the 5-minute schedule, so it carries on with Gmail closed.
//
// What it learns is remembered for next time: addresses that bounced are never
// suggested again, addresses that worked come first, and a company's real
// address format is learned from deliveries (finder.js uses all of this).

import { now } from "./util.js";
import { googleEnabled, ensureGoogleSchema, accessToken, gmail, findSent } from "./google.js";
import { alertStmt } from "./tracking.js";
import { PATTERNS, splitName, applyPattern } from "./finder.js";

export const MAX_TRIES = 5;
const DELIVERED_AFTER = 120;          // seconds with no bounce -> delivered
const LATE_BOUNCE_HOURS = 24;         // keep checking for a late bounce this long
const MEMORY_TTL = 365 * 86400;
const EMAIL_RE = /^[^\s@<>,;"']+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

// Validate the plan the extension sends with /api/prepare: { cands: [...], name }
export function cleanPlan(data) {
  const p = data && data.retry;
  if (!p || !Array.isArray(p.cands)) return null;
  const cands = [...new Set(p.cands.map(c => String(c || "").trim().toLowerCase()).filter(c => EMAIL_RE.test(c)))].slice(0, MAX_TRIES);
  const to = String(data.to || "").trim().toLowerCase();
  if (cands.length < 2 || cands[0] !== to) return null;
  return { cands, name: String(p.name || "").slice(0, 120) };
}

export async function startRetry(db, emailId, plan, scheduledAt) {
  await ensureGoogleSchema(db);
  const at = scheduledAt && scheduledAt > 0 ? scheduledAt : now();
  const r = { cands: plan.cands, name: plan.name, i: 0, state: "watching", at, msg: null, log: [] };
  await db.prepare("UPDATE emails SET retry_json=? WHERE id=?").bind(JSON.stringify(r), emailId).run();
}

// What the Gmail tab shows.
function status(r) {
  return { state: r.state, current: r.cands[r.i], step: r.i + 1, total: r.cands.length,
    tried: r.log.map(l => ({ to: l.to, result: l.result })) };
}

// ------------------------------------------------------------------ memory
export async function rememberAddress(env, email, verdict) {
  if (env.DOCS) await env.DOCS.put(`find:addr:${email}`, verdict, { expirationTtl: MEMORY_TTL }).catch(() => {});
}

// A delivery after a bounce proves the address (the company rejects unknown
// ones), so its format counts as evidence for that company.
async function learnFormat(env, email, name) {
  const n = splitName(name);
  if (!n || !env.DOCS) return;
  const [local, domain] = email.split("@");
  const hit = PATTERNS.find(([p]) => applyPattern(p, n) === local);
  if (!hit) return;
  const key = `find:learn:${domain}`;
  let votes = {};
  try { votes = JSON.parse((await env.DOCS.get(key)) || "{}"); } catch {}
  votes[hit[0]] = (votes[hit[0]] || 0) + 1;
  await env.DOCS.put(key, JSON.stringify(votes), { expirationTtl: MEMORY_TTL }).catch(() => {});
}

// ------------------------------------------------------------------ raw mail
const b64urlToBin = s => atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
const binToB64url = s => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const DROP_HEADERS = /^(to|cc|bcc|message-id|date|received|x-received|arc-[\w-]+|dkim-signature|x-google-[\w-]+|x-gm-[\w-]+|return-path|authentication-results|delivered-to|x-gmail-[\w-]+)$/i;

// The same message, addressed to someone else.
function readdress(raw, to) {
  const sep = raw.indexOf("\r\n\r\n");
  const head = sep >= 0 ? raw.slice(0, sep) : raw, body = sep >= 0 ? raw.slice(sep) : "\r\n\r\n";
  const lines = [];
  for (const line of head.split("\r\n")) {
    if (/^[ \t]/.test(line) && lines.length) lines[lines.length - 1] += "\r\n" + line;   // folded header
    else lines.push(line);
  }
  const kept = lines.filter(l => !DROP_HEADERS.test(l.split(":")[0].trim()));
  return [`To: ${to}`, ...kept].join("\r\n") + body;
}

async function resend(token, sourceId, to) {
  const src = await gmail(token, `/messages/${sourceId}?format=raw`);
  if (!src || !src.raw) return null;
  const raw = readdress(b64urlToBin(src.raw), to);
  const sent = await gmail(token, "/messages/send", { method: "POST", body: JSON.stringify({ raw: binToB64url(raw) }) });
  return sent && sent.id;
}

// ------------------------------------------------------------------ bounces
const hdr = (m, name) => {
  const h = ((m.payload && m.payload.headers) || []).find(x => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : "";
};
const fromDaemon = m => /mailer-daemon|postmaster|mail delivery/i.test(hdr(m, "From"));
const isBounceFor = (m, addr) => fromDaemon(m) &&
  (hdr(m, "X-Failed-Recipients").toLowerCase().includes(addr) || String(m.snippet || "").toLowerCase().includes(addr));
// Gmail's "Delivery incomplete" (still retrying) isn't a failure.
const isDelayNotice = m => /delay|incomplete|will retry/i.test(hdr(m, "Subject") + " " + (m.snippet || "")) && !hdr(m, "X-Failed-Recipients");

async function findBounce(token, msgId, addr, since) {
  const meta = "format=metadata&metadataHeaders=From&metadataHeaders=X-Failed-Recipients&metadataHeaders=Subject";
  const m = await gmail(token, `/messages/${msgId}?format=minimal`);
  if (!m) return { gone: true };
  const sentAt = Number(m.internalDate) / 1000 || 0;
  const th = await gmail(token, `/threads/${m.threadId}?${meta}`);
  let b = ((th && th.messages) || []).find(x => x.id !== msgId && isBounceFor(x, addr) && !isDelayNotice(x));
  if (b) return { bounce: b, sentAt };
  // A bounce sent later by the company's own server may arrive on its own.
  const q = `from:(mailer-daemon OR postmaster) after:${Math.floor(since) - 60} "${addr}"`;
  const list = await gmail(token, `/messages?maxResults=3&q=${encodeURIComponent(q)}`);
  for (const x of (list && list.messages) || []) {
    const full = await gmail(token, `/messages/${x.id}?${meta}`);
    if (full && isBounceFor(full, addr) && !isDelayNotice(full)) return { bounce: full, sentAt };
  }
  return { sentAt };
}

// ------------------------------------------------------------------ one step
export async function advanceRetry(env, cfg, emailId) {
  const db = env.DB;
  await ensureGoogleSchema(db);
  const e = await db.prepare(`SELECT e.id, e.user_id, e.subject, e.scheduled_at, e.retry_json, e.gmail_msg, e.sent_clean, u.gmail_token
    FROM emails e JOIN users u ON u.id = e.user_id WHERE e.id=?`).bind(emailId).first();
  if (!e || !e.retry_json) return null;
  let r;
  try { r = JSON.parse(e.retry_json); } catch { return null; }
  const save = () => db.prepare("UPDATE emails SET retry_json=? WHERE id=?").bind(JSON.stringify(r), e.id).run();
  const t = now();
  if (!["watching", "delivered"].includes(r.state)) return status(r);
  // Scheduled sends: nothing to check until Gmail actually sends the first copy.
  if (r.i === 0 && !r.msg && e.scheduled_at > 0 && r.at < e.scheduled_at) { r.at = e.scheduled_at; await save(); }
  if (r.at > t + 60) return { ...status(r), state: "scheduled" };
  if (r.state === "delivered") {
    if (t - r.at > LATE_BOUNCE_HOURS * 3600) { r.state = "done"; await save(); return status(r); }
    if (t - (r.checked || 0) < 1500) return status(r);     // late bounces: check every ~25 minutes
  }
  r.checked = t;
  if (!googleEnabled(cfg) || !e.gmail_token) { r.state = "nogmail"; await save(); return status(r); }
  const token = await accessToken(db, cfg, { id: e.user_id, gmail_token: e.gmail_token });
  if (!token) return status(r);
  const cur = r.cands[r.i];

  try {
    if (!r.msg) {
      r.msg = await findSent(token, { to_addr: cur, subject: e.subject, created_at: r.at, scheduled_at: null });
      if (!r.msg) {
        // Still waiting in Gmail's Scheduled folder (time unknown, or not reached yet)?
        const q = `in:scheduled to:${cur}`;
        const sch = await gmail(token, `/messages?maxResults=1&q=${encodeURIComponent(q)}`);
        if (sch && (sch.messages || []).length) {
          r.at = t;                                            // keep the search window up to date
          await save();
          return { ...status(r), state: "scheduled" };
        }
        if (t - r.at > 900) r.state = "lost";               // never showed up in Sent
        await save();
        return status(r);
      }
    }
    const found = await findBounce(token, r.msg, cur, r.at);
    if (found.gone) { r.msg = null; await save(); return status(r); }
    // time it from when Gmail really sent it (a scheduled email may go out later than planned)
    if (found.sentAt && !r.sentFixed) { r.at = found.sentAt; r.sentFixed = true; }
    if (found.bounce) {
      const failedCopy = r.msg;
      r.log.push({ to: cur, result: "bounced", t });
      await rememberAddress(env, cur, "bad");
      const next = r.cands[r.i + 1];
      const stmts = [];
      if (next) {
        const id = await resend(token, failedCopy, next);
        if (!id) { r.state = "failed"; await save(); return status(r); }
        r.i += 1; r.msg = id; r.at = now(); r.state = "watching"; r.sentFixed = true;
        stmts.push(db.prepare("UPDATE emails SET to_addr=?, gmail_msg=?, gmail_label=NULL, sent_clean=NULL WHERE id=?").bind(next, id, e.id));
      } else {
        r.state = "exhausted";
        stmts.push(alertStmt(db, e.id, "retry", `None of the ${r.cands.length} addresses for ${r.name || "this email"} worked. "${e.subject}" wasn't delivered.`, t, e.user_id));
      }
      // tidy up: the failed copy and the bounce notice go to Trash
      await gmail(token, `/messages/${failedCopy}/trash`, { method: "POST" }).catch(() => {});
      await gmail(token, `/messages/${found.bounce.id}/trash`, { method: "POST" }).catch(() => {});
      // A late bounce after the Sent copy was swapped for one without tracking
      // (sentcopy.js): r.msg is the original (resent from above, it still has the
      // tracking image), and the tracking-free copy goes to Trash with it.
      if (e.sent_clean === "done" && e.gmail_msg && e.gmail_msg !== failedCopy) {
        await gmail(token, `/messages/${e.gmail_msg}/trash`, { method: "POST" }).catch(() => {});
      }
      stmts.push(db.prepare("UPDATE emails SET retry_json=? WHERE id=?").bind(JSON.stringify(r), e.id));
      await db.batch(stmts);
      return status(r);
    }
    if (r.state === "watching" && t - r.at > DELIVERED_AFTER) {
      r.state = "delivered"; r.checked = t;
      r.log.push({ to: cur, result: "delivered", t });
      const stmts = [db.prepare("UPDATE emails SET retry_json=? WHERE id=?").bind(JSON.stringify(r), e.id)];
      if (r.i > 0) {
        // something bounced before this, so the company rejects unknown addresses: this one is real
        await rememberAddress(env, cur, "good");
        await learnFormat(env, cur, r.name);
        stmts.push(alertStmt(db, e.id, "retry", `Delivered to ${cur} after ${r.i} bounce${r.i === 1 ? "" : "s"}: "${e.subject}"`, t, e.user_id));
      }
      await db.batch(stmts);
      return status(r);
    }
    await save();
  } catch (err) {
    console.error("auto-try:", err);
  }
  return status(r);
}

// Scheduled: keep going for emails nobody's watching from Gmail right now.
export async function sweepRetries(env, cfg) {
  if (!googleEnabled(cfg)) return;
  const db = env.DB;
  await ensureGoogleSchema(db);
  // Due ones (not scheduled for later), the longest-unchecked first, so nothing starves.
  const rows = await db.prepare(`SELECT id FROM emails WHERE retry_json IS NOT NULL
      AND json_extract(retry_json, '$.state') IN ('watching', 'delivered')
      AND json_extract(retry_json, '$.at') <= ?
      AND created_at > ?
      ORDER BY COALESCE(json_extract(retry_json, '$.checked'), 0) ASC LIMIT 4`).bind(now() + 60, now() - 60 * 86400).all();
  for (const r of rows.results) await advanceRetry(env, cfg, r.id);
}

export async function retryByToken(env, cfg, userId, token) {
  const e = await env.DB.prepare("SELECT id FROM emails WHERE token=? AND user_id=?").bind(String(token || ""), userId).first();
  return e ? advanceRetry(env, cfg, e.id) : null;
}
