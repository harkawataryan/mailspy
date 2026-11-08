// Replies: did anyone write back?
//
// For tracked emails from the last 30 days with no reply yet, MailSpy looks at
// the sent message's Gmail conversation (thread) for a message from someone
// other than you, dated after you sent it. It asks Gmail for nothing but the
// From and Date headers of those messages (plus Gmail's own SENT/DRAFT/SPAM
// markers, to skip your own messages), never bodies or snippets.
//
// Runs from the 5-minute schedule (a few emails per run, the longest-unchecked
// first, taking turns between people so nobody's emails starve), and on demand
// when you open an email's page. Needs the sender's Gmail connected (google.js)
// and the sent message found in Gmail (emails.gmail_msg, set by the ✔ labels).

import { now } from "./util.js";
import { googleEnabled, ensureGoogleSchema, accessToken, gmail, labelEmail } from "./google.js";
import { alertStmt, sentRef } from "./tracking.js";

export const REPLY_DAYS = 30;          // look for replies to emails sent in the last 30 days
const RUN_CALLS = 12;                  // Gmail requests per scheduled run (Cloudflare allows 50 subrequests in all)
const PER_EMAIL = 3;                   // most a single check can take (stale thread: message + thread + thread)
const RUN_EMAILS = 8;
const ALERT_DAYS = 3;                  // replies older than this when first seen are recorded without a notification
const RECENT = 3 * 86400;              // emails younger than this are checked every 10 minutes, older ones hourly
const ON_DEMAND_GAP = 60;              // opening an email's page checks again after a minute
const THREAD_FIELDS = "id,messages(id,labelIds,internalDate,payload/headers)";
const THREAD_Q = `format=metadata&metadataHeaders=From&metadataHeaders=Date&fields=${encodeURIComponent(THREAD_FIELDS)}`;
const SKIP_LABELS = ["SENT", "DRAFT", "SPAM"];
const DAEMON = /mailer-daemon|postmaster|mail delivery (subsystem|system)/i;

