// ------------------------------------------------------------------ AI drafter: learn from my Gmail
// When the user presses "Learn from my Gmail" in Settings, MailSpy reads their
// recent outreach (scheduled emails, the emails they tracked, sent emails that
// look like recruiting outreach, plus a few others) and the resume they've
// attached in Gmail or uploaded, and has Claude (with the user's own key) turn
// that into a profile the drafter uses: facts about them, how they write, and
// up to 3 example emails. Only that profile is stored; the emails and resume
// are read in memory and not kept.
import Anthropic from "@anthropic-ai/sdk";
import { accessToken, gmail, gmailStatus, openToken } from "./google.js";
import { DRAFT_MODEL, apiError } from "./drafter.js";

const MAX_FETCH = 22;        // Gmail messages read (Cloudflare allows 50 outside calls per request)
const MAX_EMAILS = 18;       // emails shown to Claude
const MAX_PDF = 4.5 * 1024 * 1024;
const OUTREACH_Q = 'in:sent newer_than:2y (recruiter OR recruiting OR role OR roles OR position OR internship OR intern OR "new grad" OR opportunity OR opportunities OR hiring OR application OR applied OR resume OR referral OR interview OR "coffee chat" OR "quick call")';
const RESUME_Q = 'in:sent has:attachment filename:pdf (resume OR cv OR "curriculum vitae")';
const RESUME_NAME = /(resume|résumé|\bcv\b|curriculum)/i;

