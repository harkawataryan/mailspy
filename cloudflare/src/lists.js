// The Emails list on the dashboard: search, filters and pages (all read from the
// URL, so any view can be bookmarked), plus CSV downloads of the lists.
// Every query here is limited to one user's data (user_id is always bound).

import { now } from "./util.js";

export const PAGE_SIZE = 100;
const MAX_CSV_ROWS = 20000;
const MAX_TERMS = 6;

// Status filters, in the order they appear on the dashboard. `sql` is a condition
// on the emails row `e`; `t` is the current unix time (a number, safe to inline).
const scheduled = t => `(COALESCE(e.scheduled_at,0)=-1 OR COALESCE(e.scheduled_at,0)>${Math.floor(t)})`;
export const STATUSES = [
  { key: "replied",   label: "Replied",    sql: () => "e.replied_at IS NOT NULL" },
  { key: "opened",    label: "Opened",     sql: () => "e.opens>0" },
  { key: "unopened",  label: "Not opened", sql: t => `e.opens=0 AND NOT ${scheduled(t)}` },
  { key: "clicked",   label: "Clicked",    sql: () => "e.clicks>0" },
  { key: "scheduled", label: "Scheduled",  sql: scheduled },
];

// Sort orders for the list. Latest activity (the default) is the newest of: sent,
// last real open, last real click, reply. Ties fall back to the newest email.
export const SORTS = [
  { key: "",       label: "Latest activity", sql: "activity_at DESC" },
  { key: "sent",   label: "Newest sent",     sql: "sent_at DESC" },
  { key: "oldest", label: "Oldest sent",     sql: "sent_at ASC" },
  { key: "opens",  label: "Most opens",      sql: "e.opens DESC, activity_at DESC" },
  { key: "clicks", label: "Most clicks",     sql: "e.clicks DESC, activity_at DESC" },
];
// Extra columns for each row: when it went out, its last real click, and latest activity.
export function listCols(t = now()) {
  const sent = `(CASE WHEN e.scheduled_at>0 AND e.scheduled_at<=${Math.floor(t)} THEN e.scheduled_at ELSE e.created_at END)`;
  const click = "(SELECT MAX(v.ts) FROM events v WHERE v.email_id=e.id AND v.kind='click' AND v.is_bot=0)";
  return `e.*, ${sent} AS sent_at, ${click} AS last_click,
    MAX(${sent}, COALESCE(e.last_open,0), COALESCE(${click},0), COALESCE(e.replied_at,0)) AS activity_at`;
}

export const RANGES = [["", "All time"], ["7", "Last 7 days"], ["30", "Last 30 days"], ["90", "Last 90 days"]];

// Filters from the query string; anything unknown is ignored.
export function readFilters(params) {
  const status = String(params.get("status") || "");
  const days = String(params.get("days") || "");
  const sort = String(params.get("sort") || "");
  const page = parseInt(params.get("page") || "1", 10);
  return {
    q: String(params.get("q") || "").trim().replace(/\s+/g, " ").slice(0, 200),
    status: STATUSES.some(s => s.key === status) ? status : "",
    days: RANGES.some(([k]) => k && k === days) ? days : "",
    sort: SORTS.some(s => s.key && s.key === sort) ? sort : "",
    page: Number.isFinite(page) && page > 1 ? Math.min(page, 100000) : 1,
  };
}

// The query string for a view, with some values changed (page resets unless given).
export function filterQuery(f, change = {}) {
  const v = { ...f, page: 1, ...change };
  const p = new URLSearchParams();
  if (v.q) p.set("q", v.q);
  if (v.status) p.set("status", v.status);
  if (v.days) p.set("days", v.days);
  if (v.sort) p.set("sort", v.sort);
  if (v.page > 1) p.set("page", String(v.page));
  const s = p.toString();
  return s ? `?${s}` : "";
}

const likeEsc = s => s.replace(/[\\%_]/g, c => "\\" + c);

// WHERE clause + bound values for a user's emails under these filters.
// Search: every word must appear in the subject, recipient name or address
// (the address covers the company domain, e.g. "stripe" or "@stripe.com").
export function emailWhere(uid, f, t = now()) {
  const parts = ["e.user_id=?", "e.bounced_at IS NULL"], args = [uid];
  for (const term of (f.q ? f.q.split(" ") : []).slice(0, MAX_TERMS)) {
    const like = `%${likeEsc(term)}%`;
    parts.push("(e.subject LIKE ? ESCAPE '\\' OR COALESCE(e.to_name,'') LIKE ? ESCAPE '\\' OR e.to_addr LIKE ? ESCAPE '\\')");
    args.push(like, like, like);
  }
  const st = STATUSES.find(s => s.key === f.status);
  if (st) parts.push(`(${st.sql(t)})`);
  if (f.days) { parts.push("e.created_at>=?"); args.push(t - Number(f.days) * 86400); }
  return { where: parts.join(" AND "), args };
}

