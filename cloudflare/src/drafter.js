// ------------------------------------------------------------------ AI drafter
// Writes or rewrites an email in Gmail compose with Claude, using the user's
// own Claude API key (stored encrypted, never sent to the extension).
// What Claude sees: what the email is for, the recipient (name, company, and
// their title if MailSpy's people index knows it), what the user wrote about
// themselves in Settings, their draft (to improve it), and the message being
// replied to.
import Anthropic from "@anthropic-ai/sdk";
import { sealToken, openToken } from "./google.js";

export const DRAFT_MODEL = "claude-opus-5-5";
const KEY_RE = /^sk-ant-[A-Za-z0-9_-]{20,250}$/;
const TONES = {
  direct: "Short and direct: get to the point in the first sentence.",
  warm: "Warm and friendly, still concise.",
  formal: "Polite and professional.",
};
const clip = (s, n) => String(s || "").replace(/\r/g, "").trim().slice(0, n);

export const isClaudeKey = k => KEY_RE.test(String(k || "").trim());

// Settings: a newly pasted key is encrypted; an empty field keeps the saved one.
export async function claudeKeyFromForm(cfg, form, prev) {
  const raw = String(form.claude_key || "").trim();
  if (form.claude_key_remove === "1") return { claude_key: "", claude_key_hint: "" };
  if (isClaudeKey(raw)) return { claude_key: await sealToken(cfg.sessionSecret, raw), claude_key_hint: raw.slice(-4) };
  return { claude_key: prev.claude_key || "", claude_key_hint: prev.claude_key_hint || "" };
}

const SYSTEM = `You draft emails that the user sends from their own Gmail account. Write as the user, in the first person.

- Sound like a capable person writing by hand: plain words, specific, no filler. Avoid stock phrases such as "I hope this email finds you well", "I wanted to reach out", or "I am writing to express my interest".
- Use only facts given to you about the user and the recipient. Never invent experience, numbers, mutual connections or details about the recipient's work. If something useful is missing, write around it; never leave placeholders like [Company] or [Your Name].
- Cold emails: under 120 words unless asked otherwise, one clear ask, easy to answer. Replies: answer what was said, as briefly as fits.
- Address the recipient by first name when you know it; otherwise use a neutral greeting.
- When <how_i_write> or <emails_i_wrote> are given, write the way I do (length, greeting, structure, phrasing, how I ask) rather than in a generic style. Use my past emails as a guide, not a script: don't copy their sentences or facts that belong to a different recipient.
- Follow the sign-off instruction in the request.

Output format, exactly: the first line is "Subject: " followed by the subject; then a blank line; then the body as plain text, paragraphs separated by blank lines. No markdown, no notes before or after.`;

