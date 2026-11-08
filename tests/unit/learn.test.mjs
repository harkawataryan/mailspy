// AI drafter, "Learn from my Gmail" (cloudflare/src/learn.js): which emails it
// reads, how it cleans them, finding the resume, and the Claude call, against a
// fake Gmail and a fake Claude API on node:sqlite.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
const SRC = new URL("../../cloudflare/src/", import.meta.url).href;
const L = await import(SRC + "learn.js");
const D = await import(SRC + "drafter.js");
const G = await import(SRC + "google.js");
const P = await import(SRC + "prefs.js");

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
const cfg = { googleClientId: "cid", googleClientSecret: "cs", sessionSecret: "test-session-secret-abcdefghijklmnop", followupHours: 48, revivalDays: 7, spikeCount: 3, spikeWindow: 600, prefetchWindow: 12 };
await G.ensureGoogleSchema(db);
sqlite.prepare("INSERT INTO users (id, email, password_hash, api_key, created_at) VALUES (1, 'me@gmail.com', 'x', 'k1', 0)").run();
sqlite.prepare("UPDATE users SET gmail_token=?, gmail_email='me@gmail.com' WHERE id=1").run(await G.sealToken(cfg.sessionSecret, "refresh"));

// ---- cleaning
check("quoted reply removed", L.cleanBody("Thanks, Tuesday works.\n\nOn Mon, Oct 5, 2026 at 9:00 AM Jane <j@x.com> wrote:\n> Can you do Tuesday?") === "Thanks, Tuesday works.", null);
check("signature removed", L.cleanBody("Hi Jane,\nShort note.\n-- \nAryan | aryanh.dev") === "Hi Jane,\nShort note.", null);
check("addresses parsed", JSON.stringify(L.addrs('"Doe, Jane" <Jane@Stripe.com>, bob@x.com')) === JSON.stringify([{ name: "Doe, Jane", email: "jane@stripe.com" }, { name: "", email: "bob@x.com" }]), L.addrs('"Doe, Jane" <Jane@Stripe.com>, bob@x.com'));

// ---- fake Gmail
const enc = s => Buffer.from(s, "utf8").toString("base64url");
const box = new Map();
const mk = (id, to, subject, body, extra = {}) => box.set(id, { id, internalDate: String(Date.parse("2026-10-01") + Number(id.replace(/\D/g, "")) * 1000),
  payload: { mimeType: "multipart/alternative", headers: [{ name: "To", value: to }, { name: "Subject", value: subject }],
    parts: [{ mimeType: "text/plain", body: { data: enc(body) } }, { mimeType: "text/html", body: { data: enc("<p>" + body + "</p>") } }, ...(extra.parts || [])] } });
const LONG = " I built the ingestion service for our metrics pipeline in Go and would love to hear about backend roles on your team.";
mk("s1", "Jane Doe <jane@stripe.com>", "New-grad backend roles", "Hi Jane,\n\nI'm Aryan, a CS senior." + LONG + "\n\nThanks,\nAryan");
mk("t1", "Sam Lee <sam@figma.com>", "Quick question", "Hi Sam,\n\nSaw your post about the infra team." + LONG + "\n\nBest,\nAryan");
mk("t2", "Ann Wu <ann@acme.com>", "Hello from Aryan", "Hi Ann,\n\nReaching out about internships." + LONG);
mk("dup", "Ann Wu <ann.wu@acme.com>", "Hello from Aryan", "Hi Ann,\n\nReaching out about internships." + LONG);   // auto-try resend
mk("self", "me@gmail.com", "note to self", "Remember to follow up with everyone next week about the roles." + LONG);
mk("short", "bob@x.com", "Re: lunch", "Sounds good!");
mk("r1", "Hiring <jobs@acme.com>", "Application", "Hi team,\n\nAttached is my resume." + LONG, {
  parts: [{ mimeType: "application/pdf", filename: "Aryan_Resume_2026.pdf", body: { attachmentId: "att1", size: 90000 } }] });
const lists = { "in:scheduled": ["s1"], "in:sent newer_than:1y": ["short", "self"] };
let gmailCalls = 0, claudeCall = null, claudeReply = null;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
  if (u.host === "oauth2.googleapis.com") return J({ access_token: "at", expires_in: 3599 });
  if (u.host === "api.anthropic.com") { claudeCall = JSON.parse(init.body); return claudeReply(); }
  gmailCalls++;
  const path = u.pathname.replace("/gmail/v1/users/me", "");
  if (path === "/messages") {
    const q = u.searchParams.get("q");
    const ids = q.startsWith("in:sent has:attachment") ? ["r1"] : q.startsWith("in:sent newer_than:2y") ? ["t2", "dup", "short"] : (lists[q] || []);
    return J({ messages: ids.map(id => ({ id })) });
  }
  let m = path.match(/^\/messages\/([^/]+)\/attachments\/([^/]+)$/);
  if (m) return J({ data: Buffer.from("%PDF-1.4 fake resume").toString("base64url") });
  m = path.match(/^\/messages\/([^/]+)$/);
  if (m) return box.has(m[1]) ? J(box.get(m[1])) : J({}, 404);
  return J({}, 404);
};

