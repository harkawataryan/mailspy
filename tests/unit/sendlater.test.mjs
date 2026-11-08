// Send later by MailSpy (cloudflare/src/sendlater.js): queue Gmail drafts, edit
// their text through the API, and send them when due, against a fake Gmail.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
const SRC = new URL("../../cloudflare/src/", import.meta.url).href;
const SL = await import(SRC + "sendlater.js");
const G = await import(SRC + "google.js");

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
const env = { DB: db };
const cfg = { googleClientId: "cid", googleClientSecret: "cs", sessionSecret: "test-session-secret-abcdefghijklmnop" };
await G.ensureGoogleSchema(db);
sqlite.prepare("INSERT INTO users (id, email, password_hash, api_key, created_at) VALUES (1, 'me@gmail.com', 'x', 'k1', 0)").run();
sqlite.prepare("UPDATE users SET gmail_token=? WHERE id=1").run(await G.sealToken(cfg.sessionSecret, "refresh"));
const now = () => Math.floor(Date.now() / 1000);

// ---- a raw draft like Gmail's: mixed( alternative( plain (wrapped), html (QP) ), pdf )
const PDF = Buffer.from("%PDF-1.4 resume bytes ÿþ").toString("base64");
const html = `<div dir="ltr">Hi Jane,<br><br>I&#39;m Aryan. I wanted to reach out early to express interest in a Summer 2027 software engineering internship at Acme. I&#39;d love to work on infra.<br></div><img src="https://go.aryanh.dev/img/TOKEN123.gif" width="1" height="1">`;
const qp = s => s.replace(/=/g, "=3D").match(/.{1,70}/g).join("=\r\n");
const RAW = [
  "To: Jane <jane@acme.com>", "Subject: Stripe Intern interested in Acme (Summer 2027)", "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="MIX"', "", "--MIX",
  'Content-Type: multipart/alternative; boundary="ALT"', "", "--ALT",
  'Content-Type: text/plain; charset="UTF-8"', "", "Hi Jane,", "", "I'm Aryan. I wanted to reach out early to express interest in a Summer 2027 software",
  "engineering internship at Acme. I'd love to work on infra.", "", "--ALT",
  'Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: quoted-printable", "", qp(html), "", "--ALT--", "", "--MIX",
  'Content-Type: application/pdf; name="Aryan_Harkawat_Resume.pdf"', 'Content-Disposition: attachment; filename="Aryan_Harkawat_Resume.pdf"',
  "Content-Transfer-Encoding: base64", "", PDF, "--MIX--", ""].join("\r\n");

const ed = SL.editRaw(RAW, [["software engineering internship", "internship"], ["I'd love to work on infra.", "I'd love to work on infrastructure at Acme."]]);
check("edits both the plain-text (wrapped line) and HTML (QP, &#39;) parts", ed.hits === 4, ed.hits);
const decodeQp = s => s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const htmlOut = decodeQp(ed.raw.split('quoted-printable\r\n\r\n')[1].split("\r\n--ALT--")[0]);
check("HTML now says 'Summer 2027 internship', apostrophes kept as entities", htmlOut.includes("a Summer 2027 internship at Acme") && htmlOut.includes("I&#39;d love to work on infrastructure at Acme.") && !htmlOut.includes("software engineering"), htmlOut);
check("plain text updated too", /a Summer 2027 internship\s+at Acme/.test(ed.raw) && !/software\s+engineering internship/.test(ed.raw.split("--ALT")[1]), "");
check("tracking image untouched", htmlOut.includes('src="https://go.aryanh.dev/img/TOKEN123.gif"'), "");
check("attachment and headers byte for byte", ed.raw.includes("Content-Transfer-Encoding: base64\r\n\r\n" + PDF + "\r\n--MIX--") && ed.raw.startsWith("To: Jane <jane@acme.com>\r\nSubject: Stripe Intern interested in Acme (Summer 2027)"), "");
check("nothing to change: raw returned as is", SL.editRaw(RAW, [["not in there", "x"]]).raw === RAW, "");

