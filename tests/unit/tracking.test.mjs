// Opens: Apple Mail Privacy Protection, and "via Gmail" instead of a proxy's city (cloudflare/src/tracking.js, views.js).
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
const SRC = new URL("../../cloudflare/src/", import.meta.url).href;
const T = await import(SRC + "tracking.js");
const V = await import(SRC + "views.js");
const P = await import(SRC + "prefs.js");

let results = [];
const check = (n, c, d) => { results.push(!!c); console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  [" + JSON.stringify(d) + "]")); };

// node:sqlite doesn't bind numbered ?1 parameters from a plain list (D1 does): renumber them.
const plain = (sql, args) => {
  if (!/\?\d/.test(sql)) return [sql, args];
  const out = [];
  return [sql.replace(/\?(\d+)/g, (_, n) => { out.push(args[n - 1]); return "?"; }), out];
};
function d1(sqlite) {
  const stmt = (sql0, args0 = []) => { const [sql, args] = plain(sql0, args0); return {
    bind: (...a) => stmt(sql0, a),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
  }; };
  return { prepare: sql => stmt(sql), batch: async list => { for (const s of list) await s.run(); return []; } };
}
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(new URL("../../cloudflare/schema.sql", import.meta.url), "utf8"));
const db = d1(sqlite);
const cfg = { prefetchWindow: 12, spikeCount: 3, spikeWindow: 600, revivalDays: 7, followupHours: 48, ignoreIps: new Set() };
const now = () => Date.now() / 1000;

const UA = {
  apple: "Mozilla/5.0",
  appleMail: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  safari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  gmail: "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)",
  yahoo: "YahooMailProxy; https://help.yahoo.com/kb/yahoo-mail-proxy-SLN28749.html",
  chrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
  outlook: "Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0.17928; Pro)",
};
const req = (ua, ip = "203.0.113.9", cf = {}) => ({ headers: new Map([["User-Agent", ua], ["CF-Connecting-IP", ip]]), cf });

// ---- the rule ----
check("Apple proxy: bare 'Mozilla/5.0'", T.isAppleProxy(UA.apple) && T.isAppleProxy(" Mozilla/5.0 "), "");
check("Apple proxy: Apple Mail's WebKit UA from Apple's network (17/8, ASN 714, IPv6)",
  T.isAppleProxy(UA.appleMail, "17.58.101.4") && T.isAppleProxy(UA.appleMail, "198.51.100.2", 714) && T.isAppleProxy(UA.appleMail, "2620:149:a44::10"), "");
check("not Apple proxy: Apple Mail from a home IP, Safari from 17/8, Gmail, Chrome",
  !T.isAppleProxy(UA.appleMail, "203.0.113.9") && !T.isAppleProxy(UA.safari, "17.1.2.3") && !T.isAppleProxy(UA.gmail) && !T.isAppleProxy(UA.chrome) && !T.isAppleProxy(""), "");
check("not Apple proxy: 170.x isn't 17.x", !T.isAppleProxy(UA.appleMail, "170.1.2.3"), "");

// ---- where it happened ----
check("placeOf: Gmail proxy -> via Gmail", T.placeOf({ kind: "open", user_agent: UA.gmail, geo: "Mountain View, US" }) === "via Gmail", "");
check("placeOf: Yahoo proxy -> via Yahoo", T.placeOf({ kind: "open", user_agent: UA.yahoo, geo: "Sunnyvale, US" }) === "via Yahoo", "");
check("placeOf: Apple -> via Apple Mail (flag or bare UA)", T.placeOf({ kind: "open", user_agent: UA.appleMail, geo: "Cupertino, US", flagged: "apple" }) === "via Apple Mail"
  && T.placeOf({ kind: "open", user_agent: UA.apple, geo: "Cupertino, US" }) === "via Apple Mail", "");
