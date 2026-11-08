// Settings and small helpers shared by the whole Worker.

export function settings(env) {
  const int = (v, d) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : d;
  };
  let loginPath = "/" + String(env.LOGIN_PATH || "/emailtrack").replace(/^\/+|\/+$/g, "");
  if (loginPath === "/") loginPath = "/emailtrack";
  return {
    loginPath,
    prefetchWindow: int(env.PREFETCH_WINDOW, 12),
    spikeCount: int(env.SPIKE_COUNT, 3),
    spikeWindow: int(env.SPIKE_WINDOW, 600),
    revivalDays: int(env.REVIVAL_DAYS, 7),
    followupHours: int(env.FOLLOWUP_HOURS, 48),
    ignoreIps: new Set(String(env.IGNORE_IPS || "").split(",").map(s => s.trim()).filter(Boolean)),
    baseUrl: String(env.BASE_URL || "").replace(/\/+$/, ""),
    trackUrl: String(env.TRACK_URL || "").replace(/\/+$/, ""),   // short-link address used in emails
    trackHome: String(env.TRACK_HOME || ""),                     // "home" link on that address's front page
    extensionUrl: String(env.EXTENSION_URL || ""),   // Chrome Web Store link, once published
    contactEmail: String(env.CONTACT_EMAIL || ""),   // shown in the privacy policy
    googleClientId: env.GOOGLE_CLIENT_ID || "",           // Sign in with Google + Gmail labels (optional)
    googleClientSecret: env.GOOGLE_CLIENT_SECRET || "",
    apiKey: env.API_KEY || "",
    sessionSecret: env.SESSION_SECRET || "",
    passwordHash: env.PASSWORD_HASH || "",
  };
}

export const now = () => Date.now() / 1000;

// Letters and digits only, like a URL shortener's codes (7 chars ≈ 41 bits).
export function shortCode(len = 7) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const b = crypto.getRandomValues(new Uint8Array(len * 2));
  let s = "";
  for (const x of b) { if (x < 248) s += A[x % 62]; if (s.length === len) break; }
  return s.length === len ? s : shortCode(len);
}

export function randomToken(bytes = 12) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    const l = e.toLowerCase();
    if (l === "amp") return "&";
    if (l === "lt") return "<";
    if (l === "gt") return ">";
    if (l === "quot") return '"';
    if (l === "apos") return "'";
    const cp = l[1] === "x" ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
    return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
  });
}

export function ago(ts) {
  if (!ts) return "never";
  const d = Math.floor(now() - ts);
  if (d < 60) return `${Math.max(d, 0)}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-API-Key, X-Filename",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS },
  });
}

export function html(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin", // never leaks dashboard URLs to other sites
      ...extra,
    },
  });
}

export function notFound() {
  return new Response("Not Found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export function redirect(location, extra = {}) {
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store", ...extra } });
}

export async function readBody(req) {
  const type = req.headers.get("Content-Type") || "";
  try {
    if (type.includes("application/json")) return (await req.json()) || {};
    const form = await req.formData();
    return Object.fromEntries(form.entries());
  } catch {
    return {};
  }
}