// ---- fake Gmail
const b64u = s => Buffer.from(s, "binary").toString("base64url");
const drafts = new Map([
  ["d1", { to: "Jane <jane@acme.com>", raw: RAW }],
  ["d2", { to: "bob@beta.com", raw: RAW.replace("jane@acme.com", "bob@beta.com") }],
  ["d3", { to: "pat@gamma.com", raw: RAW }], ["d4", { to: "pat@gamma.com", raw: RAW }],   // two drafts to one address
]);
const calls = [];
let sendFails = null;   // (id) => Response | null
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
  if (u.host === "oauth2.googleapis.com") return J({ access_token: "at", expires_in: 3599 });
  const path = u.pathname.replace("/gmail/v1/users/me", "");
  calls.push((init.method || "GET") + " " + path);
  if (path === "/drafts" && (!init.method || init.method === "GET")) {
    const addr = u.searchParams.get("q").replace("to:", "");
    return J({ drafts: [...drafts].filter(([, d]) => d.to.includes(addr)).map(([id]) => ({ id })) });
  }
  if (path === "/drafts/send") {
    const { id } = JSON.parse(init.body);
    if (sendFails) { const r = sendFails(id); if (r) return r; }
    if (!drafts.has(id)) return J({}, 404);
    drafts.delete(id);
    return J({ id: "sent-" + id, threadId: "t" });
  }
  const m = path.match(/^\/drafts\/(\w+)$/);
  if (m) {
    const d = drafts.get(m[1]);
    if (!d) return J({}, 404);
    if (init.method === "PUT") { const b = JSON.parse(init.body); d.raw = Buffer.from(b.message.raw, "base64url").toString("binary"); return J({ id: m[1] }); }
    const fmt = u.searchParams.get("format");
    if (fmt === "raw") return J({ id: m[1], message: { id: "m" + m[1], threadId: "t" + m[1], raw: b64u(d.raw) } });
    return J({ id: m[1], message: { id: "m" + m[1], payload: { headers: [{ name: "To", value: d.to }, { name: "Subject", value: "Stripe Intern interested in Acme (Summer 2027)" }] } } });
  }
  return J({}, 404);
};

// ---- queue
const at = now() + 3600;
let q = await SL.queueDrafts(env, cfg, 1, ["jane@acme.com", "bob@beta.com", "pat@gamma.com", "nobody@x.com"], at);
check("queues the one draft to each address", q.queued === 2 && q.results[0].draft === "d1" && q.results[1].draft === "d2", q);
check("refuses an address with two drafts, and one with none", /2 drafts/.test(q.results[2].error) && /no draft/.test(q.results[3].error), q.results);
check("past time refused", /future/.test((await SL.queueDrafts(env, cfg, 1, ["jane@acme.com"], now() - 5)).error || ""), "");
check("queueing again doesn't duplicate", (await SL.queueDrafts(env, cfg, 1, ["jane@acme.com"], at)).queued === 1 && (await SL.listQueue(db, 1)).length === 2, "");

// ---- edit through the API
const e1 = await SL.editQueued(env, cfg, 1, [["software engineering internship", "internship"]]);
check("edits every queued draft through drafts.update", e1.results.every(r => r.changed === 2) && calls.filter(c => c.startsWith("PUT /drafts/")).length === 2, e1);
check("the stored draft has the new text and still has the PDF", drafts.get("d1").raw.includes("Summer 2027 internship") && drafts.get("d1").raw.includes(PDF), "");
const before = calls.length;
const e2 = await SL.editQueued(env, cfg, 1, [["software engineering internship", "internship"]]);
check("running the same edit again changes nothing (no update calls)", e2.results.every(r => r.changed === 0) && !calls.slice(before).some(c => c.startsWith("PUT")), e2);
check("non-ASCII replacements refused", /ASCII/.test((await SL.editQueued(env, cfg, 1, [["a", "π"]])).error || ""), "");

// ---- send
let s = await SL.sendDue(env, cfg, now());
check("nothing sent before its time", s.sent === 0 && drafts.has("d1") && drafts.has("d2"), s);
await SL.cancelQueued(db, 1, [(await SL.listQueue(db, 1)).find(r => r.to_addr === "bob@beta.com").id]);
s = await SL.sendDue(env, cfg, at + 1);
const rows = await SL.listQueue(db, 1);
check("due draft sent with drafts.send, marked sent", s.sent === 1 && !drafts.has("d1") && rows.find(r => r.to_addr === "jane@acme.com").state === "sent" && rows.find(r => r.to_addr === "jane@acme.com").sent_msg === "sent-d1", rows);
check("cancelled draft not sent, still in Drafts", drafts.has("d2") && rows.find(r => r.to_addr === "bob@beta.com").state === "cancelled", rows);
s = await SL.sendDue(env, cfg, at + 400);
check("a sent draft is never sent again", s.due === 0, s);

// failure that actually went out (draft gone): counted as sent, not retried
drafts.set("d5", { to: "lee@delta.com", raw: RAW });
await SL.queueDrafts(env, cfg, 1, ["lee@delta.com"], at);
sendFails = id => { drafts.delete(id); return new Response("boom", { status: 500 }); };
s = await SL.sendDue(env, cfg, at + 10);
check("send errored but the draft is gone: marked sent, no retry", (await SL.listQueue(db, 1)).find(r => r.to_addr === "lee@delta.com").state === "sent", await SL.listQueue(db, 1));

