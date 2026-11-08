// "Hide tracking from my own Sent copy" (cloudflare/src/sentcopy.js) against a fake Gmail, on node:sqlite.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
const SRC = new URL("../../cloudflare/src/", import.meta.url).href;
const G = await import(SRC + "google.js");
const S = await import(SRC + "sentcopy.js");
const R = await import(SRC + "retry.js");

// The failure cases below log on purpose; keep the output readable.
const logged = [];
console.error = (...a) => logged.push(a.map(String).join(" "));

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
const env = { DB: db, DOCS: { get: async () => null, put: async () => {} } };
const cfg = { googleClientId: "cid", googleClientSecret: "cs", sessionSecret: "test-session-secret-abcdefghijklmnop",
  trackUrl: "https://go.aryanh.dev", baseUrl: "https://mailspy.aryanh.dev" };
const now = () => Date.now() / 1000;

// ---- a realistic Gmail Sent message: QP HTML (pixel split by a soft line break), plain text, a PDF ----
const PDF_B64 = "JVBERi0xLjQKJcOkw7zDtsOfCjEgMCBvYmoKPDwvVHlwZS9DYXRhbG9nPj4KZW5kb2JqCg==";
function rawMsg(token, { to = "jane@acme.com", subject = "Coffee?", html = "qp", extra = "" } = {}) {
  const t1 = token.slice(0, 5), t2 = token.slice(5);
  const qp = [
    `<div dir=3D"ltr">Hi Jane, caf=C3=A9 tomorrow? <a href=3D"https://go.aryanh.dev/Ab=`,
    `c1234">my site</a><img src=3D"https://example.com/logo.png" alt=3D"logo">${extra}<img src=3D"https://go=`,
    `.aryanh.dev/img/${t1}=`,
    `${t2}.gif" width=3D"1" height=3D"1" alt=3D"" style=3D"display:block;width:1px;h=`,
    `eight:1px;border:0;opacity:0"></div>`,
  ].join("\r\n");
  const htmlPlain = `<div dir="ltr">Hi Jane, cafÃ© tomorrow? <a href="https://go.aryanh.dev/Abc1234">my site</a>${extra.replace(/=3D/g, "=")}<img src="https://go.aryanh.dev/img/${token}.gif" width="1" height="1" alt=""></div>`;
  const htmlPart = html === "qp" ? ["Content-Type: text/html; charset=\"UTF-8\"", "Content-Transfer-Encoding: quoted-printable", "", qp]
    : html === "b64" ? ["Content-Type: text/html; charset=\"UTF-8\"", "Content-Transfer-Encoding: base64", "", btoa(htmlPlain).match(/.{1,76}/g).join("\r\n")]
    : ["Content-Type: text/html; charset=\"UTF-8\"", "", htmlPlain];
  return [
    "MIME-Version: 1.0", "Date: Fri, 6 Nov 2026 10:00:00 -0800", "Message-ID: <CAF+abc123@mail.gmail.com>",
    `Subject: ${subject}`, "From: Me <me@gmail.com>", `To: ${to}`,
    'Content-Type: multipart/mixed; boundary="000000000000mixed"', "",
    "--000000000000mixed", 'Content-Type: multipart/alternative; boundary="000000000000alt"', "",
    "--000000000000alt", 'Content-Type: text/plain; charset="UTF-8"', "", "Hi Jane, cafÃ© tomorrow?", "",
    "--000000000000alt", ...htmlPart, "--000000000000alt--",
    "--000000000000mixed", 'Content-Type: application/pdf; name="cv.pdf"', 'Content-Disposition: attachment; filename="cv.pdf"',
    "Content-Transfer-Encoding: base64", "", PDF_B64, "--000000000000mixed--", ""].join("\r\n");
}
const qpDecode = s => s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
const htmlOf = raw => qpDecode(raw.split("Content-Transfer-Encoding: quoted-printable\r\n\r\n")[1].split("\r\n--000000000000alt--")[0]);

