// Hide tracking from your own Sent copy.
//
// Opening your own sent email on your phone (the Gmail app, or Gmail in any
// browser without the extension) loads the tracking image through Google's
// image proxy, which looks exactly like the recipient opening it. The
// extension can only catch that in desktop Chrome (/api/selfview). So with
// Gmail connected and "Hide tracking from my own Sent copy" on (the default),
// once a tracked email is in Sent MailSpy swaps your Sent copy for an
// identical one without the image:
//   1. messages.get?format=minimal: still a sent message (SENT, not in Trash),
//      not too big, and which conversation it's in;
//   2. messages.get?format=raw, and take out MailSpy's tracking image(s). Only
//      the HTML part(s) change; headers (Message-ID, References, Subject, Date),
//      other parts and attachments stay byte for byte, so replies still thread
//      onto it;
//   3. messages.insert the copy into the same conversation, with the same labels
//      and date (internalDateSource=dateHeader). insert is like IMAP APPEND:
//      nothing is sent to anyone;
//   4. move the original to Trash (gmail.modify can't delete for good), and
//      point emails.gmail_msg at the copy so ✔ / ✔✔ follow it.
// If anything fails the original is left as it was, and a copy that was already
// inserted goes back to Trash. Tracked links in the copy stay as they are:
// clicking one yourself still counts as a click.
//
// Not while auto-try is still watching for a bounce (retry.js resends from the
// Sent copy's raw message, which needs the image): the scheduled sweep does it
// once that's over. If a late bounce turns up after the swap, retry.js resends
// from the original (still readable in Trash) and trashes the copy too.
//
// Progress is kept in emails.sent_clean, so an interrupted run (a Worker can be
// stopped part-way) carries on instead of making a second copy:
//   NULL                   to do
//   work:<ts>:<n>          someone's on it (attempt n), since ts
//   copy:<id>:<ts>:<n>     copy <id> inserted, original not in Trash yet
//   err:<n>                attempt n failed, nothing left over; tried again later
//   done | none | big | failed
//     done: swapped. none: no tracking image of this email in it, or not a sent
//     message. big: over MAX_BYTES, left alone. failed: gave up after MAX_TRIES.

import { now } from "./util.js";
import { googleEnabled, ensureGoogleSchema, accessToken, gmail, labelEmail } from "./google.js";
import { readPrefs } from "./prefs.js";

// Big raw messages cost Worker CPU to decode and re-encode, and a JSON upload
// of the raw message has to stay well under Gmail's ~5 MB simple-upload size.
// Emails with large attachments keep the tracking image in Sent.
export const MAX_BYTES = 2_000_000;
const MAX_TRIES = 3;
const STALE = 600;          // a claim older than this (seconds) was interrupted
const DAYS = 14;            // the sweep looks at emails sent in the last two weeks
const DROP_LABELS = new Set(["DRAFT", "TRASH", "SPAM", "CHAT"]);