// ---- reading a Gmail message
function b64uBytes(s) {
  const b = atob(String(s || "").replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}
const b64uToB64 = s => { const t = String(s || "").replace(/-/g, "+").replace(/_/g, "/"); return t + "=".repeat((4 - t.length % 4) % 4); };
export function bytesToB64(buf) {
  const u = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
function partsOf(p, out = []) {
  if (!p) return out;
  out.push(p);
  for (const c of p.parts || []) partsOf(c, out);
  return out;
}
export const header = (msg, name) => ((((msg || {}).payload || {}).headers || []).find(h => h.name.toLowerCase() === name.toLowerCase()) || {}).value || "";

function htmlText(h) {
  return String(h || "").replace(/<(style|script)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
}

// Just what the person wrote: no quoted reply, no signature, tidy blank lines
export function cleanBody(t) {
  let s = String(t || "").replace(/\r\n?/g, "\n");
  const cuts = [/^On .{0,300}wrote:\s*$/m, /^-{2,}\s*(Original|Forwarded) Message/im, /^_{5,}\s*$/m, /^From: .+\n(Sent|Date): /m, /^-- ?$/m];
  for (const re of cuts) { const m = s.match(re); if (m) s = s.slice(0, m.index); }
  s = s.split("\n").filter(l => !/^\s*>/.test(l)).join("\n");
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function messageText(msg) {
  const parts = partsOf(msg && msg.payload);
  const plain = parts.find(p => p.mimeType === "text/plain" && p.body && p.body.data);
  if (plain) return cleanBody(new TextDecoder().decode(b64uBytes(plain.body.data)));
  const html = parts.find(p => p.mimeType === "text/html" && p.body && p.body.data);
  return html ? cleanBody(htmlText(new TextDecoder().decode(b64uBytes(html.body.data)))) : "";
}

// "Jane Doe <jane@stripe.com>, bob@x.com" -> [{ name, email }]
export function addrs(v) {
  return String(v || "").split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(s => {
    const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
    return m ? { name: m[1].trim(), email: m[2].trim().toLowerCase() } : { name: "", email: s.trim().toLowerCase() };
  }).filter(a => a.email.includes("@"));
}

// ---- gathering
async function listIds(token, q, n) {
  const r = await gmail(token, `/messages?maxResults=${n}&q=${encodeURIComponent(q)}`).catch(() => null);
  return ((r && r.messages) || []).map(m => m.id);
}

export async function collectEmails(db, token, uid, me) {
  const want = new Map();   // gmail id -> status
  const add = (id, status) => { if (id && !want.has(id)) want.set(id, status); };
  for (const id of await listIds(token, "in:scheduled", 5)) add(id, "scheduled, not sent yet");
  const tracked = (await db.prepare(`SELECT gmail_msg, opens, clicks, replied_at FROM emails
      WHERE user_id=? AND gmail_msg IS NOT NULL ORDER BY created_at DESC LIMIT 12`).bind(uid).all()).results || [];
  for (const t of tracked.filter(t => t.replied_at)) add(t.gmail_msg, "got a reply");
  for (const t of tracked) add(t.gmail_msg, t.opens || t.clicks ? "opened, no reply yet" : "not opened yet");
  for (const id of await listIds(token, OUTREACH_Q, 10)) add(id, "sent");
  for (const id of await listIds(token, "in:sent newer_than:1y", 5)) add(id, "sent");

  const out = [], seen = new Set();
  for (const [id, status] of [...want].slice(0, MAX_FETCH)) {
    const msg = await gmail(token, `/messages/${id}?format=full`).catch(() => null);
    if (!msg) continue;
    const to = addrs(header(msg, "To"));
    if (!to.length || to.every(a => a.email === me)) continue;            // notes to self
    const body = messageText(msg);
    if (body.length < 60) continue;                                        // one-liners say little about style
    const k = body.toLowerCase().replace(/\s+/g, " ").slice(0, 160);
    if (seen.has(k)) continue;                                             // auto-try resends, duplicates
    seen.add(k);
    const t = to[0];
    out.push({
      subject: header(msg, "Subject").slice(0, 200),
      to: [t.name, `(${t.email.split("@")[1]})`].filter(Boolean).join(" "),
      date: new Date(Number(msg.internalDate) || Date.now()).toISOString().slice(0, 10),
      status, body: body.slice(0, 2500),
    });
    if (out.length >= MAX_EMAILS) break;
  }
  return out;
}

// The newest resume they've attached to a sent email
export async function findResume(token) {
  const ids = await listIds(token, RESUME_Q, 3);
  let fallback = null;
  for (const id of ids) {
    const msg = await gmail(token, `/messages/${id}?format=full`).catch(() => null);
    const pdfs = partsOf(msg && msg.payload).filter(p => /\.pdf$/i.test(p.filename || "") && p.body && p.body.attachmentId && (p.body.size || 0) <= MAX_PDF);
    const pick = pdfs.find(p => RESUME_NAME.test(p.filename)) || null;
    if (!pick) { if (!fallback && pdfs.length === 1) fallback = { id, part: pdfs[0] }; continue; }
    return fetchPdf(token, id, pick);
  }
  return fallback ? fetchPdf(token, fallback.id, fallback.part) : null;
}
async function fetchPdf(token, msgId, part) {
  const a = await gmail(token, `/messages/${msgId}/attachments/${part.body.attachmentId}`).catch(() => null);
  return a && a.data ? { name: part.filename, data: b64uToB64(a.data) } : null;
}

// ---- asking Claude
const SYSTEM = `You study one person's own emails and resume so that an assistant can draft new emails for them that sound like them and use only true facts about them. Be specific and concrete; write short lines that start with "- ". Never include anyone else's email address.`;

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["about", "style", "examples"],
  properties: {
    about: { type: "string", description: "Facts about the person for outreach emails." },
    style: { type: "string", description: "How the person writes outreach emails." },
    examples: { type: "array", items: { type: "integer" }, description: "Numbers of up to 3 emails that best show how they write outreach." },
  },
};

export function learnPrompt(emails, resumeName) {
  const list = emails.map((e, i) =>
    `<email n="${i + 1}" status="${e.status}" to="${e.to.replace(/"/g, "'")}" date="${e.date}" subject="${e.subject.replace(/"/g, "'")}">\n${e.body}\n</email>`).join("\n");
  return `${resumeName ? `My resume (${resumeName}) is attached. ` : ""}Below are ${emails.length} emails I wrote, newest outreach first, with what happened to each.

Write three things:
- about: the facts an email of mine to a recruiter, hiring manager or engineer could use: my name, school, degree and graduation date, experience (role, company, what I did, results with numbers), skills, notable projects, links, and what I'm looking for (roles, location, start date). Only facts stated in the resume or the emails. At most about 1200 characters.
- style: how I write these emails, specific enough to imitate: typical length, greeting and sign-off, structure, tone, phrases or habits I repeat, how I make the ask, how I write subject lines, and any differences between the emails that got replies and those that didn't. At most about 1000 characters.
- examples: the numbers of up to 3 emails that best show how I write outreach (prefer ones that got a reply; skip short logistics emails).

<emails>
${list || "(none found)"}
</emails>`;
}

export async function learnProfile(db, cfg, uid, prefs, upload = null) {
  if (!prefs.claude_key) return { error: "Add your Claude API key first." };
  const apiKey = await openToken(cfg.sessionSecret, prefs.claude_key);
  if (!apiKey) return { error: "Your saved Claude API key couldn't be read. Paste it again." };

  let emails = [], resume = null;
  const gm = await gmailStatus(db, uid);
  if (gm.connected) {
    const row = await db.prepare("SELECT id, gmail_token FROM users WHERE id=?").bind(uid).first();
    const token = await accessToken(db, cfg, row);
    if (!token) return { error: "MailSpy couldn't open your Gmail. Sign in with Google again in Settings." };
    emails = await collectEmails(db, token, uid, gm.email.toLowerCase());
    if (!upload) resume = await findResume(token);
  } else if (!upload) {
    return { error: "Connect Gmail (Sign in with Google) so MailSpy can read your sent emails, or upload your resume." };
  }
  if (upload) {
    if (upload.size > MAX_PDF) return { error: "That PDF is over 4.5 MB. Try a smaller export of your resume." };
    resume = { name: upload.name || "resume.pdf", data: bytesToB64(await upload.arrayBuffer()) };
  }
  if (!emails.length && !resume) return { error: "Didn't find any emails you wrote or a resume to learn from." };

  const content = [];
  if (resume) content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: resume.data }, title: resume.name });
  content.push({ type: "text", text: learnPrompt(emails, resume && resume.name) });

  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 120_000 });
  let res;
  try {
    res = await client.beta.messages.create({
      model: DRAFT_MODEL,
      max_tokens: 16000,
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      messages: [{ role: "user", content }],
    });
  } catch (e) {
    return { error: apiError(e) };
  }
  if (res.stop_reason === "refusal") return { error: "Claude declined to read these. Try again, or write About you yourself." };
  let out;
  try { out = JSON.parse(res.content.filter(b => b.type === "text").map(b => b.text).join("")); }
  catch { return { error: "Claude's answer was cut off or unreadable. Try again." }; }

  const picks = [...new Set((out.examples || []).map(Number))].filter(n => n >= 1 && n <= emails.length).slice(0, 3);
  return {
    ai_resume: String(out.about || "").trim().slice(0, 2500),
    ai_style: String(out.style || "").trim().slice(0, 2000),
    ai_examples: picks.map(n => ({ subject: emails[n - 1].subject, body: emails[n - 1].body.slice(0, 1800), status: emails[n - 1].status })),
    ai_learned: { at: Math.floor(Date.now() / 1000), emails: emails.length, resume: resume ? String(resume.name).slice(0, 120) : "" },
  };
}
