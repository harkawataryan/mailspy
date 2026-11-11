// Unit tests for cloudflare/src/google.js: a D1 look-alike on node:sqlite and a fake Google/Gmail.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const SRC = new URL("../../cloudflare/src/", import.meta.url).href;
const G = await import(SRC + "google.js");

let results = [];
const check = (n, c, d) => { results.push(!!c); console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  [" + JSON.stringify(d) + "]")); };

// ---- D1 shim ----
function d1(sqlite) {
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    _exec: () => sqlite.prepare(sql).run(...args),
  });
  return { prepare: sql => stmt(sql), batch: async list => { for (const s of list) await s.run(); return []; } };
}
const sqlite = new DatabaseSync(":memory:");
const schema = readFileSync(new URL("../../cloudflare/schema.sql", import.meta.url), "utf8");
sqlite.exec(schema);
const db = d1(sqlite);
const env = { DB: db };
const cfg = { googleClientId: "cid.apps.googleusercontent.com", googleClientSecret: "csecret", sessionSecret: "test-session-secret-abcdefghijklmnop" };

// ---- fake Google ----
const now = () => Date.now() / 1000;
const gm = { labels: [{ id: "INBOX", name: "INBOX" }], msgs: {}, calls: [], refreshOk: true, invalidGrant: false };
function b64u(o) { return Buffer.from(JSON.stringify(o)).toString("base64url"); }
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url), body = opts.body ? String(opts.body) : "";
  gm.calls.push(`${opts.method || "GET"} ${u.pathname}${u.search ? "?" + decodeURIComponent(u.search.slice(1)) : ""}`);
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
  if (u.host === "oauth2.googleapis.com" && u.pathname === "/token") {
    const p = new URLSearchParams(body);
    if (p.get("grant_type") === "authorization_code") {
      if (p.get("code") !== "good-code") return J({ error: "invalid_grant" }, 400);
      return J({ access_token: "at1", expires_in: 3599, refresh_token: "rt-secret-123", scope: "openid email profile " + G.GMAIL_SCOPE,
        id_token: "x." + b64u({ aud: cfg.googleClientId, email: "Jane@Example.com", email_verified: true, name: "Jane Doe", sub: "g-123" }) + ".y" });
    }
    if (gm.invalidGrant) return J({ error: "invalid_grant" }, 400);
    if (p.get("refresh_token") !== "rt-secret-123") return J({ error: "bad" }, 400);
    return J({ access_token: "at2", expires_in: 3599 });
  }
  if (u.host === "oauth2.googleapis.com" && u.pathname === "/revoke") return J({});
  if (u.host === "gmail.googleapis.com") {
    if ((opts.headers || {}).Authorization !== "Bearer at2") return J({ error: "auth" }, 401);
    const path = u.pathname.replace("/gmail/v1/users/me", "");
    if (path === "/labels" && (opts.method || "GET") === "GET") return J({ labels: gm.labels });
    if (path === "/labels" && opts.method === "POST") { const l = { id: "L" + gm.labels.length, name: JSON.parse(body).name }; gm.labels.push(l); return J(l); }
    if (path === "/messages") {
      const q = u.searchParams.get("q");
      const to = (q.match(/to:(\S+)/) || [])[1];
      return J({ messages: Object.values(gm.msgs).filter(m => !to || m.to === to).map(m => ({ id: m.id })) });
    }
    let m = path.match(/^\/messages\/([^/]+)$/);
    if (m) { const msg = gm.msgs[m[1]]; return msg ? J({ id: msg.id, internalDate: String(msg.date * 1000), payload: { headers: [{ name: "Subject", value: msg.subject }, { name: "To", value: `Someone <${msg.to}>` }],
      parts: [{ mimeType: "text/plain", body: { data: "eA" } }, { mimeType: "text/html", body: { data: Buffer.from(msg.html || "<p>hi</p>").toString("base64url") } }] } }) : J({}, 404); }
    m = path.match(/^\/messages\/([^/]+)\/modify$/);
    if (m) {
      const msg = gm.msgs[m[1]]; if (!msg) return J({}, 404);
      const b = JSON.parse(body);
      msg.labels = [...new Set([...(msg.labels || []).filter(x => !b.removeLabelIds.includes(x)), ...b.addLabelIds])];
      return J({ id: msg.id, threadId: "thr-" + msg.id });
    }
  }
  return J({ error: "unexpected " + url }, 500);
};

// ---- tests ----
const sealed = await G.sealToken(cfg.sessionSecret, "hello-token");
check("token sealing round-trips", (await G.openToken(cfg.sessionSecret, sealed)) === "hello-token" && !sealed.includes("hello"), sealed);
check("wrong secret can't open the token", (await G.openToken("other-secret-xxxxxxxxxxxxxxxxx", sealed)) === "", "");

const st = await G.makeState(cfg.sessionSecret, { mode: "signup", code: "abc" });
const back = await G.readState(cfg.sessionSecret, st);
check("state round-trips", back && back.mode === "signup" && back.code === "abc", back);
check("tampered state rejected", (await G.readState(cfg.sessionSecret, st.replace(/.$/, c => c === "A" ? "B" : "A"))) === null, "");

