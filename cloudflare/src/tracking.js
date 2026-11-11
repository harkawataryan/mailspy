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
// the message yourself (reported by the Gmail extension). Apple Mail's proxy
// is different: it fetches whether or not anyone reads (see isAppleProxy).
// Your own views on other devices (the Gmail phone app) never reach the
// pixel at all once the tracking is taken out of your Sent copy (sentcopy.js).
const SELF_WINDOW = 20;   // seconds after a self-view during which opens are yours
const SELF_LOOKBACK = 12; // seconds before a self-view to re-flag as yours (less than ALERT_SETTLE)

// ---- Apple Mail Privacy Protection ----
// With Mail Privacy Protection on (the default for most Apple Mail users),
// Apple's servers fetch every image in a message, usually soon after delivery
// but sometimes hours later (the device asks when it's on Wi-Fi and charging),
// whether or not the person ever reads it. When they do read it, the image
// comes from Apple's cache through the same proxy, so the two can't be told
// apart. The rule here:
//   1. The User-Agent is exactly "Mozilla/5.0". Apple's proxy strips the real
//      one down to that, and no real browser or mail app sends it bare.
//      Email platforms (Liveclicker/Zeta, ClickDimensions, Marigold and others)
//      document this and use it to label "Apple MPP" opens. High confidence
//      that such a hit is Apple's proxy (or, rarely, some other bot: neither
//      is a confirmed human read).
//   2. Or: the request comes from Apple's own network (Apple's ASNs 714/6185,
//      17.0.0.0/8, or Apple's IPv6 blocks) with a WebKit User-Agent that isn't
//      a full browser (no Safari/Chrome/Firefox token), which is what Apple
//      Mail's loader sends. Medium confidence: Apple has also used other
//      shapes and partner networks for the proxy, and this can't see those.
// Such hits are stored with flagged='apple' and is_bot=1: shown as "Apple
// Mail, may be automatic", left out of the open counts, no "opened"
// notification and no ✔✔. A click, or an open from any other client, still
// counts as usual. Fetches inside the prefetch window stay 'prefetch'.
const APPLE_ASNS = new Set([714, 6185]);
const APPLE_V6 = ["2620:149:", "2a01:b740:", "2403:300:"];
function appleNetwork(ip, asn) {
  if (APPLE_ASNS.has(Number(asn))) return true;
  const a = String(ip || "").toLowerCase();
  if (/^17\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a)) return true;
  return APPLE_V6.some(p => a.startsWith(p));
}
export function isAppleProxy(ua, ip = "", asn = null) {
  const s = String(ua || "").trim();
  if (s === "Mozilla/5.0") return true;
  return appleNetwork(ip, asn) && /AppleWebKit\//.test(s) && !/(Safari|Chrome|CriOS|Firefox|FxiOS|Edg)\//.test(s);
}

// ---- mail providers' image proxies ----
// Gmail, Yahoo, Outlook.com and Apple Mail (Privacy Protection) fetch images
// through their own servers, so the IP's city is the provider's data centre
// ("Mountain View"), not the reader's. Decided when showing an event (from
// its stored User-Agent), so events recorded before this was added are right too.
export function mailProxy(ua, flagged = null) {
  if (flagged === "apple") return "Apple Mail";
  const s = String(ua || "").toLowerCase();
  if (s.includes("googleimageproxy")) return "Gmail";
  if (s.includes("yahoomailproxy") || (s.includes("yahoo") && s.includes("proxy"))) return "Yahoo";
  if (/outlook|microsoft|hotmail|office365/.test(s) && s.includes("proxy")) return "Outlook";
  if (String(ua || "").trim() === "Mozilla/5.0") return "Apple Mail";
  return "";
}

// Where an event happened, as shown to the user: "via Gmail" for a proxy
// fetch, the city for a direct open or a click. v: {kind, user_agent, geo, flagged}
export function placeOf(v) {
  if (v && (v.kind === "open" || v.flagged === "apple")) {
    const p = mailProxy(v.user_agent, v.flagged);
    if (p) return `via ${p}`;
  }
  return (v && v.geo) || "";
}

// The image was loaded by a Gmail web page directly (Referer mail.google.com),
// not through Google's image proxy. Gmail proxies every image in mail you
// receive, so this is the sender's own browser: their compose window or draft.
export function fromOwnGmail(req) {
  const ref = String((req.headers && req.headers.get && req.headers.get("Referer")) || "");
  const ua = String((req.headers && req.headers.get && req.headers.get("User-Agent")) || "").toLowerCase();
  return /^https:\/\/mail\.google\.com(\/|$)/i.test(ref) && !ua.includes("googleimageproxy");
}

export function isScanner(ua) {
  const s = (ua || "").toLowerCase();
  return SCANNER_HINTS.some(h => s.includes(h));
}