// ---- stripPixels on its own ----
{
  const tok = "AbCdEfGhIjKlMnOp";
  const raw = rawMsg(tok);
  const r = S.stripPixels(raw, tok, S.hostsOf(cfg));
  const html = htmlOf(r.raw);
  check("QP html: pixel (split across a soft line break) removed", r.mine && r.removed === 1 && !html.includes(tok) && !html.includes("/img/"), html);
  check("QP html: everything else kept (link, other image, accents)", html.includes('href="https://go.aryanh.dev/Abc1234"') && html.includes('src="https://example.com/logo.png"') && html.includes("cafÃ©"), html);
  check("QP output: lines ≤ 76, = encoded", r.raw.split("\r\n").every(l => l.length <= 76) && /dir=3D"ltr"/.test(r.raw), "");
  const head = raw.slice(0, raw.indexOf("\r\n\r\n"));
  check("headers byte for byte (Message-ID, Subject, Date)", r.raw.startsWith(head + "\r\n\r\n"), "");
  check("attachment and plain-text part untouched", r.raw.includes('Content-Disposition: attachment; filename="cv.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n' + PDF_B64 + "\r\n--000000000000mixed--")
    && r.raw.includes('charset="UTF-8"\r\n\r\nHi Jane, cafÃ© tomorrow?\r\n\r\n--000000000000alt'), "");

  const b = S.stripPixels(rawMsg(tok, { html: "b64" }), tok);
  const b64 = b.raw.split("Content-Transfer-Encoding: base64\r\n\r\n")[1].split("\r\n--")[0];
  const bh = atob(b64.replace(/\r\n/g, ""));
  check("base64 html: pixel removed, rest kept, re-wrapped", b.mine && !bh.includes(tok) && bh.includes("my site") && b64.split("\r\n").every(l => l.length <= 76), bh);

  const p = S.stripPixels(rawMsg(tok, { html: "plain" }), tok);
  check("7bit html: pixel removed", p.mine && !p.raw.includes(`/img/${tok}`), "");

  const other = S.stripPixels(rawMsg(tok, { extra: `<img src=3D"https://go.aryanh.dev/t/OLDtoken12345.gif">` }), tok, S.hostsOf(cfg));
  check("an earlier email's pixel (quoted, older /t/ form) on our address goes too", other.removed === 2 && !htmlOf(other.raw).includes("OLDtoken12345"), htmlOf(other.raw));
  const notMine = S.stripPixels(rawMsg("ZZZZZZZZZZZZZZZZ"), tok, S.hostsOf(cfg));
  check("someone else's message: 'mine' false", !notMine.mine, notMine);

  const att = ["Content-Type: multipart/mixed; boundary=b", "", "--b", "Content-Type: text/html", "Content-Disposition: attachment; filename=page.html", "",
    `<img src="https://go.aryanh.dev/img/${tok}.gif">`, "--b--", ""].join("\r\n");
  check("attached .html file left alone", S.stripPixels(att, tok, S.hostsOf(cfg)).raw === att, "");
  const lf = rawMsg(tok, { html: "plain" }).replace(/\r\n/g, "\n");
  const l = S.stripPixels(lf, tok);
  check("LF-only message handled", l.mine && !l.raw.includes(`/img/${tok}`) && !l.raw.includes("\r"), "");
}

