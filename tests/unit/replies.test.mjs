// Reply detection (cloudflare/src/replies.js) and follow-up reminders that wait for it,
// against a fake Gmail, on node:sqlite.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
const SRC = new URL("../../cloudflare/src/", import.meta.url).href;
const G = await import(SRC + "google.js");
const R = await import(SRC + "replies.js");
const T = await import(SRC + "tracking.js");

let results = [];
const check = (n, c, d) => { results.push(!!c); console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  [" + JSON.stringify(d) + "]")); };

// D1 accepts numbered parameters (?1, ?2); node:sqlite's positional binding doesn't, so expand them.
function d1(sqlite) {
  const numbered = (sql, args) => {
    if (!/\?\d/.test(sql)) return [sql, args];
    const out = [];
    return [sql.replace(/\?(\d+)/g, (_, i) => { out.push(args[i - 1]); return "?"; }), out];
  };
  const stmt = (rawSql, rawArgs = []) => { const [sql, args] = numbered(rawSql, rawArgs); return {
    bind: (...a) => stmt(rawSql, a),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
  }; };
  return { prepare: sql => stmt(sql), batch: async list => { for (const s of list) await s.run(); return []; } };
}
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(new URL("../../cloudflare/schema.sql", import.meta.url), "utf8"));
const db = d1(sqlite);
const env = { DB: db };
const cfg = { googleClientId: "cid", googleClientSecret: "cs", sessionSecret: "test-session-secret-abcdefghijklmnop",
  followupHours: 48, revivalDays: 7, spikeCount: 3, spikeWindow: 600, prefetchWindow: 12 };
const now = () => Date.now() / 1000;
const H = 3600, D = 86400;

// ---- fake Gmail ----
// msgs: id -> { id, threadId, labelIds, from, date (unix seconds) }
const msgs = new Map();
let calls = [];
const put = (id, threadId, from, date, labelIds = ["INBOX"]) => msgs.set(id, { id, threadId, from, date, labelIds });
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url), method = opts.method || "GET";
  calls.push(`${method} ${u.host}${u.pathname}${u.search}`);
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
  if (u.host === "oauth2.googleapis.com") return J({ access_token: "at", expires_in: 3599 });
  const path = u.pathname.replace("/gmail/v1/users/me", "");
  const hdrs = m => [["From", m.from], ["Date", new Date(m.date * 1000).toUTCString()]].map(([name, value]) => ({ name, value }));
  let m = path.match(/^\/messages\/([^/]+)$/);
  if (m) {
    const msg = msgs.get(m[1]); if (!msg) return J({}, 404);
    return J({ id: msg.id, threadId: msg.threadId });
  }
  m = path.match(/^\/threads\/([^/]+)$/);
  if (m) {
    const list = [...msgs.values()].filter(x => x.threadId === m[1]);
    if (!list.length) return J({}, 404);
    return J({ id: m[1], messages: list.map(x => ({ id: x.id, labelIds: x.labelIds, internalDate: String(Math.round(x.date * 1000)), payload: { headers: hdrs(x) } })) });
  }
  return J({ error: "unexpected " + method + " " + url }, 500);
};
const gmailCalls = () => calls.filter(c => c.includes("googleapis.com"));

// ---- setup ----
await G.ensureGoogleSchema(db);
const mkUser = async (email) => {
  const id = Number(sqlite.prepare("INSERT INTO users(email,password_hash,api_key,is_admin,created_at) VALUES(?,'x',?,0,1)").run(email, "k" + email).lastInsertRowid);
  sqlite.prepare("UPDATE users SET gmail_token=?, gmail_email=? WHERE id=?").run(await G.sealToken(cfg.sessionSecret, "rt"), email, id);
  return id;
};
const uid = await mkUser("me@gmail.com");
let n = 0;
function newEmail(user, to, subject, sentAgo, { msg = true } = {}) {
  const k = ++n, sent = now() - sentAgo;
  const id = Number(sqlite.prepare("INSERT INTO emails(token,to_addr,subject,created_at,user_id,gmail_msg) VALUES(?,?,?,?,?,?)")
    .run("tok" + k, to, subject, sent, user, msg ? "s" + k : null).lastInsertRowid);
  if (msg) put("s" + k, "t" + k, "Me <me@gmail.com>", sent, ["SENT"]);
  return { id, msg: "s" + k, thread: "t" + k, sent };
}
const row = id => sqlite.prepare("SELECT * FROM emails WHERE id=?").get(id);
const alerts = id => sqlite.prepare("SELECT kind, message FROM alerts WHERE email_id=?").all(id);

// ---- parsing ----
const pf = R.parseFrom;
check("From: name and address", JSON.stringify(pf("Jane Doe <Jane@Acme.com>")) === JSON.stringify({ name: "Jane Doe", addr: "jane@acme.com" }), pf("Jane Doe <Jane@Acme.com>"));
check("From: quoted name with a comma", pf('"Doe, Jane" <jane@acme.com>').name === "Doe, Jane", pf('"Doe, Jane" <jane@acme.com>'));
check("From: bare address", pf("jane@acme.com").addr === "jane@acme.com" && pf("jane@acme.com").name === "", pf("jane@acme.com"));
check("From: name that's just the address is dropped", pf("jane@acme.com <jane@acme.com>").name === "", "");