const url = new URL(G.authUrl(cfg, "https://mailspy.aryanh.dev", st, { consent: true }));
check("auth URL asks for Gmail labels permission, offline, with consent",
  url.searchParams.get("scope").includes(G.GMAIL_SCOPE) && url.searchParams.get("access_type") === "offline" &&
  url.searchParams.get("prompt") === "consent" && url.searchParams.get("redirect_uri") === "https://mailspy.aryanh.dev/auth/google/callback", url.search);

const bad = await G.exchangeCode(cfg, "https://mailspy.aryanh.dev", "bad-code");
check("bad code -> error", !!bad.error, bad);
const g = await G.exchangeCode(cfg, "https://mailspy.aryanh.dev", "good-code");
check("good code -> verified email, refresh token, Gmail granted", g.email === "jane@example.com" && g.refreshToken === "rt-secret-123" && g.gmail === true && g.sub === "g-123", g);

// a user + three tracked emails
await G.ensureGoogleSchema(db);
await G.ensureGoogleSchema(db);    // twice is fine
check("schema columns added (and re-running is harmless)", sqlite.prepare("SELECT gmail_token, gmail_label FROM users, emails LIMIT 0").all().length === 0, "");
const uid = Number(sqlite.prepare("INSERT INTO users(email,name,password_hash,api_key,is_admin,created_at) VALUES('jane@example.com','Jane','!google','k1',0,?)").run(now()).lastInsertRowid);
await G.saveGmail(db, cfg, uid, g);
const row = sqlite.prepare("SELECT gmail_token, gmail_email, google_sub FROM users WHERE id=?").get(uid);
check("refresh token stored encrypted", row.gmail_token && !row.gmail_token.includes("rt-secret") && row.gmail_email === "jane@example.com" && row.google_sub === "g-123", row);
check("status reports connected", (await G.gmailStatus(db, uid)).connected === true, "");

const t = now();
const mk = (to, subject, created, opens = 0, extra = "") => Number(sqlite.prepare(
  `INSERT INTO emails(token,to_addr,subject,created_at,opens,user_id${extra ? ",scheduled_at" : ""}) VALUES(?,?,?,?,?,?${extra ? ",?" : ""})`)
  .run(...[Math.random().toString(36).slice(2), to, subject, created, opens, uid, ...(extra ? [extra] : [])]).lastInsertRowid);
const e1 = mk("bob@x.com", "Hello Bob", t - 60);
const e2 = mk("amy@y.com", "Proposal", t - 120);
const e3 = mk("cat@z.com", "Lost one", t - 2 * 86400);           // never shows up in Sent
gm.msgs = {
  m1: { id: "m1", to: "bob@x.com", subject: "Hello Bob", date: t - 55 },
  m0: { id: "m0", to: "bob@x.com", subject: "Other email", date: t - 50 },
  m2: { id: "m2", to: "amy@y.com", subject: "Re: Proposal", date: t - 118 },
};

await G.labelEmail(env, cfg, e1);
const labels = Object.fromEntries(gm.labels.map(l => [l.name, l.id]));
check("✔ and ✔✔ labels created in Gmail", labels["\u2714"] && labels["\u2714\u2714"], gm.labels);
check("sent email gets ✔ on the right message", (gm.msgs.m1.labels || []).includes(labels["\u2714"]) && !(gm.msgs.m0.labels || []).length, gm.msgs);
check("message id and state remembered", sqlite.prepare("SELECT gmail_msg, gmail_label FROM emails WHERE id=?").get(e1).gmail_label === "sent", "");

// opened: ✔ -> ✔✔ without searching again
sqlite.prepare("UPDATE emails SET opens=1 WHERE id=?").run(e1);
gm.calls = [];
await G.labelEmail(env, cfg, e1);
check("open: ✔ replaced by ✔✔", gm.msgs.m1.labels.includes(labels["\u2714\u2714"]) && !gm.msgs.m1.labels.includes(labels["\u2714"]), gm.msgs.m1);
check("no search the second time (uses remembered message)", !gm.calls.some(c => c.includes("/messages?")), gm.calls);
gm.calls = [];
await G.labelEmail(env, cfg, e1);
check("already up to date: no Gmail calls", gm.calls.length === 0, gm.calls);

// sweep picks up the rest; Mailsuite's existing labels are reused
gm.labels = [{ id: "MS1", name: "\u2714" }, { id: "MS2", name: "\u2714\u2714" }];
sqlite.prepare("UPDATE users SET gmail_labels=NULL WHERE id=?").run(uid);
await G.sweepLabels(env, cfg);
check("sweep labels the reply-subject email ✔ using Mailsuite's existing label", (gm.msgs.m2.labels || []).includes("MS1") && gm.labels.length === 2, [gm.msgs.m2, gm.labels]);
check("old email not in Sent: marked nomatch, not retried", sqlite.prepare("SELECT gmail_label FROM emails WHERE id=?").get(e3).gmail_label === "nomatch", "");