check("placeOf: direct opens and clicks keep their city", T.placeOf({ kind: "open", user_agent: UA.chrome, geo: "Berlin, DE" }) === "Berlin, DE"
  && T.placeOf({ kind: "open", user_agent: UA.outlook, geo: "Leeds, GB" }) === "Leeds, GB"
  && T.placeOf({ kind: "click", user_agent: UA.chrome, geo: "Paris, FR" }) === "Paris, FR", "");
check("placeOf: PDF views keep their city", T.placeOf({ kind: "doc", user_agent: UA.apple, geo: "Oslo, NO" }) === "Oslo, NO", "");
check("client column: bare Mozilla/5.0 is Apple Mail", T.classifyAgent(UA.apple) === "Apple Mail" && T.classifyAgent(UA.gmail) === "Gmail", "");

// ---- recording ----
const uid = Number(sqlite.prepare("INSERT INTO users(email,password_hash,api_key,is_admin,created_at) VALUES('me@x.com','x','k',1,1)").run().lastInsertRowid);
function mk(subject, ago = 120) {
  const token = "tok" + Math.random().toString(36).slice(2, 10);
  const id = Number(sqlite.prepare("INSERT INTO emails(token,to_addr,to_name,subject,created_at,user_id) VALUES(?,?,?,?,?,?)").run(token, "jane@acme.com", "Jane", subject, now() - ago, uid).lastInsertRowid);
  return sqlite.prepare("SELECT id,to_addr,to_name,subject,created_at,scheduled_at,user_id FROM emails WHERE id=?").get(id);
}
const em = id => sqlite.prepare("SELECT * FROM emails WHERE id=?").get(id);
const alerts = id => sqlite.prepare("SELECT kind, message FROM alerts WHERE email_id=? ORDER BY id").all(id);
const events = id => sqlite.prepare("SELECT * FROM events WHERE email_id=? ORDER BY id").all(id);

const a = mk("Apple one");
await T.recordEvent(db, cfg, req(UA.apple, "172.225.10.1", { city: "Cupertino", country: "US" }), a, "open");
let ev = events(a.id)[0];
check("Apple fetch: recorded as 'apple', not counted, no notification", ev.flagged === "apple" && ev.is_bot === 1 && em(a.id).opens === 0 && alerts(a.id).length === 0, [ev, em(a.id).opens, alerts(a.id)]);
await new Promise(r => setTimeout(r, 5));
await T.recordEvent(db, cfg, req(UA.appleMail, "17.58.3.3"), a, "open");
check("Apple network fetch: also 'apple'", events(a.id)[1].flagged === "apple" && em(a.id).opens === 0, events(a.id)[1]);
await T.recordEvent(db, cfg, req(UA.chrome, "203.0.113.50", { city: "Berlin", country: "DE" }), a, "click", 1);
check("a click after an Apple fetch still counts and notifies", em(a.id).clicks === 1 && alerts(a.id).some(x => x.kind === "click"), alerts(a.id));
await T.recordEvent(db, cfg, req(UA.gmail, "66.249.84.1", { city: "Mountain View", country: "US" }), a, "open");
const al = alerts(a.id).filter(x => x.kind === "open");
check("a non-Apple open counts: 'opened ... via Gmail', no Mountain View", em(a.id).opens === 1 && al.length === 1 && al[0].message === 'Jane opened "Apple one" via Gmail', al);

const b = mk("Direct one");
await T.recordEvent(db, cfg, req(UA.outlook, "198.51.100.7", { city: "Leeds", country: "GB" }), b, "open");
check("direct open: alert keeps the real place", alerts(b.id)[0].message === 'Jane opened "Direct one" from Leeds, GB', alerts(b.id));

const c = mk("Just sent", 3);
await T.recordEvent(db, cfg, req(UA.apple), c, "open");
check("inside the prefetch window: still 'prefetch'", events(c.id)[0].flagged === "prefetch", events(c.id)[0]);