// "Jane Doe <jane@acme.com>" -> { name: "Jane Doe", addr: "jane@acme.com" }
export function parseFrom(v) {
  const s = String(v || "").trim();
  const m = s.match(/^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/);
  if (m) {
    const addr = m[2].toLowerCase();
    let name = m[1].trim().replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"').trim();
    if (name.toLowerCase() === addr || name.includes("@")) name = "";
    return { name, addr };
  }
  const a = s.match(/[^\s<>"',;]+@[^\s<>"',;]+/);
  return { name: "", addr: a ? a[0].toLowerCase() : "" };
}

const header = (m, name) => {
  const h = ((m.payload && m.payload.headers) || []).find(x => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : "";
};
const dateOf = m => {
  const internal = Number(m.internalDate) / 1000;
  if (internal > 0) return internal;
  const d = Date.parse(header(m, "Date"));
  return Number.isFinite(d) ? d / 1000 : 0;
};

// The first reply in a thread's messages, or null.
// own: your addresses (lowercase), sentId: your sent message, sentAt: when it went out.
export function findReply(messages, { sentId, sentAt, own }) {
  let best = null;
  for (const m of messages || []) {
    if (!m || m.id === sentId) continue;
    if ((m.labelIds || []).some(l => SKIP_LABELS.includes(l))) continue;     // yours, a draft, or spam
    const fromHdr = header(m, "From");
    const from = parseFrom(fromHdr);
    if (!from.addr || own.has(from.addr) || DAEMON.test(fromHdr)) continue; // you, or a bounce notice
    const at = dateOf(m);
    if (!(at > sentAt)) continue;
    if (!best || at < best.at) best = { at, name: from.name, addr: from.addr, id: m.id };
  }
  return best;
}

// Check one email's thread. budget (optional) counts Gmail requests: { used }.
export async function checkReply(env, cfg, emailId, budget = { used: 0 }) {
  if (!googleEnabled(cfg)) return null;
  const db = env.DB;
  await ensureGoogleSchema(db);
  const e = await db.prepare(`SELECT e.id, e.user_id, e.to_addr, e.to_name, e.subject, e.created_at, e.scheduled_at,
      e.gmail_msg, e.reply_thread, e.replied_at, u.gmail_token, u.gmail_email, u.email AS user_email
    FROM emails e JOIN users u ON u.id = e.user_id WHERE e.id=?`).bind(emailId).first();
  if (!e) return null;
  if (e.replied_at) return { replied: true };
  if (!e.gmail_msg || !e.gmail_token) return { replied: false };
  const token = await accessToken(db, cfg, { id: e.user_id, gmail_token: e.gmail_token });
  if (!token) return { replied: false };
  const t = now();
  const call = path => { budget.used++; return gmail(token, path); };
  const checked = thread => db.prepare("UPDATE emails SET reply_thread=?, reply_checked=? WHERE id=?").bind(thread, t, e.id).run();
  try {
    let threadId = e.reply_thread;
    let th = threadId ? await call(`/threads/${threadId}?${THREAD_Q}`) : null;
    if (!th || !(th.messages || []).some(m => m.id === e.gmail_msg)) {
      // Not looked up yet, or out of date (auto-try re-sent it to another address).
      const m = await call(`/messages/${e.gmail_msg}?format=minimal&fields=id,threadId`);
      if (!m || !m.threadId) { await checked(null); return { replied: false }; }   // deleted in Gmail
      threadId = m.threadId;
      th = await call(`/threads/${threadId}?${THREAD_Q}`);
    }
    const msgs = (th && th.messages) || [];
    const mine = msgs.find(m => m.id === e.gmail_msg);
    const sentAt = (mine && dateOf(mine)) || sentRef(e);
    const own = new Set([e.user_email, e.gmail_email].filter(Boolean).map(s => String(s).toLowerCase()));
    const reply = findReply(msgs, { sentId: e.gmail_msg, sentAt, own });
    if (!reply) { await checked(threadId); return { replied: false }; }
    const who = reply.name || reply.addr;
    const r = await db.prepare(`UPDATE emails SET replied_at=?, replied_by=?, replied_addr=?, reply_thread=?, reply_checked=?
        WHERE id=? AND replied_at IS NULL`).bind(reply.at, who, reply.addr, threadId, t, e.id).run();
    // Only the first to record it notifies (the schedule and an open page can race),
    // and replies from long ago (the first check after connecting Gmail) are recorded quietly.
    if (r.meta.changes && t - reply.at < ALERT_DAYS * 86400) {
      await alertStmt(db, e.id, "reply", `${who} replied to "${e.subject}"`, t, e.user_id).run();
    }
    return { replied: true, at: reply.at, by: who, addr: reply.addr };
  } catch (err) {
    console.error("reply check:", err);
    await db.prepare("UPDATE emails SET reply_checked=? WHERE id=?").bind(t, e.id).run().catch(() => {});
    return { replied: false, error: true };
  }
}

// Scheduled: a few emails per run, the longest-unchecked first, one person's at a time in turn.
export async function sweepReplies(env, cfg) {
  if (!googleEnabled(cfg)) return 0;
  const db = env.DB;
  await ensureGoogleSchema(db);
  const t = now();
  const rows = await db.prepare(`SELECT id, user_id FROM (
      SELECT e.id, e.user_id, COALESCE(e.reply_checked, 0) AS chk,
        ROW_NUMBER() OVER (PARTITION BY e.user_id ORDER BY COALESCE(e.reply_checked, 0), e.id DESC) AS rn
      FROM emails e JOIN users u ON u.id = e.user_id
      WHERE u.gmail_token IS NOT NULL AND e.gmail_msg IS NOT NULL AND e.replied_at IS NULL
        AND COALESCE(NULLIF(e.scheduled_at, -1), e.created_at) > ?1
        AND (e.scheduled_at IS NULL OR e.scheduled_at <= ?2)
        AND COALESCE(e.reply_checked, 0) < ?2 - CASE WHEN e.created_at > ?2 - ?3 THEN 600 ELSE 3600 END
    ) ORDER BY rn, chk LIMIT ?4`).bind(t - REPLY_DAYS * 86400, t, RECENT, RUN_EMAILS).all();
  const budget = { used: 0 }, users = new Set();
  let n = 0;
  for (const r of rows.results) {
    const tokenCall = users.has(r.user_id) ? 0 : 1;    // refreshing a person's Gmail access is a request too
    if (budget.used + tokenCall + PER_EMAIL > RUN_CALLS) break;
    if (tokenCall) { users.add(r.user_id); budget.used++; }
    await checkReply(env, cfg, r.id, budget);
    n++;
  }
  return n;
}

// Opening an email's page: look again (finding the sent message first if needed).
export async function refreshReply(env, cfg, email) {
  if (!googleEnabled(cfg) || !email || email.replied_at) return null;
  if (sentRef(email) < now() - REPLY_DAYS * 86400 || (email.scheduled_at && email.scheduled_at > now())) return null;
  if (email.reply_checked && now() - email.reply_checked < ON_DEMAND_GAP) return null;
  if (!email.gmail_msg) {
    await labelEmail(env, cfg, email.id);
    const m = await env.DB.prepare("SELECT gmail_msg FROM emails WHERE id=?").bind(email.id).first();
    if (!m || !m.gmail_msg) return null;
  }
  return checkReply(env, cfg, email.id);
}
