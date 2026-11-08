// Tracked PDFs and standalone tracked links.
//
// PDFs live in the DOCS KV namespace (key "doc:<token>"). The viewer page at
// /d/<token> renders the PDF and sends small "heartbeats" while it's on screen,
// so a view is only counted when a real browser shows the document (scanners
// that just fetch the page never send one). Each heartbeat adds the seconds
// spent on each page.

import { now, shortCode } from "./util.js";
import { isScanner, alertStmt } from "./tracking.js";
import { prefsFor } from "./prefs.js";

export const MAX_PDF_BYTES = 15 * 1024 * 1024;

function isPdf(bytes) {
  const b = new Uint8Array(bytes.slice(0, 5));
  return b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d; // %PDF-
}

function cleanName(name) {
  let n = String(name || "document.pdf").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
  if (!/\.pdf$/i.test(n)) n += ".pdf";
  return n;
}

// ---------------------------------------------------------------- documents
export async function uploadDoc(env, base, userId, filename, bytes) {
  if (!env.DOCS) return { error: "Document storage isn't set up on this server." };
  if (!bytes || !bytes.byteLength) return { error: "That file is empty." };
  if (bytes.byteLength > MAX_PDF_BYTES) return { error: "PDFs can be up to 15 MB." };
  if (!isPdf(bytes)) return { error: "That file isn't a PDF." };
  const token = shortCode(8);
  const name = cleanName(filename);
  await env.DOCS.put(`doc:${token}`, bytes, { metadata: { filename: name } });
  const res = await env.DB.prepare("INSERT INTO docs(user_id,token,filename,size,created_at) VALUES(?,?,?,?,?)")
    .bind(userId, token, name, bytes.byteLength, now()).run();
  return { id: res.meta.last_row_id, token, url: `${base}/${token}`, filename: name, size: bytes.byteLength };
}

export async function deleteDoc(env, userId, id) {
  const db = env.DB;
  const d = await db.prepare("SELECT id, token FROM docs WHERE id=? AND user_id=?").bind(id, userId).first();
  if (!d) return false;
  if (env.DOCS) {
    await env.DOCS.delete(`doc:${d.token}`);
    await env.DOCS.delete(`thumb:${d.token}`);
  }
  await db.batch([
    db.prepare("DELETE FROM doc_views WHERE doc_id=?").bind(d.id),
    db.prepare("DELETE FROM docs WHERE id=?").bind(d.id),
  ]);
  return true;
}