// ---- your own Gmail loading the image (compose window re-rendering) ----
const reqRef = (ua, referer) => ({ headers: new Map([["User-Agent", ua], ["CF-Connecting-IP", "24.28.109.0"], ["Referer", referer]]), cf: { city: "Austin", country: "US" } });
const d = mk("Compose redraw", 30);
await T.recordEvent(db, cfg, reqRef(UA.chrome, "https://mail.google.com/"), d, "open");
check("open loaded by a Gmail page directly: 'self', not counted, no alert", events(d.id)[0].flagged === "self" && em(d.id).opens === 0 && alerts(d.id).length === 0, [events(d.id)[0], alerts(d.id)]);
await T.recordEvent(db, cfg, reqRef(UA.gmail, "https://mail.google.com/"), d, "open");
check("Gmail's image proxy still counts (that's the recipient)", em(d.id).opens === 1, em(d.id));
await T.recordEvent(db, cfg, reqRef(UA.chrome, "https://outlook.live.com/"), mk("Outlook web", 30), "open");
check("other webmail referers aren't treated as you", T.fromOwnGmail(reqRef(UA.chrome, "https://outlook.live.com/")) === false
  && T.fromOwnGmail(reqRef(UA.chrome, "https://mail.google.com.evil.example/")) === false && T.fromOwnGmail(req(UA.chrome)) === false, "");
const dc = mk("Click from Gmail", 30);
await T.recordEvent(db, cfg, reqRef(UA.chrome, "https://mail.google.com/"), dc, "click", 1);
check("a click from Gmail still counts (recipients click from Gmail too)", em(dc.id).clicks === 1, em(dc.id));

// ---- scheduling clears anything recorded before the send ----
const s = mk("Scheduled later", 20);
await T.recordEvent(db, cfg, req(UA.chrome, "203.0.113.77", { city: "Austin", country: "US" }), s, "open");
check("(setup) an open recorded before scheduling", em(s.id).opens === 1 && alerts(s.id).length === 1, em(s.id));
const sched = Math.floor(now()) + 86400;
check("markScheduled finds the email", await T.markScheduled(db, uid, s.token || em(s.id).token, sched), "");
check("scheduling: earlier opens become 'self', count and alert gone", em(s.id).opens === 0 && em(s.id).first_open === null && alerts(s.id).length === 0
  && events(s.id)[0].flagged === "self" && em(s.id).scheduled_at === sched, [em(s.id), alerts(s.id)]);
await T.recordEvent(db, cfg, req(UA.chrome, "203.0.113.78"), em(s.id), "open");
check("open before the scheduled time: not counted", em(s.id).opens === 0 && alerts(s.id).length === 0, events(s.id));

// ---- a saved draft reopened: Gmail loads the image through its proxy ----
const dr = mk("Draft reopened", 600);
await T.recordEvent(db, cfg, req(UA.gmail, "66.249.84.9"), dr, "open");
check("(setup) proxy load of a reopened draft looks like an open", em(dr.id).opens === 1 && alerts(dr.id).length === 1, em(dr.id));
const fresh = sqlite.prepare("SELECT * FROM alerts WHERE email_id=?").all(dr.id);
check("a brand-new alert is held back from the extension", T.settledAlerts(fresh).length === 0, fresh);
check("...and released once it has settled", T.settledAlerts(fresh, now() + T.ALERT_SETTLE + 1).length === 1, "");
await T.markSelfView(db, uid, em(dr.id).token);
check("the extension's 'that's me' a moment later removes the open and its alert", em(dr.id).opens === 0 && alerts(dr.id).length === 0
  && events(dr.id)[0].flagged === "self", [em(dr.id), alerts(dr.id)]);