export function classifyAgent(ua) {
  const s = (ua || "").toLowerCase();
  if (!s) return "Unknown";
  if (s.trim() === "mozilla/5.0") return "Apple Mail";   // Apple Mail Privacy Protection's proxy
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

// ---- earlier emails quoted in a later reply ----
// A reply quotes the conversation, and the quote carries the tracking image of
// every earlier tracked email in it. So whenever the reply is shown (to them, or
// to you right after sending), the earlier emails' images load too and would
// count as fresh opens. All images in one message load together, so an open of
// an earlier email within QUOTE_WINDOW seconds of any hit on a later email in
// the same conversation (same subject without Re:/Fwd:) is the quote, not a
// read: stored as flagged='quoted', not counted, no alert. Checked both ways,
// since either image can arrive first.
const QUOTE_WINDOW = 6;
export const threadKey = s => String(s || "").replace(/^\s*((re|fwd?|aw)\s*:\s*)+/i, "").trim().toLowerCase();
async function conversation(db, email) {
  const key = threadKey(email.subject);
  if (!key || key === "(no subject)" || email.user_id == null) return [];
  const rows = (await db.prepare(`SELECT id, subject, created_at FROM emails
      WHERE user_id=? AND id!=? AND created_at > ? AND subject LIKE ? ESCAPE '!'`)
    .bind(email.user_id, email.id, now() - 365 * 86400, "%" + key.replace(/[!%_]/g, c => "!" + c) + "%").all()).results || [];
  return rows.filter(r => threadKey(r.subject) === key);
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
  if (!isBot && kind === "open" && fromOwnGmail(req)) {
    // Your own Gmail page loading the image straight from us: the compose
    // window (it re-renders while you schedule or edit), or a draft. A
    // recipient reading in Gmail always comes through GoogleImageProxy instead.
    flagged = "self"; isBot = 1;
  }
  if (!isBot && kind === "open" && isAppleProxy(ua, ip, (req.cf || {}).asn)) {
    // Apple Mail Privacy Protection: may be automatic (see isAppleProxy).
    flagged = "apple"; isBot = 1;
  }
  if (!isBot && kind === "open") {
    const mine = await db.prepare("SELECT 1 AS x FROM self_views WHERE email_id=? AND ts>? LIMIT 1")
      .bind(eid, t - SELF_WINDOW).first();
    if (mine) { flagged = "self"; isBot = 1; }
  }
  let thread = [];
  if (kind === "open") {
    thread = await conversation(db, email);
    const later = thread.filter(r => r.created_at > email.created_at).map(r => r.id);
    if (!isBot && later.length) {
      const hit = await db.prepare(`SELECT 1 AS x FROM events WHERE kind='open' AND ts>? AND email_id IN (${later.map(() => "?").join(",")}) LIMIT 1`)
        .bind(t - QUOTE_WINDOW, ...later).first();
      if (hit) { flagged = "quoted"; isBot = 1; }
    }
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
  // This is the later email: earlier ones that just loaded with it were its quote.
  for (const r of thread.filter(r => r.created_at < email.created_at)) {
    stmts.push(db.prepare("UPDATE events SET is_bot=1, flagged='quoted' WHERE email_id=? AND kind='open' AND is_bot=0 AND ts>?")
      .bind(r.id, t - QUOTE_WINDOW));
    stmts.push(db.prepare("DELETE FROM alerts WHERE email_id=? AND kind IN ('open','spike','revived') AND ts>?").bind(r.id, t - QUOTE_WINDOW));
    stmts.push(...recount(db, r.id));
  }
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
  const proxy = mailProxy(ua);
  const where = proxy ? ` via ${proxy}` : geo ? ` from ${geo}` : "";
  out.push(c.total === 1
    ? alertStmt(db, eid, "open", `${who} opened "${subj}"${where}`, t, email.user_id)
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

// New alerts are held back for a few seconds before the extension and the
// live page see them. An open can arrive a moment before the extension reports
// that it was you (your Gmail loading a draft through Google's image proxy);
// markSelfView then deletes the alert, and holding it back means it never pops
// up. Only the oldest run of settled alerts is returned, so the "since" cursor
// never skips past one that's still settling. rows: ordered by id.
export const ALERT_SETTLE = 15;
export function settledAlerts(rows, t = now()) {
  const out = [];
  for (const a of rows) {
    if (Number(a.ts) > t - ALERT_SETTLE) break;
    out.push(a);
  }
  return out;
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
  // It hasn't been sent yet, so any open or click so far was you (the compose
  // window loading the image while you picked a time): not counted, no alert.
  await db.batch([
    db.prepare("UPDATE emails SET scheduled_at=? WHERE id=?").bind(value, e.id),
    db.prepare("UPDATE events SET is_bot=1, flagged='self' WHERE email_id=? AND kind IN ('open','click') AND is_bot=0").bind(e.id),
    db.prepare("DELETE FROM alerts WHERE email_id=? AND kind IN ('open','click','spike','revived')").bind(e.id),
    ...recount(db, e.id),
  ]);
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