// tracked emails: t1 got a reply, t2 opened
sqlite.prepare("INSERT INTO emails (token, to_addr, subject, created_at, user_id, opens) VALUES ('a', 'sam@figma.com', 'Quick question', 10, 1, 2)").run();
sqlite.prepare("INSERT INTO emails (token, to_addr, subject, created_at, user_id, opens) VALUES ('b', 'ann@acme.com', 'Hello from Aryan', 20, 1, 1)").run();
sqlite.prepare("UPDATE emails SET gmail_msg='t1', replied_at=30 WHERE token='a'").run();
sqlite.prepare("UPDATE emails SET gmail_msg='t2' WHERE token='b'").run();

const emails = await L.collectEmails(db, "at", 1, "me@gmail.com");
const subj = emails.map(e => e.subject);
check("reads scheduled, tracked and outreach emails", subj.includes("New-grad backend roles") && subj.includes("Quick question") && subj.includes("Hello from Aryan"), subj);
check("scheduled first, then the ones that got replies", emails[0].status.startsWith("scheduled") && emails[1].status === "got a reply", emails.map(e => e.status));
check("tracked email that was opened says so", emails.find(e => e.subject === "Hello from Aryan").status === "opened, no reply yet", emails);
check("skips notes to self, one-liners and duplicate resends", !subj.includes("note to self") && !subj.includes("Re: lunch") && subj.filter(s => s === "Hello from Aryan").length === 1, subj);
check("recipients reduced to name and company domain", emails[0].to === "Jane Doe (stripe.com)" && !JSON.stringify(emails).includes("jane@stripe.com"), emails[0].to);
const resume = await L.findResume("at");
check("finds the resume attached to a sent email", resume && resume.name === "Aryan_Resume_2026.pdf" && Buffer.from(resume.data, "base64").toString().startsWith("%PDF"), resume);

// ---- the whole thing, with a fake Claude
const key = await D.claudeKeyFromForm(cfg, { claude_key: "sk-ant-api03-" + "k".repeat(40) }, {});
const prefs = P.normalizePrefs(cfg, { ...key });
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
claudeReply = () => J({ id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", stop_details: null,
  content: [{ type: "text", text: JSON.stringify({ about: "- Aryan, CS senior\n- Built a Go metrics ingestion service", style: "- 4 short paragraphs\n- Opens with who he is", examples: [2, 2, 9, 1] }) }],
  usage: { input_tokens: 5000, output_tokens: 300 } });
const out = await L.learnProfile(db, cfg, 1, prefs);
check("profile saved: facts, style, examples", /Go metrics/.test(out.ai_resume) && /short paragraphs/.test(out.ai_style) && out.ai_examples.length === 2, out);
check("examples are the emails Claude picked (bad numbers ignored)", out.ai_examples[0].subject === emails[1].subject && out.ai_examples[0].status === "got a reply", out.ai_examples);
check("notes what it learned from", out.ai_learned.emails === emails.length && out.ai_learned.resume === "Aryan_Resume_2026.pdf", out.ai_learned);
const content = claudeCall.messages[0].content;
check("resume sent to Claude as a PDF document", content[0].type === "document" && content[0].source.media_type === "application/pdf", content[0].type);
check("emails sent to Claude with their outcomes", /status="got a reply"/.test(content[1].text) && /status="scheduled, not sent yet"/.test(content[1].text), null);
check("asks for structured output on Opus 5.5 with the fallback", claudeCall.model === "claude-opus-5-5" && claudeCall.output_config.format.type === "json_schema" && claudeCall.fallbacks === "default", claudeCall.output_config);

const up = { name: "MyCV.pdf", size: 20, arrayBuffer: async () => new TextEncoder().encode("%PDF-1.7 uploaded").buffer };
const out2 = await L.learnProfile(db, cfg, 1, prefs, up);
check("an uploaded resume is used instead of searching Gmail", out2.ai_learned.resume === "MyCV.pdf" && Buffer.from(claudeCall.messages[0].content[0].source.data, "base64").toString() === "%PDF-1.7 uploaded", out2.ai_learned);
const big = await L.learnProfile(db, cfg, 1, prefs, { name: "huge.pdf", size: 9e6, arrayBuffer: async () => new ArrayBuffer(1) });
check("too-large upload refused", /over 4.5 MB/.test(big.error || ""), big);
check("no Claude key: asks for it", /Claude API key/.test((await L.learnProfile(db, cfg, 1, { ...prefs, claude_key: "" })).error), null);
claudeReply = () => J({ type: "error", error: { type: "authentication_error", message: "invalid" } }, 401);
check("bad key: plain message", /didn't accept/.test((await L.learnProfile(db, cfg, 1, prefs)).error || ""), null);

// ---- the drafter uses the profile
const learned = P.normalizePrefs(cfg, { ...prefs, ...out, ai_about: "Graduating May 2027." });
check("profile survives the prefs check", learned.ai_examples.length === 2 && learned.ai_learned.emails === emails.length, learned.ai_learned);
const prompt = D.buildPrompt({ user: { name: "Aryan" }, prefs: learned, input: { goal: "ask about roles", to_name: "Pat Kim", company: "Plaid" } });
check("draft prompt includes facts, style and my example emails", /Graduating May 2027/.test(prompt) && /Go metrics/.test(prompt) && /<how_i_write>[\s\S]*short paragraphs/.test(prompt) && /<emails_i_wrote>[\s\S]*Quick question/.test(prompt), prompt.slice(0, 400));
check("what I wrote myself wins over what was learned", /what I wrote first wins/.test(prompt), null);

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
if (results.some(r => !r)) process.exit(1);