export function buildPrompt({ user, prefs, input, role }) {
  const r = input || {};
  const parts = [];
  const me = [user && user.name ? `Name: ${user.name}` : "", clip(prefs.ai_about, 2000),
    prefs.ai_resume ? `From my resume and past emails:\n${clip(prefs.ai_resume, 2500)}` : ""].filter(Boolean).join("\n\n");
  if (me) parts.push(`<about_me>\n${me}${prefs.ai_about && prefs.ai_resume ? "\n\n(Where these disagree, what I wrote first wins.)" : ""}\n</about_me>`);
  if (prefs.ai_style) parts.push(`<how_i_write>\n${clip(prefs.ai_style, 2000)}\n</how_i_write>`);
  const ex = (prefs.ai_examples || []).slice(0, 3);
  if (ex.length) parts.push(`<emails_i_wrote>\n${ex.map(e => `<email status="${clip(e.status, 40)}">\nSubject: ${clip(e.subject, 300)}\n\n${clip(e.body, 1800)}\n</email>`).join("\n")}\n</emails_i_wrote>`);
  const to = [
    r.to_name ? `Name: ${clip(r.to_name, 120)}` : "",
    r.to_email ? `Email: ${clip(r.to_email, 200)}` : "",
    r.company ? `Company: ${clip(r.company, 120)}` : "",
    role ? `Role: ${clip(role, 160)}` : "",
  ].filter(Boolean).join("\n");
  parts.push(to ? `<recipient>\n${to}\n</recipient>` : "<recipient>Not filled in yet.</recipient>");
  if (r.thread) parts.push(`<message_being_replied_to>\n${clip(r.thread, 4000)}\n</message_being_replied_to>`);
  const draft = clip(r.draft, 6000);
  const goal = clip(r.goal, 1500);
  if (r.mode === "improve" && draft) {
    parts.push(`<my_draft>\nSubject: ${clip(r.subject, 300)}\n\n${draft}\n</my_draft>`);
    parts.push(`Rewrite my draft so it reads better. Keep its meaning and every fact in it; don't add new claims.${goal ? ` Also: ${goal}` : ""}`);
  } else {
    parts.push(`What this email is for: ${goal || (r.thread ? "Reply to the message above." : "Introduce myself and ask for a short call.")}`);
    if (r.subject) parts.push(`Keep this subject unless it's clearly wrong: ${clip(r.subject, 300)}`);
  }
  parts.push(`Tone: ${TONES[r.tone] || TONES.direct}`);
  parts.push(r.has_signature
    ? "Sign-off: end with a short closing line only (like \"Thanks,\"), with no name after it; my Gmail signature follows."
    : `Sign-off: end with a short closing and ${user && user.name ? `my first name (${String(user.name).split(/\s+/)[0]})` : "no name"}.`);
  return parts.join("\n\n");
}

// "Subject: ...\n\nbody" -> { subject, body }
export function parseDraft(text) {
  let t = String(text || "").replace(/\r/g, "").trim();
  t = t.replace(/^```[a-z]*\n?|\n?```$/g, "").trim();
  let subject = "";
  const m = t.match(/^\**subject:?\**\s*(.*)\n+/i);
  if (m) { subject = m[1].trim(); t = t.slice(m[0].length); }
  return { subject, body: t.trim() };
}

export function apiError(e) {
  if (e instanceof Anthropic.AuthenticationError) return "Claude didn't accept your API key. Check it in MailSpy Settings.";
  if (e instanceof Anthropic.PermissionDeniedError) return "Your Claude API key can't use this model. Check its permissions in the Claude Console.";
  if (e instanceof Anthropic.RateLimitError) return "Claude is rate-limiting your key right now. Try again in a minute.";
  if (e instanceof Anthropic.BadRequestError) return `Claude couldn't do that: ${e.message}`;   // e.g. credit balance too low
  if (e instanceof Anthropic.APIConnectionTimeoutError) return "Claude took too long. Try again.";
  if (e instanceof Anthropic.APIConnectionError) return "Couldn't reach Claude. Try again.";
  if (e instanceof Anthropic.APIError) return `Claude had a problem (${e.status || "error"}). Try again.`;
  return "Drafting failed. Try again.";
}

export async function draftEmail(cfg, prefs, user, input, role = "") {
  if (!prefs.claude_key) return { error: "Add your Claude API key in MailSpy Settings to draft with AI.", needsKey: true };
  const apiKey = await openToken(cfg.sessionSecret, prefs.claude_key);
  if (!apiKey) return { error: "Your saved Claude API key couldn't be read. Paste it again in MailSpy Settings.", needsKey: true };
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 60_000 });
  try {
    const res = await client.beta.messages.create({
      model: DRAFT_MODEL,
      max_tokens: 16000,
      output_config: { effort: "low" },       // short writing: quick, and plenty good
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",                   // if a safety check declines, Anthropic retries on its recommended model
      system: SYSTEM,
      messages: [{ role: "user", content: buildPrompt({ user, prefs, input, role }) }],
    });
    if (res.stop_reason === "refusal") return { error: "Claude declined to write this one. Try describing it differently." };
    const text = res.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
    if (!text) return { error: "Claude came back empty. Try again." };
    const out = parseDraft(text);
    if (res.stop_reason === "max_tokens") out.cut = true;
    return { ...out, model: res.model, usage: { input: res.usage.input_tokens, output: res.usage.output_tokens } };
  } catch (e) {
    return { error: apiError(e) };
  }
}
