// Creating tracked emails, recording opens/clicks, alerts and reminders.

import { now, randomToken, shortCode, esc, decodeEntities } from "./util.js";
import { prefsFor, readPrefs, isIgnoredRecipient } from "./prefs.js";
import { ensureGoogleSchema } from "./google.js";

export const PIXEL_GIF = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), c => c.charCodeAt(0));

const HREF_RE = /(<a\b[^>]*?\bhref\s*=\s*)(["'])(.*?)\2/gis;
const URL_RE = /(?<!["'=>])\b(https?:\/\/[^\s<>"']+)/g;

// Automated fetchers that are never a person reading the email.
const SCANNER_HINTS = [
  "safelinks", "barracuda", "proofpoint", "mimecast", "microsoft-webdriver",
  "bitdefender", "googlebot", "bingbot", "slackbot", "whatsapp", "telegrambot",
  "facebookexternalhit", "twitterbot", "linkedinbot", "discordbot", "skypeuripreview",
  "curl", "wget", "python-requests", "httpclient", "go-http-client", "okhttp",
  "headlesschrome", "phantomjs", "amazonses", "sendgrid", "mailchimp",
];

// Gmail, Yahoo and Outlook.com load images through their own proxies when the
// recipient actually opens the message, so those fetches ARE counted. Automated
// fetches are caught by timing instead: hits within prefetchWindow of sending,
// clicks on several links within 2 seconds, and moments when you are viewing
// the message yourself (reported by the Gmail extension).
const SELF_WINDOW = 20;   // seconds after a self-view during which opens are yours
const SELF_LOOKBACK = 10; // seconds before a self-view to re-flag as yours

export function isScanner(ua) {
  const s = (ua || "").toLowerCase();
  return SCANNER_HINTS.some(h => s.includes(h));
}

export function classifyAgent(ua) {
  const s = (ua || "").toLowerCase();
  if (!s) return "Unknown";
  if (s.includes("googleimageproxy")) return "Gmail";
  if (s.includes("yahoomailproxy") || s.includes("yahoo")) return "Yahoo";
  if (s.includes("outlook") || s.includes("microsoft office") || s.includes("msie")) return "Outlook";
  if (s.includes("iphone") || s.includes("ipad")) return "iPhone/iPad";
  if (s.includes("mac os x") || s.includes("macintosh")) return "Mac";
  if (s.includes("android")) return "Android";
  if (s.includes("windows")) return "Windows";
  if (s.includes("linux")) return "Linux";
  return "Other";
}

function textToHtml(text) {
  const linked = esc(text).replace(URL_RE, u => `<a href="${u}">${u}</a>`);
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;white-space:pre-wrap">${linked}</div>`;
}

// Store the email and return its HTML with the pixel added and links rewritten.
// base is the public tracking address (e.g. https://go.aryanh.dev); appBase is
// the dashboard address, which older tracked-PDF links may still point at.
// Links are only rewritten if you marked them in Gmail (data.track_urls), or
// every link if "Track every link" is on in Settings (minus data.untrack_urls).
export async function prepareEmail(db, base, userId, data, prefs, appBase = base) {
  // Recipients on the user's "don't track" list: send the email untouched.
  if (prefs && isIgnoredRecipient(prefs, data.to)) return { skipped: true };
  const trackAll = !prefs || prefs.track_all_links;
  const urlSet = v => new Set((Array.isArray(v) ? v : []).map(u => String(u).trim()));
  const trackUrls = urlSet(data.track_urls), untrackUrls = urlSet(data.untrack_urls);
  const wantTracked = url => trackAll ? !untrackUrls.has(url) : trackUrls.has(url);
  const isText = !("html" in data);
  const body = isText ? textToHtml(String(data.text || "")) : String(data.html || "");
  const token = randomToken(12);
  // scheduled_at: null = sent now, -1 = scheduled (time unknown), >0 = unix time
  let scheduledAt = null;
  if (data.scheduled_at && Number(data.scheduled_at) > 0) scheduledAt = Number(data.scheduled_at);
  else if (data.scheduled) scheduledAt = -1;
  const res = await db.prepare(
    "INSERT INTO emails(token,to_addr,to_name,subject,created_at,scheduled_at,user_id) VALUES(?,?,?,?,?,?,?)")
    .bind(token, String(data.to || ""), data.to_name ? String(data.to_name) : null,
          String(data.subject || "(no subject)"), now(), scheduledAt, userId)
    .run();
  const emailId = res.meta.last_row_id;

  const inserts = [];
  // Our own addresses: tracked PDFs get tagged with this email; nothing else of ours is wrapped again.
  const ours = [...new Set([base, appBase])].map(b => b + "/");
  const docToken = url => {
    for (const b of ours) {
      if (!url.startsWith(b)) continue;
      const p = url.slice(b.length).split(/[?#]/)[0];
      const mm = p.match(/^(?:d\/)?([A-Za-z0-9_-]{6,})$/);
      return mm ? mm[1] : "";
    }
    return null;
  };
  const candidates = new Set();
  for (const mm of body.matchAll(HREF_RE)) { const t = docToken(decodeEntities(mm[3].trim())); if (t) candidates.add(t); }
  const docTokens = new Set();
  if (candidates.size) {
    const list = [...candidates].slice(0, 50);
    const rows = await db.prepare(`SELECT token FROM docs WHERE user_id=? AND token IN (${list.map(() => "?").join(",")})`)
      .bind(userId, ...list).all();
    for (const r of rows.results) docTokens.add(r.token);
  }
  let tracked = body.replace(HREF_RE, (m, pre, q, raw) => {
    const url = decodeEntities(raw.trim());
    if (!/^https?:\/\//i.test(url)) return m; // mailto:, tel:, #anchors stay as they are
    const own = docToken(url);
    if (own !== null && !docTokens.has(own)) return m; // one of our own links: leave it
    if (own !== null) {
      // A tracked PDF: link straight to the viewer, tagged with this email so
      // the view is attributed to this recipient.
      const clean = url.split(/[?#]/)[0];
      return `${pre}${q}${clean}?r=${token}${q}`;
    }
    if (!wantTracked(url)) return m;
    const lt = shortCode(7);
    inserts.push(db.prepare("INSERT INTO links(email_id,token,url) VALUES(?,?,?)").bind(emailId, lt, url));
    return `${pre}${q}${base}/${lt}${q}`;
  });
  if (inserts.length) await db.batch(inserts);

  const pixel = `<img src="${base}/img/${token}.gif" width="1" height="1" alt="" ` +
    `style="display:block;width:1px;height:1px;border:0;opacity:0" />`;
  tracked = /<\/body>/i.test(tracked) ? tracked.replace(/<\/body>/i, pixel + "</body>") : tracked + pixel;
  return { id: emailId, token, html: tracked, pixel: `${base}/t/${token}.gif` };
}

function recount(db, eid) {
  return [
    db.prepare(`UPDATE emails SET
        opens      = (SELECT COUNT(*) FROM events WHERE email_id=?1 AND kind='open'  AND is_bot=0),
        clicks     = (SELECT COUNT(*) FROM events WHERE email_id=?1 AND kind='click' AND is_bot=0),
        first_open = (SELECT MIN(ts)  FROM events WHERE email_id=?1 AND kind='open'  AND is_bot=0),
        last_open  = (SELECT MAX(ts)  FROM events WHERE email_id=?1 AND kind='open'  AND is_bot=0)
      WHERE id=?1`).bind(eid),
    db.prepare(`UPDATE links SET clicks = (SELECT COUNT(*) FROM events e
        WHERE e.email_id=?1 AND e.link_id=links.id AND e.is_bot=0)
      WHERE email_id=?1`).bind(eid),
  ];
}

export function alertStmt(db, eid, kind, message, ts, userId) {
  return db.prepare("INSERT INTO alerts(email_id,kind,message,ts,user_id) VALUES(?,?,?,?,?)")
    .bind(eid, kind, message, ts, userId ?? null);
}

// When was (or will be) the email actually sent?
export function sentRef(email) {
  const s = email.scheduled_at;
  if (s && s > 0) return s;
  return email.created_at;
}

// email: {id, to_addr, to_name, subject, created_at, scheduled_at, user_id}
export async function recordEvent(db, cfg, req, email, kind, linkId = null) {
  const ip = req.headers.get("CF-Connecting-IP") || "";
  const ua = req.headers.get("User-Agent") || "";
  const prefs = await prefsFor(db, cfg, email.user_id);
  if (cfg.ignoreIps.has(ip) || prefs.ignore_ips.includes(ip.toLowerCase())) return; // you, by IP

  const t = now();
  const eid = email.id;
  let flagged = null;
  let isBot = 0;

  if (isScanner(ua)) {
    flagged = "scanner"; isBot = 1;
  }
  const unknownSchedule = email.scheduled_at === -1;
  if (!isBot && !unknownSchedule && t - sentRef(email) < prefs.prefetch_seconds) {
    // Right after sending: your own compose window, Apple Mail Privacy
    // Protection fetching on delivery, or a link scanner at delivery.
    flagged = kind === "open" ? "prefetch" : "scanner"; isBot = 1;
  }
  if (!isBot && kind === "open") {
    const mine = await db.prepare("SELECT 1 AS x FROM self_views WHERE email_id=? AND ts>? LIMIT 1")
      .bind(eid, t - SELF_WINDOW).first();
    if (mine) { flagged = "self"; isBot = 1; }
  }
  if (kind === "open") {
    // Same client re-requesting the same image within 2s: count once.
    const dup = await db.prepare(
      "SELECT 1 AS x FROM events WHERE email_id=? AND kind='open' AND ip=? AND user_agent=? AND ts>? LIMIT 1")
      .bind(eid, ip, ua, t - 2).first();
    if (dup) return;
  }

  const stmts = [];
  if (!isBot && kind === "click") {
    // Scanners "click" every link in a message within a second or two.
    const burst = await db.prepare(
      "SELECT 1 AS x FROM events WHERE email_id=? AND kind='click' AND link_id!=? AND ts>? LIMIT 1")
      .bind(eid, linkId, t - 2).first();
    if (burst) {
      flagged = "scanner"; isBot = 1;
      stmts.push(db.prepare("UPDATE events SET is_bot=1, flagged='scanner' WHERE email_id=? AND kind='click' AND ts>?")
        .bind(eid, t - 2));
      stmts.push(db.prepare("DELETE FROM alerts WHERE email_id=? AND kind='click' AND ts>?").bind(eid, t - 3));
    }
  }

  const cf = req.cf || {};
  const geo = [cf.city, cf.country].filter(Boolean).join(", ");
  stmts.push(db.prepare(
    "INSERT INTO events(email_id,kind,link_id,ip,user_agent,geo,ts,is_bot,flagged) VALUES(?,?,?,?,?,?,?,?,?)")
    .bind(eid, kind, linkId, ip, ua, geo, t, isBot, flagged));
  stmts.push(...recount(db, eid));
  await db.batch(stmts);
  if (isBot) return;

  const who = email.to_name || email.to_addr;
  const subj = email.subject;
  if (kind === "click") {
    await alertStmt(db, eid, "click", `${who} clicked a link in "${subj}"`, t, email.user_id).run();
    return;
  }
  const c = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM events WHERE email_id=?1 AND kind='open' AND is_bot=0) AS total,
      (SELECT COUNT(*) FROM events WHERE email_id=?1 AND kind='open' AND is_bot=0 AND ts>?2) AS recent,
      (SELECT MAX(ts)  FROM events WHERE email_id=?1 AND kind='open' AND is_bot=0 AND ts<?3) AS prev`)
    .bind(eid, t - prefs.spike_minutes * 60, t).first();
  const out = [];
  out.push(c.total === 1
    ? alertStmt(db, eid, "open", `${who} opened "${subj}"${geo ? " from " + geo : ""}`, t, email.user_id)
    : alertStmt(db, eid, "open", `${who} reopened "${subj}" (${c.total} opens)`, t, email.user_id));
  if (prefs.revival_days && c.prev && t - c.prev > prefs.revival_days * 86400) {
    out.push(alertStmt(db, eid, "revived",
      `Revived: ${who} reopened "${subj}" after ${Math.floor((t - c.prev) / 86400)} days`, t, email.user_id));
  }
  if (prefs.spike_count && c.recent === prefs.spike_count) {
    out.push(alertStmt(db, eid, "spike",
      `Open spike: ${who} opened "${subj}" ${c.recent}x in ${prefs.spike_minutes} min`, t, email.user_id));
  }
  await db.batch(out);
}

// The extension calls this when YOU view a tracked message in Gmail.
export async function markSelfView(db, userId, token) {
  const e = await db.prepare("SELECT id FROM emails WHERE token=? AND user_id=?").bind(token, userId).first();
  if (!e) return false;
  const t = now();
  await db.batch([
    db.prepare("INSERT INTO self_views(email_id,ts) VALUES(?,?)").bind(e.id, t),
    db.prepare("UPDATE events SET is_bot=1, flagged='self' WHERE email_id=? AND kind='open' AND is_bot=0 AND ts>?")
      .bind(e.id, t - SELF_LOOKBACK),
    db.prepare("DELETE FROM alerts WHERE email_id=? AND kind IN ('open','spike','revived') AND ts>?")
      .bind(e.id, t - SELF_LOOKBACK),
    ...recount(db, e.id),
  ]);
  return true;
}

// The extension calls this after you pick a time in Gmail's "Schedule send".
// at: unix seconds, or null when the time could not be read from Gmail.
export async function markScheduled(db, userId, token, at) {
  const e = await db.prepare("SELECT id FROM emails WHERE token=? AND user_id=?").bind(token, userId).first();
  if (!e) return false;
  const value = at && Number(at) > 0 ? Number(at) : -1;
  await db.prepare("UPDATE emails SET scheduled_at=? WHERE id=?").bind(value, e.id).run();
  return true;
}

// A reminder that's due waits for a reply check after it fell due (src/replies.js),
// so you're never told to follow up on an email that was answered. If checks keep
// failing, it goes out anyway after this long.
const REPLY_WAIT = 6 * 3600;

// Cron: follow-up reminders and housekeeping.
export async function runScheduled(db, cfg) {
  await ensureGoogleSchema(db);
  const t = now();
  // Candidates: unopened, no reply, not yet reminded, out for at least an hour.
  const due = await db.prepare(
    `SELECT e.id, e.to_addr, e.to_name, e.subject, e.user_id, e.created_at, e.scheduled_at, e.reply_checked, u.prefs,
            (u.gmail_token IS NOT NULL AND e.gmail_msg IS NOT NULL) AS reply_watched
     FROM emails e LEFT JOIN users u ON u.id = e.user_id
     WHERE e.followup_done=0 AND e.opens=0 AND e.replied_at IS NULL
       AND (e.scheduled_at IS NULL OR e.scheduled_at > 0)
       AND COALESCE(NULLIF(e.scheduled_at, -1), e.created_at) < ? LIMIT 200`)
    .bind(t - 3600).all();
  const stmts = [];
  let reminded = 0;
  for (const e of due.results) {
    const hours = readPrefs(cfg, e.prefs).followup_hours;
    if (!hours) { // reminders off for this person: don't look at this email again
      stmts.push(db.prepare("UPDATE emails SET followup_done=1 WHERE id=?").bind(e.id));
      continue;
    }
    const dueAt = sentRef(e) + hours * 3600;
    if (dueAt > t) continue;
    const watched = e.reply_watched && sentRef(e) > t - 30 * 86400;       // replies.js REPLY_DAYS
    if (watched && (e.reply_checked || 0) < dueAt && t - dueAt < REPLY_WAIT) continue;  // check for a reply first
    const who = e.to_name || e.to_addr;
    stmts.push(alertStmt(db, e.id, "followup",
      `No open yet: "${e.subject}" to ${who} after ${hours}h. Time to follow up.`, t, e.user_id));
    stmts.push(db.prepare("UPDATE emails SET followup_done=1 WHERE id=?").bind(e.id));
    reminded++;
  }
  stmts.push(db.prepare("DELETE FROM login_failures WHERE ts<?").bind(t - 86400));
  stmts.push(db.prepare("DELETE FROM self_views WHERE ts<?").bind(t - 86400));
  await db.batch(stmts);
  return reminded;
}