await T.recordEvent(db, cfg, req(UA.gmail, "66.249.84.9"), em(dr.id), "open");
check("an open right after 'that's me' (draft still open) isn't counted", em(dr.id).opens === 0 && alerts(dr.id).length === 0, events(dr.id));
const t0 = now();
const rowsAt = [{ id: 1, ts: t0 - 60 }, { id: 2, ts: t0 - 2 }, { id: 3, ts: t0 - 60 }];
check("settling stops at the first young alert, so the cursor never skips one", JSON.stringify(T.settledAlerts(rowsAt, t0).map(a => a.id)) === "[1]", "");

// ---- which Gmail account an email is sent from ----
const me = { email: "Login@Example.com" };
const pAcc = P.normalizePrefs(cfg, { track_accounts: ["Me@School.edu", "not an email"] });
check("tracked: the connected Gmail, the login email, and listed accounts (case-insensitive)",
  P.accountAllowed("aryan@gmail.com", pAcc, me, "Aryan@gmail.com") && P.accountAllowed("login@example.com", pAcc, me, "aryan@gmail.com")
  && P.accountAllowed("me@school.edu", pAcc, me, "aryan@gmail.com"), P.trackedAccounts(pAcc, me, "aryan@gmail.com"));
check("someone else's Gmail in the same Chrome: not tracked", !P.accountAllowed("roommate@gmail.com", pAcc, me, "aryan@gmail.com"), "");
check("unknown account (older extension): still tracked", P.accountAllowed("", pAcc, me, "aryan@gmail.com"), "");
check("bad entries dropped from the list", pAcc.track_accounts.length === 1, pAcc.track_accounts);
check("settings form keeps the list", P.prefsFromForm(cfg, { track_accounts: "a@b.com\nc@d.org" }).track_accounts.length === 2, "");

// ---- pages ----
const user = { id: uid, email: "me@x.com", name: "Me", is_admin: 1 };
const prefs = P.defaultPrefs(cfg);
const evRows = sqlite.prepare("SELECT v.*, NULL AS url FROM events v WHERE email_id=? ORDER BY ts DESC").all(a.id);
const page = V.emailPage({ user, prefs, email: em(a.id), links: [], events: evRows, maxAlert: 0, base: "https://x" });
check("email page: 'via Gmail', no proxy city", page.includes("via Gmail") && !page.includes("Mountain View") && !page.includes("Cupertino"), "");
check("email page: Apple rows shown as 'Apple Mail, may be automatic'", page.includes("Apple Mail, may be automatic") && /2 Apple Mail fetches/.test(page), "");
check("email page: real click location kept", page.includes("Berlin, DE"), "");
const hidden = V.emailPage({ user, prefs: { ...prefs, show_automated: false }, email: em(a.id), links: [], events: evRows, maxAlert: 0, base: "https://x" });
check("email page with automated hits hidden: Apple rows still shown", hidden.includes("Apple Mail, may be automatic"), "");
const act = sqlite.prepare(`SELECT v.id, v.kind, v.ts, v.geo, v.user_agent, v.is_bot, v.flagged, e.id AS email_id, e.to_addr, e.to_name, e.subject
  FROM events v JOIN emails e ON e.id=v.email_id ORDER BY v.ts DESC`).all();
const dash = V.dashboard({ user, cfg, prefs, emails: [em(a.id), em(b.id)], totals: { total: 2 },
  followups: [{ id: b.id, to_addr: "jane@acme.com", to_name: "Jane", subject: "Direct one", opens: 3, last_open: now() - 600, sent_at: now() - 3 * 86400 }],
  reminders: [], maxAlert: 0, week: {} });
check("dashboard: follow-up panel instead of the activity feed", dash.includes("Worth a follow-up") && dash.includes("opened 3 times") && dash.includes("sent 3d ago, no reply") && !dash.includes("<h2>Activity</h2>"), "");
check("dashboard: last activity column and sort menu", dash.includes("Last activity") && dash.includes('name="sort"') && dash.includes("Latest activity") && dash.includes("Most opens"), "");