// ---- fake Gmail ----
// box: id -> { id, threadId, labelIds, raw, date }
const box = new Map(); let nextId = 1;
const calls = [];
const fail = { insert: false, trash: new Set(), thread: null };
const b64u = s => Buffer.from(s, "binary").toString("base64url");
const unb64u = s => Buffer.from(s, "base64url").toString("binary");
function put(raw, labelIds = ["SENT"], threadId) {
  const id = "m" + nextId++;
  box.set(id, { id, threadId: threadId || "t" + id, labelIds: [...labelIds], raw, date: now() });
  return id;
}
const labels = [{ id: "SENT", name: "SENT" }];
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url), method = opts.method || "GET";
  calls.push(`${method} ${u.pathname.replace("/gmail/v1/users/me", "")}${u.search}`);
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
  if (u.host === "oauth2.googleapis.com") return J({ access_token: "at", expires_in: 3599 });
  const path = u.pathname.replace("/gmail/v1/users/me", "");
  const hdr = (m, n) => ((m.raw || "").match(new RegExp(`^${n}: (.*)$`, "mi")) || [])[1] || "";
  if (path === "/labels" && method === "GET") return J({ labels });
  if (path === "/labels" && method === "POST") { const l = { id: "L" + labels.length, name: JSON.parse(opts.body).name }; labels.push(l); return J(l); }
  if (path === "/messages" && method === "POST") {                          // messages.insert
    if (fail.insert) return J({ error: "boom" }, 500);
    const b = JSON.parse(opts.body);
    const id = put(unb64u(b.raw), b.labelIds, fail.thread || b.threadId);
    box.get(id).insertQuery = u.search;
    return J({ id, threadId: box.get(id).threadId, labelIds: b.labelIds });
  }
  if (path === "/messages/send") {
    const raw = unb64u(JSON.parse(opts.body).raw);
    return J({ id: put(raw, ["SENT"]) });
  }
  let m = path.match(/^\/messages\/([^/]+)$/);
  if (m) {
    const msg = box.get(m[1]); if (!msg) return J({ error: "nf" }, 404);
    const f = u.searchParams.get("format");
    if (f === "raw") return J({ id: msg.id, threadId: msg.threadId, raw: b64u(msg.raw) });
    return J({ id: msg.id, threadId: msg.threadId, labelIds: msg.labelIds, sizeEstimate: msg.size || msg.raw.length,
      internalDate: String(Math.round(msg.date * 1000)), snippet: msg.snippet || "",
      payload: { headers: [["From", msg.from || hdr(msg, "From")], ["Subject", hdr(msg, "Subject")], ...(msg.failed ? [["X-Failed-Recipients", msg.failed]] : [])].map(([name, value]) => ({ name, value })) } });
  }
  m = path.match(/^\/messages\/([^/]+)\/trash$/);
  if (m) {
    if (fail.trash.has(m[1])) return J({ error: "nope" }, 500);
    const msg = box.get(m[1]); if (!msg) return J({}, 404);
    msg.labelIds = [...msg.labelIds.filter(l => l !== "SENT" && l !== "INBOX"), "TRASH"]; msg.trashed = true;
    return J({ id: msg.id });
  }
  m = path.match(/^\/messages\/([^/]+)\/modify$/);
  if (m) {
    const msg = box.get(m[1]); if (!msg) return J({}, 404);
    const b = JSON.parse(opts.body);
    msg.labelIds = [...new Set([...msg.labelIds.filter(x => !b.removeLabelIds.includes(x)), ...b.addLabelIds])];
    return J({ id: msg.id });
  }
  m = path.match(/^\/threads\/([^/]+)$/);
  if (m) return J({ id: m[1], messages: [...box.values()].filter(x => x.threadId === m[1]).map(x => ({ id: x.id, threadId: x.threadId, snippet: x.snippet || "",
    payload: { headers: [["From", x.from || hdr(x, "From")], ["Subject", hdr(x, "Subject")], ...(x.failed ? [["X-Failed-Recipients", x.failed]] : [])].map(([name, value]) => ({ name, value })) } })) });
  if (path === "/messages" && method === "GET") return J({ messages: [] });
  return J({ error: "unexpected " + method + " " + url }, 500);
};

// ---- a user with Gmail connected ----
await G.ensureGoogleSchema(db);
const uid = Number(sqlite.prepare("INSERT INTO users(email,password_hash,api_key,is_admin,created_at) VALUES('me@gmail.com','x','k',1,1)").run().lastInsertRowid);
sqlite.prepare("UPDATE users SET gmail_token=? WHERE id=?").run(await G.sealToken(cfg.sessionSecret, "rt"), uid);
let n = 0;
function tracked({ retry = null, html = "qp", subject = "Coffee?" } = {}) {
  const token = ("Tok" + (++n) + "abcdefghijklmnop").slice(0, 16);
  const msg = put(rawMsg(token, { html, subject }), ["SENT"]);
  const id = Number(sqlite.prepare("INSERT INTO emails(token,to_addr,subject,created_at,user_id,gmail_msg,retry_json) VALUES(?,?,?,?,?,?,?)")
    .run(token, "jane@acme.com", subject, now() - 60, uid, msg, retry ? JSON.stringify(retry) : null).lastInsertRowid);
  return { id, token, msg };
}
const row = id => sqlite.prepare("SELECT * FROM emails WHERE id=?").get(id);
const inSent = () => [...box.values()].filter(m => m.labelIds.includes("SENT"));

