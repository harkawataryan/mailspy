// Per-user settings, stored as JSON in users.prefs.
// Anything missing falls back to the server-wide defaults in wrangler.toml [vars].

export const NOTIFY_KINDS = [
  ["open", "Email opened"],
  ["click", "Link in an email clicked"],
  ["doc", "Tracked PDF viewed"],
  ["link", "Tracked link clicked"],
  ["spike", "Open spike (opened again and again)"],
  ["revived", "Old email reopened"],
  ["followup", "Follow-up reminder"],
  ["retry", "Auto-try result (which guessed address worked)"],
];

export function defaultPrefs(cfg) {
  return {
    followup_hours: cfg.followupHours,          // 0 = off
    revival_days: cfg.revivalDays,              // 0 = off
    spike_count: cfg.spikeCount,                // 0 = off
    spike_minutes: Math.max(1, Math.round(cfg.spikeWindow / 60)),
    prefetch_seconds: cfg.prefetchWindow,
    track_all_links: false,                     // off: only links you mark in Gmail
    show_automated: true,
    allow_downloads: true,
    pdf_tiles: false,                           // on: PDFs attached in Gmail are sent as tracked link tiles; off: normal attachments
    hide_sent_pixel: true,                      // with Gmail connected: your Sent copy gets the tracking image taken out (sentcopy.js)
    notify: Object.fromEntries(NOTIFY_KINDS.map(([k]) => [k, true])),
    ignore_recipients: [],                      // "name@x.com" or "@x.com"
    ignore_ips: [],
    hunter_key: "",
    search_key: "",                             // optional Tavily or SerpApi key: finds people via public LinkedIn profiles                             // optional Hunter.io API key for the email finder (never sent to the extension)
  };
}

// A real IPv4 address (each part 0-255) or an IPv6 address.
const IP_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}|(?=[0-9a-f:]*:[0-9a-f:]*:)[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7})$/i;

const clampInt = (v, lo, hi, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

function cleanList(v, max, re) {
  const items = Array.isArray(v) ? v : String(v || "").split(/[\s,;]+/);
  return [...new Set(items.map(s => String(s).trim().toLowerCase()).filter(s => s && re.test(s)))].slice(0, max);
}

// Validate anything (stored JSON or a submitted form) into a complete prefs object.
export function normalizePrefs(cfg, raw = {}) {
  const d = defaultPrefs(cfg);
  const r = raw || {};
  const bool = (v, def) => (v === undefined ? def : v === true || v === "1" || v === "on" || v === "true");
  const notify = {};
  for (const [k] of NOTIFY_KINDS) notify[k] = bool(r.notify ? r.notify[k] : undefined, d.notify[k]);
  return {
    followup_hours: clampInt(r.followup_hours, 0, 24 * 60, d.followup_hours),
    revival_days: clampInt(r.revival_days, 0, 365, d.revival_days),
    spike_count: clampInt(r.spike_count, 0, 50, d.spike_count),
    spike_minutes: clampInt(r.spike_minutes, 1, 24 * 60, d.spike_minutes),
    prefetch_seconds: clampInt(r.prefetch_seconds, 0, 600, d.prefetch_seconds),
    track_all_links: bool(r.track_all_links, d.track_all_links),
    show_automated: bool(r.show_automated, d.show_automated),
    allow_downloads: bool(r.allow_downloads, d.allow_downloads),
    pdf_tiles: bool(r.pdf_tiles, d.pdf_tiles),
    hide_sent_pixel: bool(r.hide_sent_pixel, d.hide_sent_pixel),
    notify,
    ignore_recipients: cleanList(r.ignore_recipients, 200, /^[^\s@]*@[^\s@]+\.[^\s@]+$/),
    ignore_ips: cleanList(r.ignore_ips, 50, IP_RE),
    hunter_key: /^[A-Za-z0-9]{20,80}$/.test(String(r.hunter_key || "").trim()) ? String(r.hunter_key).trim() : "",
    search_key: /^[A-Za-z0-9_-]{20,100}$/.test(String(r.search_key || "").trim()) ? String(r.search_key).trim() : "",
  };
}

export function readPrefs(cfg, json) {
  let raw = {};
  try { raw = json ? JSON.parse(json) : {}; } catch { raw = {}; }
  return normalizePrefs(cfg, raw);
}

// Turn a submitted Settings form into prefs. Unticked checkboxes don't submit, so
// every checkbox on the form counts as "off" unless present.
export function prefsFromForm(cfg, form) {
  const notify = {};
  for (const [k] of NOTIFY_KINDS) notify[k] = form[`notify_${k}`] === "on";
  return normalizePrefs(cfg, {
    followup_hours: form.followup_off === "on" ? 0 : form.followup_hours,
    revival_days: form.revival_off === "on" ? 0 : form.revival_days,
    spike_count: form.spike_off === "on" ? 0 : form.spike_count,
    spike_minutes: form.spike_minutes,
    prefetch_seconds: form.prefetch_seconds,
    track_all_links: form.track_all_links === "on",
    show_automated: form.show_automated === "on",
    allow_downloads: form.allow_downloads === "on",
    pdf_tiles: form.pdf_tiles === "on",
    hide_sent_pixel: form.hide_sent_pixel === "on",
    notify,
    ignore_recipients: form.ignore_recipients,
    ignore_ips: form.ignore_ips,
    hunter_key: form.hunter_key,
    search_key: form.search_key,
  });
}

export async function prefsFor(db, cfg, userId) {
  if (!userId) return defaultPrefs(cfg);
  const row = await db.prepare("SELECT prefs FROM users WHERE id=?").bind(userId).first();
  return readPrefs(cfg, row && row.prefs);
}

// Is this address on the user's "don't track" list?
export function isIgnoredRecipient(prefs, addr) {
  const a = String(addr || "").trim().toLowerCase();
  if (!a) return false;
  return prefs.ignore_recipients.some(r => (r.startsWith("@") ? a.endsWith(r) : a === r));
}
