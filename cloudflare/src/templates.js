// Email templates.
//
// A template is a subject and body you can drop into any Gmail compose window.
// It can use placeholders, filled in from the recipient when it's inserted:
//   {first_name} {last_name} {full_name} {company} {my_name}
// and it can be meant for anyone, for one company (by email domain), or for
// one person (by email address). When you write to someone, templates for
// that person come first, then ones for their company, then the rest.

import { now } from "./util.js";

export const VARS = [
  ["{first_name}", "First name"],
  ["{last_name}", "Last name"],
  ["{full_name}", "Full name"],
  ["{company}", "Company"],
  ["{my_name}", "Your name"],
];

const WEBMAIL = /^(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|msn|icloud|me|mac|aol|proton|protonmail|pm|gmx|zoho|yandex|mail|fastmail|hey)\./i;

// Created on first use, so no manual database step is needed (same as migrations/0007_templates.sql).
let ensured = false;
async function ensureTable(db) {
  if (ensured) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS templates (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      name        TEXT NOT NULL,
      subject     TEXT NOT NULL DEFAULT '',
      body        TEXT NOT NULL DEFAULT '',
      scope_type  TEXT NOT NULL DEFAULT 'any',
      scope_value TEXT NOT NULL DEFAULT '',
      uses        INTEGER NOT NULL DEFAULT 0,
      created_at  REAL NOT NULL,
      updated_at  REAL NOT NULL,
      last_used   REAL)`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_templates_user ON templates(user_id, updated_at)"),
  ]);
  ensured = true;
}

// Keep template HTML to ordinary formatting: no scripts, styles, frames,
// forms, event handlers or javascript: links.
export function cleanHtml(html) {
  let s = String(html || "").slice(0, 60000);
  s = s.replace(/<(script|style|iframe|object|embed|noscript|template|svg|math)\b[\s\S]*?<\/\1\s*>/gi, "");
  s = s.replace(/<\/?(script|style|iframe|object|embed|form|input|button|select|textarea|meta|link|base|frame|frameset|noscript|template|svg|math)\b[^>]*>/gi, "");
  s = s.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  s = s.replace(/\s+(href|src|action|formaction|xlink:href)\s*=\s*("|')\s*(javascript|vbscript|data):[^"']*\2/gi, "");
  s = s.replace(/\s+(href|src)\s*=\s*(javascript|vbscript|data):[^\s>]+/gi, "");
  s = s.replace(/\s+data-mailspy-[a-z-]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  return s.trim();
}

function cleanScope(type, value) {
  const v = String(value || "").trim().toLowerCase();
  if (type === "person" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { scope_type: "person", scope_value: v };
  if (type === "company") {
    const d = v.replace(/^.*@/, "").replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[\/?#\s]/)[0];
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) return { scope_type: "company", scope_value: d };
  }
  return { scope_type: "any", scope_value: "" };
}

function cleanInput(data) {
  const name = String(data.name || "").trim().slice(0, 120);
  if (!name) return { error: "Give the template a name." };
  const body = cleanHtml(data.body);
  const subject = String(data.subject || "").replace(/[\r\n]+/g, " ").trim().slice(0, 300);
  if (!body && !subject) return { error: "The template is empty." };
  return { name, subject, body, ...cleanScope(data.scope_type, data.scope_value) };
}

export async function listTemplates(db, userId) {
  await ensureTable(db);
  return (await db.prepare("SELECT * FROM templates WHERE user_id=? ORDER BY updated_at DESC LIMIT 500").bind(userId).all()).results;
}

export async function getTemplate(db, userId, id) {
  await ensureTable(db);
  return db.prepare("SELECT * FROM templates WHERE id=? AND user_id=?").bind(id, userId).first();
}

export async function saveTemplate(db, userId, data, id = null) {
  await ensureTable(db);
  const t = cleanInput(data);
  if (t.error) return t;
  const ts = now();
  if (id) {
    const r = await db.prepare(`UPDATE templates SET name=?, subject=?, body=?, scope_type=?, scope_value=?, updated_at=?
      WHERE id=? AND user_id=?`).bind(t.name, t.subject, t.body, t.scope_type, t.scope_value, ts, id, userId).run();
    return r.meta.changes ? { id, ...t } : { error: "Template not found." };
  }
  const n = (await db.prepare("SELECT COUNT(*) AS n FROM templates WHERE user_id=?").bind(userId).first()).n;
  if (n >= 500) return { error: "You have 500 templates already. Delete some first." };
  const r = await db.prepare(`INSERT INTO templates(user_id,name,subject,body,scope_type,scope_value,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).bind(userId, t.name, t.subject, t.body, t.scope_type, t.scope_value, ts, ts).run();
  return { id: r.meta.last_row_id, ...t };
}

export async function deleteTemplate(db, userId, id) {
  await ensureTable(db);
  return (await db.prepare("DELETE FROM templates WHERE id=? AND user_id=?").bind(id, userId).run()).meta.changes > 0;
}

export async function markUsed(db, userId, id) {
  await ensureTable(db);
  await db.prepare("UPDATE templates SET uses=uses+1, last_used=? WHERE id=? AND user_id=?").bind(now(), id, userId).run();
}

// "stripe.com" -> "Stripe" (or the name Find learned for it); webmail -> ""
export async function companyFor(env, domain) {
  if (!domain || WEBMAIL.test(domain)) return "";
  if (env.DOCS) {
    const known = await env.DOCS.get(`find:org:${domain}`).catch(() => null);
    if (known) return known;
  }
  const label = domain.split(".").slice(-2)[0] || "";
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : "";
}

// Templates for the compose pop-up: matching ones first, flagged with why they match.
export async function templatesFor(env, db, user, to) {
  const list = await listTemplates(db, user.id);
  const email = String(to || "").trim().toLowerCase();
  const domain = email.includes("@") ? email.split("@").pop() : "";
  const rank = t => (t.scope_type === "person" && t.scope_value === email ? 0
    : t.scope_type === "company" && domain && (domain === t.scope_value || domain.endsWith("." + t.scope_value)) ? 1
    : t.scope_type === "any" ? 2 : 3);
  const shown = list.map(t => ({ ...t, match: rank(t) }))
    .sort((a, b) => a.match - b.match || (b.last_used || 0) - (a.last_used || 0) || b.updated_at - a.updated_at);
  return {
    templates: shown.map(t => ({ id: t.id, name: t.name, subject: t.subject, body: t.body,
      scope_type: t.scope_type, scope_value: t.scope_value, match: t.match === 0 ? "person" : t.match === 1 ? "company" : t.match === 3 ? "other" : "" })),
    company: await companyFor(env, domain),
    domain: domain && !WEBMAIL.test(domain) ? domain : "",
    my_name: user.name || "",
  };
}