// 1. the normal case
await G.labelEmail(env, cfg, 0);   // no-op, warms nothing
const a = tracked();
await G.labelEmail(env, cfg, a.id);                         // ✔ on the original, as the post-send hook does first
const ids = Object.fromEntries(labels.map(l => [l.name, l.id]));
check("setup: original has ✔", box.get(a.msg).labelIds.includes(ids["✔"]), box.get(a.msg));
calls.length = 0;
let st = await S.hideTracking(env, cfg, a.id);
const ra = row(a.id), copy = box.get(ra.gmail_msg);
check("swap: done", st === "done" && ra.sent_clean === "done", [st, ra.sent_clean]);
check("copy: no tracking image, same Message-ID and attachment", copy && !copy.raw.includes(a.token.slice(5)) && copy.raw.includes("Message-ID: <CAF+abc123@mail.gmail.com>") && copy.raw.includes(PDF_B64), copy && copy.raw.slice(0, 200));
check("copy: same conversation, SENT and ✔, date from the Date header", copy.threadId === box.get(a.msg).threadId && copy.labelIds.includes("SENT") && copy.labelIds.includes(ids["✔"]) && copy.insertQuery === "?internalDateSource=dateHeader", copy);
check("original moved to Trash, only the copy in Sent", box.get(a.msg).trashed && inSent().filter(m => m.raw.includes("Coffee?")).length === 1, box.get(a.msg).labelIds);
check("checkmarks follow the copy (gmail_msg updated, label re-applied)", ra.gmail_msg === copy.id && ra.gmail_label === "sent", ra);
check("a handful of Gmail calls (well under 50)", calls.length <= 7, calls);
// opened later: ✔✔ goes on the copy
sqlite.prepare("UPDATE emails SET opens=1 WHERE id=?").run(a.id);
await G.labelEmail(env, cfg, a.id);
check("open afterwards: ✔✔ on the copy, original not touched", copy.labelIds.includes(ids["✔✔"]) && !copy.labelIds.includes(ids["✔"]) && !box.get(a.msg).labelIds.includes(ids["✔✔"]), [copy.labelIds, box.get(a.msg).labelIds]);
calls.length = 0;
st = await S.hideTracking(env, cfg, a.id);
check("running again: nothing to do, no Gmail calls", st === "done" && calls.length === 0, [st, calls]);

// 2. setting off
sqlite.prepare("UPDATE users SET prefs=? WHERE id=?").run(JSON.stringify({ hide_sent_pixel: false }), uid);
const b = tracked();
calls.length = 0;
st = await S.hideTracking(env, cfg, b.id);
check("setting off: left alone, no Gmail calls", st === "off" && calls.length === 0 && !box.get(b.msg).trashed, [st, calls]);
await S.sweepSentCopies(env, cfg);
check("setting off: sweep skips it too", !box.get(b.msg).trashed && row(b.id).sent_clean === null, row(b.id));
sqlite.prepare("UPDATE users SET prefs=NULL WHERE id=?").run(uid);
sqlite.prepare("UPDATE emails SET sent_clean='done' WHERE id=?").run(b.id);   // out of the way

// 3. auto-try still watching: wait; once delivered, the sweep swaps it
const c = tracked({ retry: { cands: ["jane@acme.com", "j@acme.com"], name: "Jane", i: 0, state: "watching", at: now() - 30, msg: null, log: [] } });
calls.length = 0;
st = await S.hideTracking(env, cfg, c.id);
await S.sweepSentCopies(env, cfg);
check("auto-try watching: not swapped (it resends from this copy)", st === "wait" && !box.get(c.msg).trashed && calls.length === 0, [st, calls]);
const rj = JSON.parse(row(c.id).retry_json); rj.state = "delivered"; rj.msg = c.msg; rj.checked = now(); rj.at = now() - 300;
sqlite.prepare("UPDATE emails SET retry_json=? WHERE id=?").run(JSON.stringify(rj), c.id);
await S.sweepSentCopies(env, cfg);
const rc = row(c.id);
check("auto-try over (delivered): sweep swaps it", rc.sent_clean === "done" && box.get(c.msg).trashed && rc.gmail_msg !== c.msg, rc);