// scheduled email in the future: left alone
const e4 = mk("dan@w.com", "Later", t, 0, t + 3600);
gm.calls = [];
await G.sweepLabels(env, cfg);
check("future scheduled email not touched", !gm.calls.some(c => c.includes("dan@w.com")), gm.calls);

// an inline reply tracked with no recipient or subject: matched by its tracking token
// (not just the send time), and To / Subject filled in from Gmail
const tokB = "TOKblank1234abcd";
const e6 = Number(sqlite.prepare("INSERT INTO emails(token,to_addr,subject,created_at,opens,user_id) VALUES(?,?,?,?,0,?)")
  .run(tokB, "", "(no subject)", t - 20, uid).lastInsertRowid);
gm.msgs.m6x = { id: "m6x", to: "nope@q.com", subject: "Unrelated", date: t - 19, html: "<p>other</p>" };
gm.msgs.m6 = { id: "m6", to: "bia@g.com", subject: "Re: Call scheduled", date: t - 18, html: `<p>Confirmed!</p><img src="https://go.x/o/${tokB}.gif">` };
await G.labelEmail(env, cfg, e6);
const r6 = sqlite.prepare("SELECT to_addr, subject, gmail_msg FROM emails WHERE id=?").get(e6);
check("blank-recipient email: found by token, To and Subject filled in", r6.gmail_msg === "m6" && r6.to_addr === "bia@g.com" && r6.subject === "Re: Call scheduled", r6);
const e7 = Number(sqlite.prepare("INSERT INTO emails(token,to_addr,subject,created_at,opens,user_id) VALUES(?,?,?,?,0,?)")
  .run("TOKmissing99999x", "", "(no subject)", t - 20, uid).lastInsertRowid);
await G.labelEmail(env, cfg, e7);
check("blank-recipient email with no token match: not tied to some other message", !sqlite.prepare("SELECT gmail_msg FROM emails WHERE id=?").get(e7).gmail_msg, "");
delete gm.msgs.m6; delete gm.msgs.m6x;

// access removed in Google: stop and say so
gm.invalidGrant = true;
const G2 = await import(SRC + "google.js?fresh=1");     // fresh module: empty access-token cache
const e5 = mk("eve@v.com", "Hi Eve", t - 30);
gm.msgs.m5 = { id: "m5", to: "eve@v.com", subject: "Hi Eve", date: t - 28 };
await G2.labelEmail(env, cfg, e5);
const st2 = await G2.gmailStatus(db, uid);
check("revoked access: disconnected with a clear message", st2.connected === false && /removed/.test(st2.error), st2);

// disconnect clears everything and revokes
gm.invalidGrant = false;
await G.saveGmail(db, cfg, uid, g);
gm.calls = [];
await G.disconnectGmail(db, cfg, uid);
check("disconnect revokes at Google and clears the token", gm.calls.some(c => c.startsWith("POST /revoke")) && !(await G.gmailStatus(db, uid)).connected, gm.calls);

// ✔ / ✔✔ for the Gmail tab: the conversation id is saved when labelling
const labelled = sqlite.prepare("SELECT gmail_msg, reply_thread FROM emails WHERE gmail_msg IS NOT NULL ORDER BY id LIMIT 1").get();
check("labelling saves the Gmail conversation id", labelled && labelled.reply_thread === "thr-" + labelled.gmail_msg, labelled);
const ck = (to, subj, opens, msg, thread, age = 10) => {
  const id = mk(to, subj, t - age, opens);
  sqlite.prepare("UPDATE emails SET gmail_msg=?, reply_thread=? WHERE id=?").run(msg, thread, id);
  return id;
};
ck("k1@a.com", "One", 0, "g1", "th1");
ck("k2@a.com", "Two", 2, "g2", "th1");             // same conversation, opened
ck("k3@a.com", "Three", 0, "g3", null);            // conversation not known yet
ck("k4@a.com", "Old", 1, "g4", "th4", 100 * 86400); // too old to matter
const marks = await G.checksFor(db, uid);
check("checks: a conversation with an opened email shows opened", marks.th1 && marks.th1.s === "opened" && marks.th1.n === 2, marks.th1);
check("checks: each message id has its own entry", marks.g1.s === "sent" && marks.g2.s === "opened" && marks.g2.n === 2, [marks.g1, marks.g2]);
check("checks: falls back to the sent message id", marks.g3 && marks.g3.s === "sent", marks.g3);
check("checks: emails older than 90 days left out", !marks.g4 && !marks.th4, Object.keys(marks));
const other = Number(sqlite.prepare("INSERT INTO users(email,name,password_hash,api_key,is_admin,created_at) VALUES('someone-else@x.com','S','!google','k2',0,?)").run(now()).lastInsertRowid);
check("checks: only your own emails", Object.keys(await G.checksFor(db, other)).length === 0, "");

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
if (results.some(r => !r)) process.exit(1);