// ---- the setting ----
check("'Hide tracking from my own Sent copy' is on by default", P.defaultPrefs(cfg).hide_sent_pixel === true && P.readPrefs(cfg, "{}").hide_sent_pixel === true, "");
check("settings form: unticked turns it off, ticked on", P.prefsFromForm(cfg, {}).hide_sent_pixel === false && P.prefsFromForm(cfg, { hide_sent_pixel: "on" }).hide_sent_pixel === true, "");
const sp = V.settingsPage({ cfg, base: "https://x", user, prefs, gmail: { enabled: true, connected: true, email: "me@x.com" } });
check("settings: toggle in Gmail checkmarks, tied to the settings form", /<input type="checkbox" name="hide_sent_pixel" form="prefsForm" checked>Hide tracking from my own Sent copy/.test(sp)
  && sp.indexOf("Hide tracking from my own Sent copy") > sp.indexOf("Gmail checkmarks") && sp.indexOf("Hide tracking from my own Sent copy") < sp.indexOf('id="prefsForm"'), "");
const sp2 = V.settingsPage({ cfg, base: "https://x", user, prefs, gmail: { enabled: true, connected: false } });
check("settings without Gmail: value kept in a hidden field", sp2.includes('<input type="hidden" name="hide_sent_pixel" value="on">') && !sp2.includes("Hide tracking from my own Sent copy</label>"), "");
check("privacy policy explains the Sent-copy swap", V.privacyPage({}, "https://x").includes("Hide tracking from my own Sent copy") && V.privacyPage({}, "https://x").includes("moves the original to Trash"), "");

// Earlier emails quoted in a later reply: their images load with it, not counted
{
  const q1 = mk("Exam 2 Missed", 86400 * 2);
  const q2 = mk("Re: Exam 2 Missed", 86400);
  const q3 = mk("RE: exam 2 missed", 600);              // the new reply quoting both
  const other = mk("Something else", 86400);
  const gmailReq = () => req(UA.gmail, "66.102.7." + Math.floor(Math.random() * 200), { city: "Mountain View", country: "US" });
  // old images arrive first, then the reply's own
  await T.recordEvent(db, cfg, gmailReq(), q1, "open");
  await T.recordEvent(db, cfg, gmailReq(), q2, "open");
  await T.recordEvent(db, cfg, gmailReq(), other, "open");
  await T.recordEvent(db, cfg, gmailReq(), q3, "open");
  check("quoted: earlier emails' opens re-flagged once the reply's image loads",
    events(q1.id).every(e => e.flagged === "quoted") && events(q2.id).every(e => e.flagged === "quoted") && em(q1.id).opens === 0 && em(q2.id).opens === 0,
    [events(q1.id), events(q2.id)]);
  check("quoted: their alerts removed", alerts(q1.id).length === 0 && alerts(q2.id).length === 0, [alerts(q1.id), alerts(q2.id)]);
  check("quoted: the reply itself counts", em(q3.id).opens === 1 && alerts(q3.id).length === 1, em(q3.id));
  check("quoted: a different conversation is untouched", em(other.id).opens === 1, events(other.id));
  // reply's image first, then an old one
  await new Promise(r => setTimeout(r, 2100));
  await T.recordEvent(db, cfg, gmailReq(), q3, "open");
  await T.recordEvent(db, cfg, gmailReq(), q2, "open");
  check("quoted: earlier email loading just after the reply is not counted", em(q2.id).opens === 0 && events(q2.id).at(-1).flagged === "quoted", events(q2.id));
  // on its own, a minute later, an earlier email still counts
  sqlite.prepare("UPDATE events SET ts = ts - 60 WHERE email_id IN (?,?,?)").run(q1.id, q2.id, q3.id);
  await T.recordEvent(db, cfg, gmailReq(), q1, "open");
  check("quoted: earlier email opened on its own still counts", em(q1.id).opens === 1, events(q1.id));
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
if (results.some(r => !r)) process.exit(1);