// 3b. a late bounce after the swap: resent from the original (with tracking), the clean copy goes to Trash
box.set("b1", { id: "b1", threadId: box.get(c.msg).threadId, labelIds: ["INBOX"], raw: "", from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
  failed: "jane@acme.com", snippet: "Address not found. Your message wasn't delivered to jane@acme.com", date: now() });
const rj2 = JSON.parse(row(c.id).retry_json); rj2.checked = 0;
sqlite.prepare("UPDATE emails SET retry_json=? WHERE id=?").run(JSON.stringify(rj2), c.id);
const cleanCopy = rc.gmail_msg;
const rs = await R.advanceRetry(env, cfg, c.id);
const rc2 = row(c.id), resent = box.get(rc2.gmail_msg);
check("late bounce: next address gets the email WITH tracking", rs.current === "j@acme.com" && resent && /^To: j@acme\.com$/m.test(resent.raw) && resent.raw.includes(c.token.slice(5)), [rs, resent && resent.raw.slice(0, 120)]);
check("late bounce: clean copy trashed too, new copy queued for its own swap", box.get(cleanCopy).trashed && rc2.sent_clean === null, [box.get(cleanCopy).labelIds, rc2.sent_clean]);

// 4. too big
const d = tracked();
box.get(d.msg).size = S.MAX_BYTES + 1;
st = await S.hideTracking(env, cfg, d.id);
check("over the size limit: left alone", st === "big" && !box.get(d.msg).trashed && row(d.id).sent_clean === "big", st);

// 5. insert fails: original untouched, tried again later
const e = tracked();
fail.insert = true;
st = await S.hideTracking(env, cfg, e.id);
check("insert fails: original untouched, err:1", st === "error" && !box.get(e.msg).trashed && row(e.id).sent_clean === "err:1" && row(e.id).gmail_msg === e.msg, [st, row(e.id).sent_clean]);
fail.insert = false;
await S.sweepSentCopies(env, cfg);
check("...and the sweep tries again and succeeds", row(e.id).sent_clean === "done" && box.get(e.msg).trashed, row(e.id).sent_clean);

// 6. trashing the original fails: the copy is removed again
const f = tracked();
fail.trash.add(f.msg);
const before = inSent().length;
st = await S.hideTracking(env, cfg, f.id);
check("trash fails: copy rolled back, original still in Sent and tracked email unchanged", st === "error" && inSent().length === before && !box.get(f.msg).trashed && row(f.id).gmail_msg === f.msg, [st, inSent().length, before]);
fail.trash.delete(f.msg);
sqlite.prepare("UPDATE emails SET sent_clean='done' WHERE id=?").run(f.id);

// 7. copy lands in another conversation: rolled back
const g = tracked();
fail.thread = "tOTHER";
st = await S.hideTracking(env, cfg, g.id);
fail.thread = null;
check("wrong conversation: copy rolled back, original kept", st === "error" && !box.get(g.msg).trashed && ![...box.values()].some(m => m.threadId === "tOTHER" && !m.trashed), st);
sqlite.prepare("UPDATE emails SET sent_clean='done' WHERE id=?").run(g.id);