// Heartbeat from the viewer. body: { view?, r?, pages?, secs: { "<page>": seconds } }
export async function docBeat(env, cfg, req, doc, body, viewerUserId) {
  const db = env.DB;
  const t = now();
  const pages = Math.min(5000, Math.max(0, parseInt(body.pages, 10) || 0));
  // Accept at most ~30 seconds per beat, on real page numbers.
  const delta = {};
  let total = 0;
  for (const [k, v] of Object.entries(body.secs || {})) {
    const pg = parseInt(k, 10), s = Math.round(Number(v));
    if (!(pg >= 1 && pg <= (pages || 5000)) || !(s > 0)) continue;
    const add = Math.min(s, 30 - total);
    if (add <= 0) break;
    delta[pg] = (delta[pg] || 0) + add;
    total += add;
  }
  const stmts = [];
  if (pages && !doc.pages) stmts.push(db.prepare("UPDATE docs SET pages=? WHERE id=?").bind(pages, doc.id));

  const viewId = parseInt(body.view, 10);
  if (viewId) {
    const v = await db.prepare("SELECT id, pages_json, last_ts FROM doc_views WHERE id=? AND doc_id=?").bind(viewId, doc.id).first();
    if (v && v.last_ts > t - 86400) {
      const merged = JSON.parse(v.pages_json || "{}");
      for (const [pg, s] of Object.entries(delta)) merged[pg] = (merged[pg] || 0) + s;
      stmts.push(db.prepare("UPDATE doc_views SET seconds=seconds+?, pages_json=?, last_ts=? WHERE id=?")
        .bind(total, JSON.stringify(merged), t, v.id));
      if (stmts.length) await db.batch(stmts);
      return { view: v.id };
    }
  }

  // First heartbeat: this is a view.
  const ip = req.headers.get("CF-Connecting-IP") || "";
  const ua = req.headers.get("User-Agent") || "";
  const prefs = await prefsFor(db, cfg, doc.user_id);
  const email = body.r
    ? await db.prepare("SELECT id, to_addr, to_name FROM emails WHERE token=? AND user_id=?").bind(String(body.r), doc.user_id).first()
    : null;
  const isSelf = viewerUserId === doc.user_id || cfg.ignoreIps.has(ip) || prefs.ignore_ips.includes(ip.toLowerCase()) ? 1 : 0;
  const cf = req.cf || {};
  const geo = [cf.city, cf.country].filter(Boolean).join(", ");
  const res = await db.prepare(
    `INSERT INTO doc_views(doc_id,email_id,ts,last_ts,ip,user_agent,geo,is_self,seconds,pages_json)
     VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .bind(doc.id, email ? email.id : null, t, t, ip, ua, geo, isSelf, total, JSON.stringify(delta)).run();
  if (!isSelf) {
    const who = email ? (email.to_name || email.to_addr) : "Someone";
    stmts.push(alertStmt(db, email ? email.id : null, "doc",
      `${who} is viewing "${doc.filename}"${geo ? ` from ${geo}` : ""}`, t, doc.user_id));
  }
  if (stmts.length) await db.batch(stmts);
  return { view: res.meta.last_row_id };
}

// ---------------------------------------------------------------- tracked links
export function normalizeUrl(raw) {
  let u = String(raw || "").trim();
  if (!u) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = "https://" + u;
  try {
    const p = new URL(u);
    if (p.protocol !== "http:" && p.protocol !== "https:") return null;
    return p.href;
  } catch {
    return null;
  }
}

export async function createLink(db, userId, url, label) {
  const href = normalizeUrl(url);
  if (!href) return { error: "Enter a valid web address." };
  const token = shortCode(7);
  const res = await db.prepare("INSERT INTO tlinks(user_id,token,url,label,created_at) VALUES(?,?,?,?,?)")
    .bind(userId, token, href, String(label || "").trim().slice(0, 120) || null, now()).run();
  return { id: res.meta.last_row_id, token, url: href };
}

export async function deleteLink(db, userId, id) {
  const l = await db.prepare("SELECT id FROM tlinks WHERE id=? AND user_id=?").bind(id, userId).first();
  if (!l) return false;
  await db.batch([
    db.prepare("DELETE FROM tlink_clicks WHERE tlink_id=?").bind(l.id),
    db.prepare("DELETE FROM tlinks WHERE id=?").bind(l.id),
  ]);
  return true;
}

export async function recordLinkClick(db, cfg, req, link) {
  const ip = req.headers.get("CF-Connecting-IP") || "";
  const ua = req.headers.get("User-Agent") || "";
  const prefs = await prefsFor(db, cfg, link.user_id);
  if (cfg.ignoreIps.has(ip) || prefs.ignore_ips.includes(ip.toLowerCase())) return;
  const t = now();
  // the same browser re-requesting within 5 seconds counts once
  const dup = await db.prepare("SELECT 1 AS x FROM tlink_clicks WHERE tlink_id=? AND ip=? AND user_agent=? AND ts>? LIMIT 1")
    .bind(link.id, ip, ua, t - 5).first();
  if (dup) return;
  const bot = isScanner(ua) ? 1 : 0;
  const cf = req.cf || {};
  const geo = [cf.city, cf.country].filter(Boolean).join(", ");
  const stmts = [db.prepare("INSERT INTO tlink_clicks(tlink_id,ts,ip,user_agent,geo,is_bot) VALUES(?,?,?,?,?,?)")
    .bind(link.id, t, ip, ua, geo, bot)];
  if (!bot) {
    stmts.push(alertStmt(db, null, "link",
      `Someone clicked your link "${link.label || link.url}"${geo ? ` from ${geo}` : ""}`, t, link.user_id));
  }
  await db.batch(stmts);
}

// ---------------------------------------------------------------- thumbnails
// A small picture of a PDF's first page, drawn by the extension when you send,
// and shown on the attachment-style tile in the email.
export const MAX_THUMB_BYTES = 300 * 1024;

function imageType(bytes) {
  const b = new Uint8Array(bytes.slice(0, 4));
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  return "";
}

export async function saveThumb(env, userId, id, bytes) {
  if (!env.DOCS) return { error: "Document storage isn't set up on this server." };
  const d = await env.DB.prepare("SELECT token FROM docs WHERE id=? AND user_id=?").bind(id, userId).first();
  if (!d) return { error: "Document not found." };
  if (!bytes || !bytes.byteLength || bytes.byteLength > MAX_THUMB_BYTES) return { error: "Thumbnail too large." };
  const type = imageType(bytes);
  if (!type) return { error: "Thumbnail must be a PNG or JPEG." };
  await env.DOCS.put(`thumb:${d.token}`, bytes, { metadata: { type } });
  return { ok: true };
}

export async function thumbResponse(env, token) {
  if (!env.DOCS) return null;
  const r = await env.DOCS.getWithMetadata(`thumb:${token}`, { type: "arrayBuffer" });
  if (!r || !r.value) return null;
  return new Response(r.value, { headers: {
    "Content-Type": (r.metadata && r.metadata.type) || "image/png",
    "Cache-Control": "public, max-age=86400", "X-Robots-Tag": "noindex",
  } });
}
