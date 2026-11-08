// AI drafter (cloudflare/src/drafter.js): key storage, the prompt, and the
// Claude API call, against a fake API (no network, no real key).
const SRC = new URL("../../cloudflare/src/", import.meta.url).href;
const D = await import(SRC + "drafter.js");
const P = await import(SRC + "prefs.js");

let results = [];
const check = (n, c, d) => { results.push(!!c); console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  [" + JSON.stringify(d) + "]")); };

const cfg = { sessionSecret: "test-secret-0123456789abcdef", followupHours: 48, revivalDays: 7, spikeCount: 3, spikeWindow: 600, prefetchWindow: 12 };
const KEY = "sk-ant-api03-" + "x".repeat(40) + "WXYZ";

// --- storing the key
const sealed = await D.claudeKeyFromForm(cfg, { claude_key: KEY }, {});
check("a pasted key is stored encrypted, not as typed", sealed.claude_key && !sealed.claude_key.includes("sk-ant") && sealed.claude_key_hint === "WXYZ", sealed);
const kept = await D.claudeKeyFromForm(cfg, { claude_key: "" }, sealed);
check("empty field keeps the saved key (autosave of other settings)", kept.claude_key === sealed.claude_key && kept.claude_key_hint === "WXYZ", kept);
const junk = await D.claudeKeyFromForm(cfg, { claude_key: "not a key" }, sealed);
check("something that isn't a key doesn't replace it", junk.claude_key === sealed.claude_key, junk);
const gone = await D.claudeKeyFromForm(cfg, { claude_key_remove: "1" }, sealed);
check("remove clears it", gone.claude_key === "" && gone.claude_key_hint === "", gone);
const prefs = P.normalizePrefs(cfg, { ...sealed, ai_about: "CS student. Interned at Acme on payments.\r\n" });
check("prefs keep the encrypted key and the about-me text", prefs.claude_key === sealed.claude_key && prefs.ai_about === "CS student. Interned at Acme on payments.", prefs);
check("prefs drop a plain-text key", P.normalizePrefs(cfg, { claude_key: KEY }).claude_key === "", null);

// --- the prompt
const user = { name: "Aryan Harkawat" };
let p = D.buildPrompt({ user, prefs, role: "Technical Recruiter",
  input: { mode: "new", goal: "ask about new-grad roles", tone: "warm", to_name: "Jane Doe", to_email: "jane@stripe.com", company: "Stripe", has_signature: false } });
check("prompt has the user's facts, the recipient and their role", /Interned at Acme/.test(p) && /Jane Doe/.test(p) && /Company: Stripe/.test(p) && /Role: Technical Recruiter/.test(p), p);
check("prompt has the goal and tone", /ask about new-grad roles/.test(p) && /Warm and friendly/.test(p), p);
check("no signature: sign off with first name", /first name \(Aryan\)/.test(p), p);
p = D.buildPrompt({ user, prefs, input: { mode: "improve", draft: "hey can we chat", subject: "Chat?", goal: "shorter", has_signature: true, thread: "Thanks for applying!" } });
check("improve: sends my draft and asks to keep its facts", /<my_draft>[\s\S]*hey can we chat/.test(p) && /Keep its meaning/.test(p) && /Also: shorter/.test(p), p);
check("reply: includes the message being replied to", /<message_being_replied_to>\nThanks for applying!/.test(p), p);
check("signature present: no name in the sign-off", /no name after it/.test(p), p);
check("long input is clipped", D.buildPrompt({ user, prefs, input: { goal: "g".repeat(5000) } }).length < 4500, null);

// --- reading Claude's answer
let d = D.parseDraft("Subject: Quick question about new-grad roles\n\nHi Jane,\n\nI'm Aryan.\n\nThanks,\nAryan");
check("parse: subject line and body", d.subject === "Quick question about new-grad roles" && d.body.startsWith("Hi Jane,") && d.body.endsWith("Aryan"), d);
d = D.parseDraft("**Subject:** Hello\n\nBody");
check("parse: tolerates bold Subject", d.subject === "Hello" && d.body === "Body", d);

// --- calling Claude (fake API)
let last = null, reply = null;
globalThis.fetch = async (url, init = {}) => {
  const h = new Headers(init.headers || {});
  last = { url: String(url), headers: Object.fromEntries(h.entries()), body: JSON.parse(init.body || "{}") };
  return reply();
};
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", "request-id": "req_test" } });
const msg = (text, stop = "end_turn") => J({ id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: stop, stop_details: null,
  content: [{ type: "text", text }], usage: { input_tokens: 400, output_tokens: 120 } });

reply = () => msg("Subject: Hi from Aryan\n\nHi Jane,\n\nShort note.\n\nThanks,");
let r = await D.draftEmail(cfg, prefs, user, { mode: "new", goal: "say hi", to_name: "Jane Doe", to_email: "jane@stripe.com" }, "Recruiter");
check("draft comes back as subject + body", r.subject === "Hi from Aryan" && /Short note/.test(r.body) && !r.error, r);
const sentKey = last.headers["x-api-key"] || String(last.headers.authorization || "").replace(/^Bearer /, "");
check("calls the Messages API with your own key", /\/v1\/messages(\?|$)/.test(last.url) && sentKey === KEY, { url: last.url });
check("uses Claude Opus 5.5 at low effort", last.body.model === "claude-opus-5-5" && last.body.output_config && last.body.output_config.effort === "low", last.body);
check("refusal fallback on: fallbacks default + its beta header", last.body.fallbacks === "default" && /server-side-fallback-2026-07-01/.test(last.headers["anthropic-beta"] || ""), { f: last.body.fallbacks, beta: last.headers["anthropic-beta"] });
check("no thinking settings sent (Opus 5.5 always thinks)", !("thinking" in last.body) && !("temperature" in last.body), last.body);

reply = () => J({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, 401);
r = await D.draftEmail(cfg, prefs, user, { goal: "x" });
check("bad key: plain message pointing to Settings", /didn't accept your API key/.test(r.error || ""), r);
reply = () => J({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low" } }, 400);
r = await D.draftEmail(cfg, prefs, user, { goal: "x" });
check("no credit: Claude's reason is shown", /credit balance/.test(r.error || ""), r);
reply = () => J({ id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "refusal", stop_details: { type: "refusal", category: null, explanation: "" }, content: [], usage: { input_tokens: 1, output_tokens: 0 } });
r = await D.draftEmail(cfg, prefs, user, { goal: "x" });
check("refusal: says so instead of inserting nothing", /declined/.test(r.error || ""), r);
r = await D.draftEmail(cfg, { ...prefs, claude_key: "" }, user, { goal: "x" });
check("no key saved: asks for one, no API call", r.needsKey && /Add your Claude API key/.test(r.error), r);
r = await D.draftEmail({ ...cfg, sessionSecret: "different-secret-zzzzzzzzzzzz" }, prefs, user, { goal: "x" });
check("key that can't be decrypted: asks to paste it again", r.needsKey && /couldn't be read/.test(r.error), r);

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
if (results.some(r => !r)) process.exit(1);