// ------------------------------------------------------------------ raw mail
const b64urlToBin = s => atob(s.replace(/-/g, "+").replace(/_/g, "/"));
const binToB64url = s => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function header(head, name) {
  const m = head.replace(/\r?\n[ \t]+/g, " ").match(new RegExp(`^${name}[ \\t]*:[ \\t]*(.*)$`, "im"));
  return m ? m[1].trim() : "";
}
function param(value, name) {
  const m = value.match(new RegExp(`;\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i"));
  return m ? (m[1] !== undefined ? m[1] : m[2]) : "";
}

function qpDecode(s) {
  return s.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
function qpEncode(s, NL) {
  const hex = c => "=" + c.toString(16).toUpperCase().padStart(2, "0");
  return s.split(NL).map(line => {
    let out = "", cur = "";
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      let tok = c === 61 || c > 126 || (c < 32 && c !== 9) ? hex(c) : line[i];
      if ((c === 32 || c === 9) && i === line.length - 1) tok = hex(c);   // no bare space at a line end
      if (cur.length + tok.length > 75) { out += cur + "=" + NL; cur = ""; }
      cur += tok;
    }
    return out + cur;
  }).join(NL);
}
const b64wrap = (s, NL) => (s.match(/.{1,76}/g) || []).join(NL);

// Split a MIME entity into [headers, separator, body]; body null if there's no blank line.
function splitEntity(entity, NL) {
  if (entity.startsWith(NL)) return ["", NL, entity.slice(NL.length)];   // no headers at all
  const i = entity.indexOf(NL + NL);
  return i < 0 ? [entity, "", null] : [entity.slice(0, i), NL + NL, entity.slice(i + 2 * NL.length)];
}

// Rewrite the text/html parts of an entity with strip(); null if nothing changed.
function rewrite(entity, NL, strip, depth = 0) {
  const [head, sep, body] = splitEntity(entity, NL);
  if (body === null || depth > 12) return null;
  const ct = header(head, "Content-Type");
  const type = (ct.split(";")[0] || "text/plain").trim().toLowerCase();
  if (type.startsWith("multipart/")) {
    const boundary = param(ct, "boundary");
    if (!boundary) return null;
    const delim = NL + "--" + boundary;
    const chunks = (NL + body).split(delim);
    let changed = false;
    for (let j = 1; j < chunks.length; j++) {
      const c = chunks[j];
      if (c.startsWith("--")) break;                       // closing delimiter, then the epilogue
      const k = c.indexOf(NL);
      if (k < 0) continue;
      const out = rewrite(c.slice(k + NL.length), NL, strip, depth + 1);
      if (out !== null) { chunks[j] = c.slice(0, k + NL.length) + out; changed = true; }
    }
    return changed ? head + sep + chunks.join(delim).slice(NL.length) : null;
  }
  // Only the message's own HTML; attached .html files and forwarded messages are left alone.
  if (type !== "text/html" || /^\s*attachment/i.test(header(head, "Content-Disposition"))) return null;
  const cte = header(head, "Content-Transfer-Encoding").toLowerCase();
  const tail = (body.match(/(?:\r?\n)*$/) || [""])[0];
  const core = body.slice(0, body.length - tail.length);
  let text;
  if (cte === "base64") text = atob(core.replace(/[^A-Za-z0-9+/=]/g, ""));
  else if (cte === "quoted-printable") text = qpDecode(core);
  else text = core;
  const out = strip(text);
  if (out === text) return null;
  const enc = cte === "base64" ? b64wrap(btoa(out), NL) : cte === "quoted-printable" ? qpEncode(out, NL) : out;
  return head + sep + enc + tail;
}

// <img> tags pointing at a MailSpy open pixel: this email's (on any address) and,
// for hosts we know are ours, any email's (e.g. an earlier one quoted in a reply).
function pixelRe(token, hosts) {
  const names = [...new Set(hosts.filter(Boolean).map(h => String(h).replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase()))];
  const mine = `[^"'\\s>]*\\/(?:img|t)\\/${escRe(token)}`;
  const ours = names.length ? `|(?:https?:)?\\/\\/(?:${names.map(escRe).join("|")})\\/(?:img|t)\\/[A-Za-z0-9_-]+` : "";
  return new RegExp(`<img\\b[^>]*?\\bsrc\\s*=\\s*(["']?)(?:${mine}${ours})(?:\\.gif|\\.png)?\\1(?=[\\s/>])[^>]*>`, "gi");
}

// The raw message (a binary string) without MailSpy's tracking image.
// mine: whether this email's own pixel was in it (if not, it's not our message).
export function stripPixels(raw, token, hosts = []) {
  const NL = raw.includes("\r\n") ? "\r\n" : "\n";
  const re = pixelRe(token, hosts);
  let removed = 0, mine = false;
  const strip = text => text.replace(re, m => { removed++; if (m.includes(token)) mine = true; return ""; });
  const out = rewrite(raw, NL, strip);
  return { raw: out === null ? raw : out, removed, mine };
}

// ------------------------------------------------------------------ state
function parseState(st) {
  const [kind = "", ...rest] = String(st || "").split(":");
  if (kind === "work") return { kind, ts: Number(rest[0]) || 0, n: Number(rest[1]) || 1 };
  if (kind === "copy") return { kind, copy: rest[0], ts: Number(rest[1]) || 0, n: Number(rest[2]) || 1 };
  if (kind === "err") return { kind, n: Number(rest[0]) || 1 };
  return { kind: kind || null };
}
// Can a run start (or carry on) now?
function claimable(st, t) {
  const s = parseState(st);
  if (s.kind === null || s.kind === "err") return true;
  return (s.kind === "work" || s.kind === "copy") && t - s.ts > STALE;
}
function watching(retryJson) {
  if (!retryJson) return false;
  try { return JSON.parse(retryJson).state === "watching"; } catch { return false; }
}
export const hostsOf = cfg => [cfg.trackUrl, cfg.baseUrl].filter(Boolean);

// ------------------------------------------------------------------ the swap
// Returns what happened: done | none | big | failed | error | wait | off | busy
export async function hideTracking(env, cfg, emailId, hosts = hostsOf(cfg)) {
  if (!googleEnabled(cfg)) return "off";
  const db = env.DB;
  await ensureGoogleSchema(db);
  const e = await db.prepare(`SELECT e.id, e.token, e.user_id, e.gmail_msg, e.retry_json, e.sent_clean, u.gmail_token, u.prefs
    FROM emails e JOIN users u ON u.id = e.user_id WHERE e.id=?`).bind(emailId).first();
  if (!e || !e.gmail_token) return "off";
  if (!readPrefs(cfg, e.prefs).hide_sent_pixel) return "off";
  if (!e.gmail_msg || watching(e.retry_json)) return "wait";   // not found in Sent yet / auto-try still needs it
  const t = Math.floor(now());
  if (!claimable(e.sent_clean, t)) return parseState(e.sent_clean).kind === "work" ? "busy" : e.sent_clean;

  const prev = parseState(e.sent_clean);
  const n = prev.kind === "err" ? prev.n + 1 : prev.kind === "work" || prev.kind === "copy" ? prev.n + 1 : 1;
  const set = st => db.prepare("UPDATE emails SET sent_clean=? WHERE id=?").bind(st, e.id).run();
  if (n > MAX_TRIES) { await set("failed"); return "failed"; }
  let copyId = prev.kind === "copy" ? prev.copy : null;
  const claim = copyId ? `copy:${copyId}:${t}:${n}` : `work:${t}:${n}`;
  const got = await db.prepare("UPDATE emails SET sent_clean=? WHERE id=? AND COALESCE(sent_clean, '')=?")
    .bind(claim, e.id, e.sent_clean || "").run();
  if (!got.meta.changes) return "busy";                      // another run got there first

  const token = await accessToken(db, cfg, { id: e.user_id, gmail_token: e.gmail_token });
  if (!token) { await set(e.sent_clean ?? null); return "wait"; }
  const orig = e.gmail_msg;
  let origGone = false;                                       // original already in Trash: from here on, keep the copy
  try {
    const meta = await gmail(token, `/messages/${orig}?format=minimal`);
    if (!meta) {
      // Gone from Gmail: let the label sweep find the Sent copy again.
      await db.prepare("UPDATE emails SET gmail_msg=NULL, gmail_label=NULL, sent_clean=NULL WHERE id=?").bind(e.id).run();
      return "wait";
    }
    const labels = meta.labelIds || [];
    if (copyId) {
      // An earlier run inserted the copy and stopped: use it if it's still there, in the right conversation.
      const c = await gmail(token, `/messages/${copyId}?format=minimal`);
      if (!c || (c.labelIds || []).includes("TRASH") || c.threadId !== meta.threadId) copyId = null;
    }
    // (An original already in Trash with a good copy: that run stopped right after trashing it.)
    const trashed = labels.includes("TRASH");
    if (!(copyId && trashed) && (!labels.includes("SENT") || trashed || labels.includes("DRAFT"))) { await set("none"); return "none"; }
    origGone = trashed;
    if (!copyId) {
      if (Number(meta.sizeEstimate) > MAX_BYTES) { await set("big"); return "big"; }
      const full = await gmail(token, `/messages/${orig}?format=raw`);
      if (!full || !full.raw) throw new Error("no raw message");
      if (full.raw.length * 0.75 > MAX_BYTES * 1.25) { await set("big"); return "big"; }   // in case sizeEstimate was missing
      const res = stripPixels(b64urlToBin(full.raw), e.token, hosts);
      if (!res.mine) { await set("none"); return "none"; }   // not this email's message after all
      const ins = await gmail(token, "/messages?internalDateSource=dateHeader", { method: "POST",
        body: JSON.stringify({ raw: binToB64url(res.raw), threadId: meta.threadId, labelIds: labels.filter(l => !DROP_LABELS.has(l)) }) });
      if (!ins || !ins.id || ins.id === orig) throw new Error("insert returned no new message");
      copyId = ins.id;
      if (ins.threadId && ins.threadId !== meta.threadId) throw new Error("copy landed in another conversation");
      await set(`copy:${copyId}:${t}:${n}`);                 // so an interrupted run carries on with this copy
    }
    if (!trashed) await gmail(token, `/messages/${orig}/trash`, { method: "POST" });
    origGone = true;
    // Every tracked email that pointed at the original now points at the copy (normally just this one).
    await db.batch([
      db.prepare("UPDATE emails SET gmail_msg=?, gmail_label=NULL WHERE user_id=? AND gmail_msg=?").bind(copyId, e.user_id, orig),
      db.prepare("UPDATE emails SET sent_clean='done' WHERE id=?").bind(e.id),
    ]);
  } catch (err) {
    console.error("sent copy:", err);
    // Put things back: the original stays, the copy goes to Trash. (If the original
    // is already in Trash, keep the copy and finish next time instead.)
    let left = copyId;
    if (left && !origGone) { try { await gmail(token, `/messages/${left}/trash`, { method: "POST" }); left = null; } catch {} }
    await set(left ? `copy:${left}:0:${n}` : n >= MAX_TRIES ? "failed" : `err:${n}`).catch(() => {});
    return "error";
  }
  // ✔ / ✔✔ onto the copy (it inherited the original's labels; this makes sure they're current).
  await labelEmail(env, cfg, e.id).catch(err => console.error("gmail label:", err));
  return "done";
}

// Scheduled: pick up what the post-send hook couldn't (auto-try emails once it's
// done, scheduled sends, retries after an error). One email per run keeps the
// Gmail calls small (about six), next to the label and auto-try sweeps.
export async function sweepSentCopies(env, cfg, limit = 1) {
  if (!googleEnabled(cfg)) return;
  const db = env.DB;
  await ensureGoogleSchema(db);
  const t = now();
  const rows = await db.prepare(`SELECT e.id, e.sent_clean FROM emails e JOIN users u ON u.id = e.user_id
    WHERE u.gmail_token IS NOT NULL AND e.gmail_msg IS NOT NULL AND e.created_at > ?
      AND COALESCE(json_extract(u.prefs, '$.hide_sent_pixel'), 1) != 0
      AND (e.retry_json IS NULL OR COALESCE(json_extract(e.retry_json, '$.state'), '') != 'watching')
      AND (e.sent_clean IS NULL OR e.sent_clean LIKE 'err:%' OR e.sent_clean LIKE 'work:%' OR e.sent_clean LIKE 'copy:%')
    ORDER BY e.id DESC LIMIT 20`).bind(t - DAYS * 86400).all();
  let done = 0;
  for (const r of rows.results) {
    if (done >= limit) break;
    if (!claimable(r.sent_clean, Math.floor(t))) continue;
    await hideTracking(env, cfg, r.id);
    done++;
  }
}
