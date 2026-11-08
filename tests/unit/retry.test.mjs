// Auto-try engine (cloudflare/src/retry.js) against a fake Gmail, on node:sqlite.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
const SRC = new URL("../../cloudflare/src/", import.meta.url).href;
const G = await import(SRC + "google.js");
const R = await import(SRC + "retry.js");

let results = [];
const check = (n, c, d) => { results.push(!!c); console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  [" + JSON.stringify(d) + "]")); };

function d1(sqlite) {
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
  });
  return { prepare: sql => stmt(sql), batch: async list => { for (const s of list) await s.run(); return []; } };
}
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(new URL("../../cloudflare/schema.sql", import.meta.url), "utf8"));
const db = d1(sqlite);
const kv = new Map();
const env = { DB: db, DOCS: { get: async (k, o) => { const v = kv.get(k); return v == null ? null : (o && o.type === "json" ? JSON.parse(v) : v); }, put: async (k, v) => { kv.set(k, String(v)); } } };
const cfg = { googleClientId: "cid", googleClientSecret: "cs", sessionSecret: "test-session-secret-abcdefghijklmnop" };
const now = () => Date.now() / 1000;

// ---- fake Gmail ----
// mailbox: id -> { id, threadId, from, to, subject, date, failed, snippet, raw, trashed, labels }
const box = new Map(); let nextId = 1;
const exists = new Set(["jdoe@acme.com", "real@solo.com"]);       // addresses that don't bounce
const delayOnly = new Set(["slow@acme.com"]);
function deliver(rawTo, subject, raw) {
  const id = "m" + nextId++, threadId = "t" + id;
  box.set(id, { id, threadId, from: "Me <me@gmail.com>", to: rawTo, subject, date: now(), raw });
  if (delayOnly.has(rawTo)) box.set("d" + id, { id: "d" + id, threadId, from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", subject: "Delivery Status Notification (Delay)", snippet: "Delivery incomplete. There was a temporary problem delivering your message to " + rawTo, date: now() });
  else if (!exists.has(rawTo)) box.set("b" + id, { id: "b" + id, threadId, from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", subject: "Delivery Status Notification (Failure)", failed: rawTo, snippet: "Address not found. Your message wasn't delivered to " + rawTo, date: now() });
  return id;
}
const sent = [];
const b64u = s => Buffer.from(s, "binary").toString("base64url");
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url), method = opts.method || "GET";
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
  if (u.host === "oauth2.googleapis.com") return J({ access_token: "at", expires_in: 3599 });
  const path = u.pathname.replace("/gmail/v1/users/me", "");
  const hdrs = m => [["From", m.from], ["Subject", m.subject], ...(m.failed ? [["X-Failed-Recipients", m.failed]] : [])].map(([name, value]) => ({ name, value }));
  const meta = m => ({ id: m.id, threadId: m.threadId, snippet: m.snippet || "", internalDate: String(Math.round(m.date * 1000)), payload: { headers: hdrs(m) } });
  if (path === "/messages" && method === "GET") {
    const q = u.searchParams.get("q");
    let list = [...box.values()].filter(m => !m.trashed);
    const to = (q.match(/to:(\S+)/) || [])[1];
    if (q.startsWith("in:sent")) list = list.filter(m => m.to === to);
    else if (q.includes("mailer-daemon")) { const addr = (q.match(/"([^"]+)"/) || [])[1]; list = list.filter(m => /mailer-daemon|postmaster/.test(m.from) && (m.snippet || "").includes(addr)); }
    return J({ messages: list.map(m => ({ id: m.id })) });
  }
  let m = path !== "/messages/send" && path.match(/^\/messages\/([^/]+)$/);
  if (m) {
    const msg = box.get(m[1]); if (!msg) return J({}, 404);
    if (u.searchParams.get("format") === "raw") return J({ id: msg.id, raw: b64u(msg.raw) });
    return J(meta(msg));
  }
  m = path.match(/^\/threads\/([^/]+)$/);
  if (m) return J({ id: m[1], messages: [...box.values()].filter(x => x.threadId === m[1]).map(meta) });
  m = path.match(/^\/messages\/([^/]+)\/trash$/);
  if (m) { const msg = box.get(m[1]); if (!msg) return J({}, 404); msg.trashed = true; return J({ id: msg.id }); }
  if (path === "/messages/send") {
    const raw = Buffer.from(JSON.parse(opts.body).raw, "base64url").toString("binary");
    sent.push(raw);
    const to = (raw.match(/^To: (.+)$/m) || [])[1].trim();
    const subject = (raw.match(/^Subject: (.+)$/m) || [])[1].trim();
    return J({ id: deliver(to, subject, raw) });
  }
  return J({ error: "unexpected " + method + " " + url }, 500);
};

// ---- setup: a user with Gmail connected ----
await G.ensureGoogleSchema(db);
const uid = Number(sqlite.prepare("INSERT INTO users(email,password_hash,api_key,is_admin,created_at) VALUES('me@gmail.com','x','k',1,1)").run().lastInsertRowid);
sqlite.prepare("UPDATE users SET gmail_token=? WHERE id=?").run(await G.sealToken(cfg.sessionSecret, "rt"), uid);
const RAW = (to, subject) => [
  "Received: by 2002:a05 with SMTP id x", "MIME-Version: 1.0", "Date: Fri, 7 Nov 2026 10:00:00 -0800",
  "Message-ID: <abc@mail.gmail.com>", `Subject: ${subject}`, "From: Me <me@gmail.com>", `To: ${to}`,
  'Content-Type: multipart/mixed; boundary="b1"', "", "--b1", "Content-Type: text/html; charset=UTF-8", "",
  '<div>Hi Jane <img src="https://go.aryanh.dev/img/TOKEN1.gif"></div>', "--b1",
  'Content-Type: application/pdf; name="cv.pdf"', "Content-Transfer-Encoding: base64", "", "JVBERi0xLjQKJcOkw7zDtsOfCg==", "--b1--", ""].join("\r\n");
function newEmail(to, subject, cands, name) {
  const id = Number(sqlite.prepare("INSERT INTO emails(token,to_addr,subject,created_at,user_id) VALUES(?,?,?,?,?)").run("tok" + Math.random(), to, subject, now(), uid).lastInsertRowid);
  deliver(to, subject, RAW(to, subject));
  return id;
}
const rj = id => JSON.parse(sqlite.prepare("SELECT retry_json FROM emails WHERE id=?").get(id).retry_json);
const age = (id, secs) => { const r = rj(id); r.at -= secs; sqlite.prepare("UPDATE emails SET retry_json=? WHERE id=?").run(JSON.stringify(r), id); };

// ---- plan validation ----
check("plan: needs 2+ addresses, first = recipient", R.cleanPlan({ to: "a@x.com", retry: { cands: ["a@x.com", "b@x.com"] } }) && !R.cleanPlan({ to: "a@x.com", retry: { cands: ["b@x.com", "a@x.com"] } }) && !R.cleanPlan({ to: "a@x.com", retry: { cands: ["a@x.com"] } }), "");
check("plan: capped at 5, junk dropped", R.cleanPlan({ to: "a@x.com", retry: { cands: ["a@x.com", "bad", "b@x.com", "c@x.com", "d@x.com", "e@x.com", "f@x.com"] } }).cands.length === 5, "");

// ---- 1. first guess bounces, second gets through ----
const e1 = newEmail("jane.doe@acme.com", "Coffee?");
await R.startRetry(db, e1, { cands: ["jane.doe@acme.com", "jdoe@acme.com", "jane@acme.com"], name: "Jane Doe" });
let st = await R.advanceRetry(env, cfg, e1);
check("bounce detected -> same email sent to the next guess", st.state === "watching" && st.current === "jdoe@acme.com" && st.step === 2 && sent.length === 1, st);
const raw = sent[0];
check("resent copy: new To, same body, attachment and tracking pixel", /^To: jdoe@acme\.com$/m.test(raw) && !/^To: jane\.doe/m.test(raw) && raw.includes("TOKEN1.gif") && raw.includes("JVBERi0xLjQK") && raw.includes("Subject: Coffee?"), raw.slice(0, 300));
check("resent copy: Gmail-only headers dropped", !/^Message-ID:/mi.test(raw) && !/^Received:/mi.test(raw) && !/^Date:/mi.test(raw), "");
const trashed = [...box.values()].filter(m => m.trashed).map(m => m.id);
check("failed copy and bounce notice moved to Trash", trashed.length === 2 && trashed.some(i => i.startsWith("b")), trashed);
check("email now points at the new address", sqlite.prepare("SELECT to_addr FROM emails WHERE id=?").get(e1).to_addr === "jdoe@acme.com", "");
check("bounced address remembered as bad", kv.get("find:addr:jane.doe@acme.com") === "bad", [...kv]);
st = await R.advanceRetry(env, cfg, e1);
check("no bounce yet: still watching", st.state === "watching", st);
age(e1, 130);
st = await R.advanceRetry(env, cfg, e1);
check("no bounce after 2 minutes: delivered", st.state === "delivered" && st.current === "jdoe@acme.com", st);
check("working address remembered, format learned", kv.get("find:addr:jdoe@acme.com") === "good" && JSON.parse(kv.get("find:learn:acme.com"))["{f}{last}"] === 1, [...kv]);
check("you get a notification", sqlite.prepare("SELECT message FROM alerts WHERE email_id=? AND kind='retry'").get(e1)?.message.startsWith("Delivered to jdoe@acme.com"), "");

// ---- 2. nothing works ----
const e2 = newEmail("x1@nowhere.com", "Hello");
await R.startRetry(db, e2, { cands: ["x1@nowhere.com", "x2@nowhere.com"], name: "X" });
await R.advanceRetry(env, cfg, e2);
st = await R.advanceRetry(env, cfg, e2);
check("all bounce: exhausted, notified, no more sends", st.state === "exhausted" && sqlite.prepare("SELECT COUNT(*) n FROM alerts WHERE email_id=?").get(e2).n === 1, st);

// ---- 3. a delay notice isn't a bounce ----
const e3 = newEmail("slow@acme.com", "Delayed");
await R.startRetry(db, e3, { cands: ["slow@acme.com", "s2@acme.com"], name: "S" });
st = await R.advanceRetry(env, cfg, e3);
check("'delivery incomplete' notice doesn't trigger a retry", st.state === "watching" && st.current === "slow@acme.com", st);

// ---- 4. first guess works straight away (or catch-all): nothing else is sent ----
const before = sent.length;
const e4 = newEmail("real@solo.com", "Hi");
await R.startRetry(db, e4, { cands: ["real@solo.com", "r@solo.com"], name: "Real Person" });
await R.advanceRetry(env, cfg, e4);
age(e4, 130);
st = await R.advanceRetry(env, cfg, e4);
check("no bounce on the first: delivered, nothing else sent, not 'learned' (could be catch-all)", st.state === "delivered" && sent.length === before && !kv.has("find:addr:real@solo.com"), st);

// ---- 5. a late bounce after 'delivered' carries on ----
const e5 = newEmail("late@acme.com", "Late");
await R.startRetry(db, e5, { cands: ["late@acme.com", "jdoe@acme.com"], name: "L" });
// make it look delivered first, then a bounce turns up
for (const m of box.values()) if (m.id.startsWith("b") && m.failed === "late@acme.com") m.hidden = true;
const hidden = [...box.entries()].filter(([, m]) => m.hidden); hidden.forEach(([k]) => box.delete(k));
await R.advanceRetry(env, cfg, e5);   // first check finds the sent copy (and its real send time)
age(e5, 130);
st = await R.advanceRetry(env, cfg, e5);
check("delivered (bounce not here yet)", st.state === "delivered", st);
hidden.forEach(([k, m]) => box.set(k, m));
const r5 = rj(e5); r5.checked = 0; sqlite.prepare("UPDATE emails SET retry_json=? WHERE id=?").run(JSON.stringify(r5), e5);
st = await R.advanceRetry(env, cfg, e5);
check("late bounce: moves on to the next guess", st.state === "watching" && st.current === "jdoe@acme.com", st);

// ---- 6. scheduled email waits ----
const e6 = Number(sqlite.prepare("INSERT INTO emails(token,to_addr,subject,created_at,user_id,scheduled_at) VALUES('tok6','a@b.com','Later',?,?,-1)").run(now(), uid).lastInsertRowid);
await R.startRetry(db, e6, { cands: ["a@b.com", "b@b.com"], name: "A" });
st = await R.advanceRetry(env, cfg, e6);
check("scheduled (time unknown): waits", st.state === "scheduled", st);

// ---- 7. sweep keeps going without the Gmail tab ----
const e7 = newEmail("zz@acme.com", "Swept");
await R.startRetry(db, e7, { cands: ["zz@acme.com", "jdoe@acme.com"], name: "Z" });
await R.sweepRetries(env, cfg);
check("scheduled sweep advances it too", rj(e7).i === 1, rj(e7));

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
if (results.some(r => !r)) process.exit(1);