// One page of the dashboard list, and how many emails match in all.
export async function emailListPage(db, uid, f) {
  const { where, args } = emailWhere(uid, f);
  const order = (SORTS.find(s => s.key === (f.sort || "")) || SORTS[0]).sql;
  const [rows, count] = await db.batch([
    db.prepare(`SELECT ${listCols()} FROM emails e WHERE ${where} ORDER BY ${order}, e.id DESC LIMIT ? OFFSET ?`)
      .bind(...args, PAGE_SIZE, (f.page - 1) * PAGE_SIZE),
    db.prepare(`SELECT COUNT(*) AS n FROM emails e WHERE ${where}`).bind(...args),
  ]);
  return { emails: rows.results, matched: count.results[0].n };
}

export const DOCS_SQL = `SELECT d.*,
    (SELECT COUNT(*) FROM doc_views v WHERE v.doc_id=d.id AND v.is_self=0) AS views,
    (SELECT SUM(seconds) FROM doc_views v WHERE v.doc_id=d.id AND v.is_self=0) AS seconds,
    (SELECT MAX(ts) FROM doc_views v WHERE v.doc_id=d.id AND v.is_self=0) AS last_view
  FROM docs d WHERE d.user_id=? ORDER BY d.id DESC`;

export const LINKS_SQL = `SELECT l.*,
    (SELECT COUNT(*) FROM tlink_clicks c WHERE c.tlink_id=l.id AND c.is_bot=0) AS clicks,
    (SELECT MAX(ts) FROM tlink_clicks c WHERE c.tlink_id=l.id AND c.is_bot=0) AS last_click
  FROM tlinks l WHERE l.user_id=? ORDER BY l.id DESC`;

// ---------- CSV ----------

// One cell. Text that a spreadsheet would run as a formula (= + - @, or a
// leading tab/CR) gets an apostrophe in front; numbers are left alone.
export function csvCell(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// UTF-8 with a byte-order mark so Excel reads accents and emoji correctly.
export function toCsv(header, rows) {
  return "﻿" + [header, ...rows].map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function csvResponse(name, header, rows) {
  const file = `mailspy-${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  return new Response(toCsv(header, rows), { headers: {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${file}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex",
  } });
}

// Times in UTC, in a form spreadsheets recognise as a date.
export function csvTime(ts) {
  return ts && ts > 0 ? new Date(ts * 1000).toISOString().slice(0, 19).replace("T", " ") : "";
}

function statusLabel(e, t) {
  if (e.scheduled_at === -1 || (e.scheduled_at && e.scheduled_at > t)) return "Scheduled";
  return e.opens > 0 ? "Opened" : "Not opened";
}

export async function emailsCsv(db, uid, f) {
  const { where, args } = emailWhere(uid, f);
  const r = await db.prepare(`SELECT e.* FROM emails e WHERE ${where} ORDER BY e.id DESC LIMIT ?`)
    .bind(...args, MAX_CSV_ROWS).all();
  const t = now();
  return csvResponse("emails",
    ["Sent (UTC)", "Recipient", "Name", "Subject", "Status", "Opens", "Clicks", "First open (UTC)", "Last open (UTC)"],
    r.results.map(e => [csvTime(e.scheduled_at > 0 ? e.scheduled_at : e.created_at), e.to_addr, e.to_name || "", e.subject,
      statusLabel(e, t), e.opens || 0, e.clicks || 0, csvTime(e.first_open), csvTime(e.last_open)]));
}

const WHY = { prefetch: "Image loaded right after sending", scanner: "Security scanner", self: "You viewed it", quoted: "Loaded with a later reply (quoted)" };

// Every open and click on one email, automated ones marked as not counted.
export function emailEventsCsv(email, events, classify) {
  return csvResponse(`email-${email.id}`,
    ["Time (UTC)", "Event", "Counted", "Note", "Client", "Location", "Link"],
    events.map(v => [csvTime(v.ts), v.kind === "open" ? "Open" : "Click", v.is_bot ? "No" : "Yes",
      v.is_bot ? (WHY[v.flagged] || "Automated") : "", classify(v.user_agent), v.geo || "", v.url || ""]));
}

export function docsCsv(docs, base) {
  return csvResponse("documents",
    ["Uploaded (UTC)", "File", "Size (bytes)", "Pages", "Views", "Time viewed (seconds)", "Last viewed (UTC)", "Link"],
    docs.map(d => [csvTime(d.created_at), d.filename, d.size, d.pages ?? "", d.views || 0, d.seconds || 0,
      csvTime(d.last_view), `${base}/${d.token}`]));
}

export function linksCsv(links, base) {
  return csvResponse("links",
    ["Created (UTC)", "Label", "Goes to", "Short link", "Clicks", "Last click (UTC)"],
    links.map(l => [csvTime(l.created_at), l.label || "", l.url, `${base}/${l.token}`, l.clicks || 0, csvTime(l.last_click)]));
}