const sentAt = 1000, own = new Set(["me@gmail.com"]);
const msg = (id, from, date, labelIds = ["INBOX"]) => ({ id, labelIds, internalDate: String(date * 1000), payload: { headers: [{ name: "From", value: from }] } });
const thread = [
  msg("s", "Me <me@gmail.com>", 1000, ["SENT"]),
  msg("b", "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", 1010),
  msg("o", "Me <me@gmail.com>", 1020),                       // yours, from another device, no SENT label
  msg("d", "Jane <jane@acme.com>", 1030, ["DRAFT"]),
  msg("x", "Spammer <x@spam.biz>", 1035, ["SPAM"]),
  msg("early", "Jane <jane@acme.com>", 900),                 // before you sent it
  msg("r2", "Jane Doe <jane@acme.com>", 1300),
  msg("r1", "Sam Lee <sam@acme.com>", 1200),
];
const f = R.findReply(thread, { sentId: "s", sentAt, own });
check("findReply: skips you, bounces, drafts, spam and older mail; earliest reply wins", f && f.id === "r1" && f.addr === "sam@acme.com" && f.name === "Sam Lee" && f.at === 1200, f);
check("findReply: none when only you wrote", R.findReply(thread.slice(0, 4), { sentId: "s", sentAt, own }) === null, "");

// ---- checking one email ----
const e1 = newEmail(uid, "jane@acme.com", "Coffee?", 2 * H);
calls = [];
let r = await R.checkReply(env, cfg, e1.id);
check("no reply yet", r && r.replied === false && !row(e1.id).replied_at, r);
check("thread looked up and remembered, check time saved", row(e1.id).reply_thread === e1.thread && row(e1.id).reply_checked > now() - 5, row(e1.id));
const threadCalls = gmailCalls().filter(c => c.includes("/threads/"));
const q = new URL("https://" + threadCalls[0].split(" ")[1]).searchParams;
check("asks Gmail only for From and Date headers, and no snippets or bodies",
  q.get("format") === "metadata" && JSON.stringify(q.getAll("metadataHeaders")) === '["From","Date"]'
  && /payload\/headers/.test(q.get("fields")) && !/snippet|body|raw/.test(q.get("fields")), threadCalls[0]);

put("rep1", e1.thread, "Jane Doe <jane@acme.com>", now() - 60);
calls = [];
r = await R.checkReply(env, cfg, e1.id);
const e1r = row(e1.id);
check("reply found: when and who saved", r.replied && e1r.replied_at > now() - 120 && e1r.replied_by === "Jane Doe" && e1r.replied_addr === "jane@acme.com", e1r);
check("cached thread: one Gmail request", gmailCalls().filter(c => c.includes("gmail.googleapis.com")).length === 1, gmailCalls());
const a1 = alerts(e1.id);
check("'reply' alert: Jane Doe replied to \"Coffee?\"", a1.length === 1 && a1[0].kind === "reply" && a1[0].message === 'Jane Doe replied to "Coffee?"', a1);
calls = [];
await R.checkReply(env, cfg, e1.id);
check("already replied: no more Gmail requests, no second alert", gmailCalls().length === 0 && alerts(e1.id).length === 1, gmailCalls());

// an old reply seen for the first time (e.g. just connected Gmail): recorded quietly
const e2 = newEmail(uid, "old@acme.com", "Old one", 20 * D);
put("rep2", e2.thread, "Old Person <old@acme.com>", now() - 10 * D);
await R.checkReply(env, cfg, e2.id);
check("old reply: recorded without a notification", row(e2.id).replied_at && alerts(e2.id).length === 0, alerts(e2.id));

// your own follow-up in the thread isn't a reply
const e3 = newEmail(uid, "quiet@acme.com", "Following up", 3 * D);
put("mine3", e3.thread, "Me <me@gmail.com>", now() - D, ["SENT"]);
await R.checkReply(env, cfg, e3.id);
check("your own follow-up doesn't count", !row(e3.id).replied_at, row(e3.id));

// auto-try re-sent it to another address: new message, new thread
const e4 = newEmail(uid, "a@acme.com", "Retry", H);
await R.checkReply(env, cfg, e4.id);
put("s4b", "t4b", "Me <me@gmail.com>", now() - 30 * 60, ["SENT"]);
put("rep4", "t4b", "B Person <b@acme.com>", now() - 60);
sqlite.prepare("UPDATE emails SET gmail_msg='s4b', to_addr='b@acme.com' WHERE id=?").run(e4.id);
await R.checkReply(env, cfg, e4.id);
check("stale cached thread: finds the new one and its reply", row(e4.id).reply_thread === "t4b" && row(e4.id).replied_addr === "b@acme.com", row(e4.id));

// deleted in Gmail
const e5 = newEmail(uid, "gone@acme.com", "Gone", H);
msgs.delete(e5.msg);
r = await R.checkReply(env, cfg, e5.id);
check("sent message deleted: no reply, no error", r.replied === false && !r.error && row(e5.id).reply_checked > 0, r);

