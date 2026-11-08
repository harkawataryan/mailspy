// Gmail labels for tracked emails, so you can see on your phone what's been opened.
//
// A browser extension can only touch Gmail while your computer is on, so the
// labelling is done by a small Google Apps Script that runs in your own Google
// account every few minutes (see labelScript below). Each run it:
//   GET  /api/labels  -> tracked emails whose label needs to change
//   ...finds each sent message in Gmail and sets its label...
//   POST /api/labels  -> which labels it applied (and the Gmail thread it used)

import { now } from "./util.js";

export const LABEL_DAYS = 30; // only emails sent in the last 30 days are labelled

// What the label should be right now, from genuine (non-bot) activity.
const WANT_SQL = `CASE
    WHEN e.clicks > 0 OR EXISTS (SELECT 1 FROM doc_views v WHERE v.email_id = e.id AND v.is_self = 0) THEN 'clicked'
    WHEN e.opens > 0 THEN 'opened'
    ELSE 'unopened' END`;

export async function pendingLabels(db, userId) {
  const t = now();
  const rows = await db.prepare(
    `SELECT * FROM (
       SELECT e.id, e.to_addr, e.subject, e.created_at, e.scheduled_at, e.gmail_thread, e.label_state, ${WANT_SQL} AS want
       FROM emails e
       WHERE e.user_id = ? AND e.created_at > ?
         AND (e.scheduled_at IS NULL OR e.scheduled_at <= ? )
         AND COALESCE(e.label_state, '') != 'nomatch'
     ) WHERE COALESCE(label_state, '') != want
     ORDER BY id DESC LIMIT 40`)
    .bind(userId, t - LABEL_DAYS * 86400, t).all();
  await db.prepare("UPDATE users SET labels_sync_at = ? WHERE id = ?").bind(t, userId).run();
  return rows.results.map(r => ({
    id: r.id,
    to: r.to_addr,
    subject: r.subject,
    // when it actually went out: the scheduled time if known, otherwise when Send was clicked
    sent: r.scheduled_at && r.scheduled_at > 0 ? r.scheduled_at : r.created_at,
    thread: r.gmail_thread || "",
    had: r.label_state || "",
    want: r.want,
  }));
}

const STATES = new Set(["unopened", "opened", "clicked", "nomatch"]);

export async function saveLabels(db, userId, done) {
  const list = (Array.isArray(done) ? done : []).slice(0, 100)
    .filter(d => d && Number.isFinite(Number(d.id)) && STATES.has(d.state));
  if (!list.length) return 0;
  await db.batch(list.map(d =>
    db.prepare("UPDATE emails SET gmail_thread = COALESCE(?, gmail_thread), label_state = ? WHERE id = ? AND user_id = ?")
      .bind(d.thread ? String(d.thread).slice(0, 64) : null, d.state, Number(d.id), userId)));
  return list.length;
}

// The Apps Script, with this user's server address and key filled in.
export function labelScript(server, apiKey) {
  return `// MailSpy Gmail labels
// Labels your tracked sent emails "Tracked/Unopened", "Tracked/Opened" or
// "Tracked/Clicked" (a link or PDF was opened), so you can see them on your phone.
// Runs in your own Google account every 5 minutes. To stop it, run removeTrigger.
//
// First time: pick "setup" in the function menu above and press Run, then allow access.

var SERVER = ${JSON.stringify(server)};
var API_KEY = ${JSON.stringify(apiKey)};   // your MailSpy key: keep this script private

var LABELS = { unopened: "Tracked/Unopened", opened: "Tracked/Opened", clicked: "Tracked/Clicked" };
var SHOW = { unopened: ["unopened"], opened: ["opened"], clicked: ["opened", "clicked"] };

function setup() {
  removeTrigger();
  GmailApp.getUserLabelByName("Tracked") || GmailApp.createLabel("Tracked");
  Object.keys(LABELS).forEach(function (k) { label_(k); });
  ScriptApp.newTrigger("sync").timeBased().everyMinutes(5).create();
  sync();
  Logger.log("Done. Labels update every 5 minutes.");
}

function removeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "sync") ScriptApp.deleteTrigger(t);
  });
}

function sync() {
  var r = UrlFetchApp.fetch(SERVER + "/api/labels", { headers: { "X-API-Key": API_KEY }, muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) { Logger.log("MailSpy said " + r.getResponseCode() + ": " + r.getContentText()); return; }
  var items = JSON.parse(r.getContentText()).pending || [];
  var done = [];
  items.forEach(function (it) {
    try {
      var thread = null;
      if (it.thread) { try { thread = GmailApp.getThreadById(it.thread); } catch (e) {} }
      if (!thread) thread = findThread_(it);
      if (!thread) {
        // not in Sent yet (still sending, or scheduled); give up after a day
        if (Date.now() / 1000 - it.sent > 86400) done.push({ id: it.id, state: "nomatch" });
        return;
      }
      Object.keys(LABELS).forEach(function (k) {
        if (SHOW[it.want].indexOf(k) >= 0) thread.addLabel(label_(k));
        else if (it.had) thread.removeLabel(label_(k));
      });
      done.push({ id: it.id, thread: thread.getId(), state: it.want });
    } catch (e) {
      Logger.log("Email " + it.id + ": " + e);
    }
  });
  if (done.length) {
    UrlFetchApp.fetch(SERVER + "/api/labels", {
      method: "post", contentType: "application/json", headers: { "X-API-Key": API_KEY },
      payload: JSON.stringify({ done: done }), muteHttpExceptions: true,
    });
  }
}

// The sent message: same recipient, sent around that time, same subject.
function findThread_(it) {
  var after = Math.floor(it.sent) - 300, before = Math.floor(it.sent) + 3 * 86400;
  var q = "in:sent to:" + it.to + " after:" + after + " before:" + before;
  var want = norm_(it.subject), best = null, bestGap = Infinity;
  GmailApp.search(q, 0, 20).forEach(function (t) {
    t.getMessages().forEach(function (m) {
      if (want && want !== "(no subject)" && norm_(m.getSubject()) !== want) return;
      var gap = Math.abs(m.getDate().getTime() / 1000 - it.sent);
      if (m.getTo().toLowerCase().indexOf(String(it.to).toLowerCase()) >= 0 && gap < bestGap) { best = t; bestGap = gap; }
    });
  });
  return best;
}

function norm_(s) { return String(s || "").replace(/^\\s*((re|fw|fwd)\\s*:\\s*)+/i, "").trim().toLowerCase(); }

var labelCache_ = {};
function label_(k) {
  var name = LABELS[k];
  return labelCache_[name] || (labelCache_[name] = GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name));
}
`;
}