// failure that didn't go out: retried, then failed with an alert after 3 tries
drafts.set("d6", { to: "kim@eps.com", raw: RAW });
await SL.queueDrafts(env, cfg, 1, ["kim@eps.com"], at);
sendFails = () => new Response("rate limited", { status: 429 });
for (let i = 0; i < 3; i++) await SL.sendDue(env, cfg, at + 20 + i);
const kim = (await SL.listQueue(db, 1)).find(r => r.to_addr === "kim@eps.com");
const al = sqlite.prepare("SELECT message FROM alerts").all();
check("still in Drafts after 3 failed tries: failed, and you get an alert", kim.state === "failed" && drafts.has("d6") && al.some(a => /Couldn't send/.test(a.message)), [kim, al]);
sendFails = null;

// interrupted run: a stale "sending" claim
drafts.set("d7", { to: "max@zeta.com", raw: RAW });
await SL.queueDrafts(env, cfg, 1, ["max@zeta.com"], at);
sqlite.prepare("UPDATE send_queue SET state='sending', claimed_at=? WHERE draft_id='d7'").run(at - 1000);
await SL.sendDue(env, cfg, at + 30);
check("stale claim with the draft still there: sent this time", !drafts.has("d7") && (await SL.listQueue(db, 1)).find(r => r.draft_id === "d7").state === "sent", "");
drafts.set("d8", { to: "ann@eta.com", raw: RAW });
await SL.queueDrafts(env, cfg, 1, ["ann@eta.com"], at);
sqlite.prepare("UPDATE send_queue SET state='sending', claimed_at=? WHERE draft_id='d8'").run(at - 1000);
drafts.delete("d8");
const sendsBefore = calls.filter(c => c === "POST /drafts/send").length;
await SL.sendDue(env, cfg, at + 40);
check("stale claim whose draft is gone: marked sent without sending again", (await SL.listQueue(db, 1)).find(r => r.draft_id === "d8").state === "sent" && calls.filter(c => c === "POST /drafts/send").length === sendsBefore, "");

// ---- link tracking: unwrap Gmail's google.com/url redirect, then track the link
const GURL = "https://www.google.com/url?q=https://aryanh.dev&source=gmail&ust=1794093214714000&sa=E";
const lhtml = `<div>Hi Kai, my portfolio at <a href="${GURL.replace(/&/g, "&amp;")}" target="_blank">aryanh.dev</a> or <a href="mailto:x@y.com">mail</a>.</div><img src="https://go.aryanh.dev/img/LINKTOK1.gif" width="1" height="1">`;
const LRAW = RAW.replace(qp(html), qp(lhtml)).replace("I'd love to work on infra.", `my portfolio at aryanh.dev\r\n<${GURL}>)`).replace(/jane@acme\.com/g, "kai@links.com");
const lr = SL.linkRaw(LRAW, "https://go.aryanh.dev", u => "https://go.aryanh.dev/T_" + u.length);
const lh = decodeQp(lr.raw.split('quoted-printable\r\n\r\n')[1].split("\r\n--ALT--")[0]);
check("linkRaw: Google redirect unwrapped and tracked in HTML, mailto left", lr.token === "LINKTOK1" && lh.includes('href="https://go.aryanh.dev/T_18"') && lh.includes('href="mailto:x@y.com"') && !lh.includes("google.com"), lh);
check("linkRaw: plain text points at the tracked link too; pdf untouched", lr.raw.includes("<https://go.aryanh.dev/T_18>") && !lr.raw.includes("google.com/url") && lr.raw.includes(PDF), "");
check("linkRaw: running it again changes nothing", !SL.linkRaw(lr.raw, "https://go.aryanh.dev", u => "X").changed, "");
sqlite.prepare("INSERT INTO emails(token,to_addr,subject,created_at,user_id) VALUES('LINKTOK1','kai@links.com','s',0,1)").run();
drafts.set("d9", { to: "kai@links.com", raw: LRAW });
await SL.queueDrafts(env, cfg, 1, ["kai@links.com"], at + 9999);
let tl = await SL.trackQueuedLinks(env, cfg, 1, "https://go.aryanh.dev");
const kai = tl.results.find(r => r.to === "kai@links.com");
const lrow = sqlite.prepare("SELECT l.token, l.url FROM links l JOIN emails e ON e.id=l.email_id WHERE e.token='LINKTOK1'").all();
const d9 = drafts.get("d9").raw;
check("trackQueuedLinks: link recorded for this email, draft points at it", kai.links === 1 && lrow.length === 1 && lrow[0].url === "https://aryanh.dev" && decodeQp(d9).includes(`https://go.aryanh.dev/${lrow[0].token}`) && d9.includes(`<https://go.aryanh.dev/${lrow[0].token}>`), [kai, lrow]);
tl = await SL.trackQueuedLinks(env, cfg, 1, "https://go.aryanh.dev");
check("trackQueuedLinks again: no new links, draft not rewritten", tl.results.find(r => r.to === "kai@links.com").links === 0 && sqlite.prepare("SELECT COUNT(*) n FROM links").get().n === 1, tl);

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
if (results.some(r => !r)) process.exit(1);