// ---- opening an email's page ----
const e6 = newEmail(uid, "page@acme.com", "On demand", H);
calls = [];
await R.refreshReply(env, cfg, row(e6.id));
const first = gmailCalls().length;
put("rep6", e6.thread, "Page Person <page@acme.com>", now() - 5);
calls = [];
r = await R.refreshReply(env, cfg, row(e6.id));
check("page open checks Gmail, but not again within a minute", first >= 1 && r === null && gmailCalls().length === 0, { first, calls });
sqlite.prepare("UPDATE emails SET reply_checked=? WHERE id=?").run(now() - 120, e6.id);
r = await R.refreshReply(env, cfg, row(e6.id));
check("a minute later it looks again and finds the reply", r && r.replied && row(e6.id).replied_by === "Page Person", r);
const tooOld = newEmail(uid, "ancient@acme.com", "Ancient", 40 * D);
calls = [];
r = await R.refreshReply(env, cfg, row(tooOld.id));
check("emails older than 30 days aren't checked", r === null && gmailCalls().length === 0, r);

// ---- the scheduled sweep: within budget, fair between people ----
sqlite.exec("DELETE FROM emails; DELETE FROM alerts;");
msgs.clear();
const uid2 = await mkUser("other@gmail.com");
const many = [];
for (let i = 0; i < 10; i++) many.push(newEmail(uid, `p${i}@big.com`, "Hi " + i, (i + 1) * H));
const few = [newEmail(uid2, "x@small.com", "Hello", H), newEmail(uid2, "y@small.com", "Hello again", 2 * H)];
const noMsg = newEmail(uid, "nomsg@big.com", "Not in Sent yet", H, { msg: false });
const old = newEmail(uid, "old@big.com", "Too old", 31 * D);
const replied = newEmail(uid, "done@big.com", "Answered", H);
sqlite.prepare("UPDATE emails SET replied_at=? WHERE id=?").run(now() - 60, replied.id);
put("late", many[9].thread, "P Nine <p9@big.com>", now() - 30);
calls = [];
let checked = await R.sweepReplies(env, cfg);
const done1 = new Set(sqlite.prepare("SELECT id FROM emails WHERE reply_checked IS NOT NULL").all().map(x => x.id));
check("one run stays well under Cloudflare's 50-request limit", gmailCalls().length <= 12 && checked > 0, { n: gmailCalls().length, checked });
check("both people's emails get a turn in the same run", few.some(e => done1.has(e.id)) && many.some(e => done1.has(e.id)), [...done1]);
check("skips: not found in Sent, older than 30 days, already replied", !done1.has(noMsg.id) && !done1.has(old.id) && !done1.has(replied.id), [...done1]);
for (let i = 0; i < 4; i++) await R.sweepReplies(env, cfg);
const all = [...many, ...few];
check("a few runs cover every email (longest-unchecked first)", all.every(e => row(e.id).reply_checked), all.map(e => row(e.id).reply_checked));
check("the sweep finds replies and notifies", row(many[9].id).replied_by === "P Nine" && alerts(many[9].id).length === 1, row(many[9].id));
calls = [];
checked = await R.sweepReplies(env, cfg);
check("just-checked emails wait their turn (no requests)", checked === 0 && gmailCalls().length === 0, { checked, calls });

// ---- follow-up reminders ----
sqlite.exec("DELETE FROM emails; DELETE FROM alerts;");
const fu = id => sqlite.prepare("SELECT COUNT(*) n FROM alerts WHERE email_id=? AND kind='followup'").get(id).n;
const fWatched = newEmail(uid, "w@acme.com", "Watched", 50 * H);
const fReplied = newEmail(uid, "r@acme.com", "Replied, never opened", 50 * H);
sqlite.prepare("UPDATE emails SET replied_at=?, reply_checked=? WHERE id=?").run(now() - 3 * H, now() - 3 * H, fReplied.id);
const fNoGmail = newEmail(uid, "n@acme.com", "Not in Gmail", 50 * H, { msg: false });
const fOverdue = newEmail(uid, "o@acme.com", "Checks failing", 60 * H);
await T.runScheduled(db, cfg);
check("no reminder for an email that got a reply (even unopened)", fu(fReplied.id) === 0, alerts(fReplied.id));
check("due reminder waits for a reply check first", fu(fWatched.id) === 0, alerts(fWatched.id));
check("reply checks unavailable: reminder as before", fu(fNoGmail.id) === 1, alerts(fNoGmail.id));
check("checks failing for 6+ hours past due: reminder goes out anyway", fu(fOverdue.id) === 1, alerts(fOverdue.id));
await R.checkReply(env, cfg, fWatched.id);
await T.runScheduled(db, cfg);
check("checked, no reply: reminder goes out", fu(fWatched.id) === 1, alerts(fWatched.id));
await T.runScheduled(db, cfg);
check("only once", fu(fWatched.id) === 1 && fu(fReplied.id) === 0, "");

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
if (results.some(r => !r)) process.exit(1);