// 8. interrupted after insert: the next run uses that copy instead of making another
const h = tracked();
const copyH = put(S.stripPixels(box.get(h.msg).raw, h.token, S.hostsOf(cfg)).raw, ["SENT"], box.get(h.msg).threadId);
sqlite.prepare("UPDATE emails SET sent_clean=? WHERE id=?").run(`copy:${copyH}:${Math.floor(now()) - 3600}:1`, h.id);
calls.length = 0;
await S.sweepSentCopies(env, cfg);
check("interrupted run resumed: original trashed, no second copy", row(h.id).sent_clean === "done" && row(h.id).gmail_msg === copyH && box.get(h.msg).trashed && !calls.some(x => x === "POST /messages?internalDateSource=dateHeader"), [row(h.id), calls]);
// interrupted right after trashing the original: finish (point at the copy), don't give up on it
const h2 = tracked();
const copyH2 = put(S.stripPixels(box.get(h2.msg).raw, h2.token, S.hostsOf(cfg)).raw, ["SENT"], box.get(h2.msg).threadId);
box.get(h2.msg).labelIds = ["TRASH"]; box.get(h2.msg).trashed = true;
sqlite.prepare("UPDATE emails SET sent_clean=? WHERE id=?").run(`copy:${copyH2}:0:1`, h2.id);
st = await S.hideTracking(env, cfg, h2.id);
check("interrupted after trashing the original: finished with the copy", st === "done" && row(h2.id).gmail_msg === copyH2 && !box.get(copyH2).trashed, [st, row(h2.id)]);
// a run in progress (fresh claim) is left alone
const i = tracked();
sqlite.prepare("UPDATE emails SET sent_clean=? WHERE id=?").run(`work:${Math.floor(now())}:1`, i.id);
st = await S.hideTracking(env, cfg, i.id);
check("someone else's run in progress: busy, nothing done", st === "busy" && !box.get(i.msg).trashed, st);
sqlite.prepare("UPDATE emails SET sent_clean='done' WHERE id=?").run(i.id);

// 9. two runs at once (post-send hook + sweep): only one copy
const j = tracked();
const [s1, s2] = await Promise.all([S.hideTracking(env, cfg, j.id), S.hideTracking(env, cfg, j.id)]);
const copiesJ = [...box.values()].filter(m => m.threadId === box.get(j.msg).threadId && m.id !== j.msg);
check("concurrent runs: one swap, one copy", [s1, s2].sort().join() === "busy,done" && copiesJ.length === 1, [s1, s2, copiesJ.length]);

// 10. the message isn't this email's (no pixel for its token): left alone
const k = tracked();
box.get(k.msg).raw = rawMsg("SomebodyElse0000");
st = await S.hideTracking(env, cfg, k.id);
check("not this email's message: left alone", st === "none" && !box.get(k.msg).trashed, st);

// 11. message gone from Gmail: forget it so the label sweep finds the Sent copy again
const l = tracked();
box.delete(l.msg);
st = await S.hideTracking(env, cfg, l.id);
check("message gone: gmail_msg cleared", st === "wait" && row(l.id).gmail_msg === null && row(l.id).sent_clean === null, row(l.id));

// 12. sweep does one per run
const m1 = tracked(), m2 = tracked();
await S.sweepSentCopies(env, cfg);
check("sweep: one email per run", [row(m1.id).sent_clean, row(m2.id).sent_clean].filter(x => x === "done").length === 1, [row(m1.id).sent_clean, row(m2.id).sent_clean]);

// 13. not connected / Google not configured
check("Google not configured: off", (await S.hideTracking(env, { ...cfg, googleClientId: "" }, m1.id)) === "off", "");

// 14. labelEmail doesn't put back the old message id after a swap happened meanwhile
const o = tracked();
sqlite.prepare("UPDATE emails SET gmail_label='sent' WHERE id=?").run(o.id);
sqlite.prepare("UPDATE emails SET opens=1 WHERE id=?").run(o.id);
const realModify = globalThis.fetch;
let swappedDuring = false;
globalThis.fetch = async (url, opts) => {
  if (!swappedDuring && String(url).includes(`/messages/${o.msg}/modify`)) {
    swappedDuring = true;
    sqlite.prepare("UPDATE emails SET gmail_msg='mSWAPPED', gmail_label=NULL WHERE id=?").run(o.id);
  }
  return realModify(url, opts);
};
await G.labelEmail(env, cfg, o.id);
globalThis.fetch = realModify;
check("labelEmail racing a swap keeps the new message id", row(o.id).gmail_msg === "mSWAPPED", row(o.id));

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
if (results.some(r => !r)) process.exit(1);
