// Accounts: password hashing, signed session cookies, API keys, login throttling.

import { now, randomToken } from "./util.js";

const enc = new TextEncoder();
const SESSION_DAYS = 30;
const ITERATIONS = 5000; // modest, so sign-in fits the free plan's CPU budget

function b64decode(s) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
function b64encode(u8) { return btoa(String.fromCharCode(...u8)); }

function safeEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

async function pbkdf2(pw, salt, iters) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: iters }, key, 256));
}

// Format: pbkdf2_sha256$<iterations>$<salt b64>$<hash b64>
export async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2_sha256$${ITERATIONS}$${b64encode(salt)}$${b64encode(await pbkdf2(pw, salt, ITERATIONS))}`;
}

export async function checkPassword(pw, stored) {
  try {
    const [algo, iters, salt, hash] = String(stored).split("$");
    if (algo !== "pbkdf2_sha256") return false;
    return safeEqual(await pbkdf2(pw, b64decode(salt), parseInt(iters, 10)), b64decode(hash));
  } catch {
    return false;
  }
}

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
  return [...sig].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Cookie value: <userId>.<expiry>.<nonce>.<hmac>
export async function makeSession(secret, userId) {
  const msg = `${userId}.${Math.floor(now()) + SESSION_DAYS * 86400}.${randomToken(8)}`;
  return `${msg}.${await hmacHex(secret, msg)}`;
}

async function sessionUserId(secret, value) {
  if (!secret || !value) return null;
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const [uid, exp, nonce, sig] = parts;
  if (!(parseInt(exp, 10) > now())) return null;
  const expected = await hmacHex(secret, `${uid}.${exp}.${nonce}`);
  return safeEqual(enc.encode(sig), enc.encode(expected)) ? parseInt(uid, 10) : null;
}

function getCookie(req, name) {
  for (const part of (req.headers.get("Cookie") || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return "";
}

export function sessionCookie(value, maxAge, secure) {
  return `sid=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export const SESSION_MAX_AGE = SESSION_DAYS * 86400;

const USER_COLS = "id, email, name, api_key, is_admin, created_at, theme";

// The signed-in user for this browser session, or null.
export async function sessionUser(req, db, cfg) {
  const uid = await sessionUserId(cfg.sessionSecret, getCookie(req, "sid"));
  if (!uid) return null;
  return db.prepare(`SELECT ${USER_COLS} FROM users WHERE id=?`).bind(uid).first();
}

// The user an API request belongs to (X-API-Key header), or null.
// The original single-user API key keeps working and maps to the owner account.
export async function apiUser(req, db, cfg) {
  const key = req.headers.get("X-API-Key") || new URL(req.url).searchParams.get("key") || "";
  if (!key) return null;
  if (cfg.apiKey && safeEqual(enc.encode(key), enc.encode(cfg.apiKey))) {
    return db.prepare(`SELECT ${USER_COLS} FROM users WHERE is_admin=1 ORDER BY id LIMIT 1`).first();
  }
  return db.prepare(`SELECT ${USER_COLS} FROM users WHERE api_key=?`).bind(key).first();
}

export function newApiKey() { return randomToken(24); }
export function newInviteCode() { return randomToken(12); }

// 10 failed attempts from one IP in 15 minutes locks that IP out for the window.
export async function loginBlocked(db, ip) {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM login_failures WHERE ip=? AND ts>?")
    .bind(ip, now() - 900).first();
  return (r?.n || 0) >= 10;
}

export async function noteLoginFailure(db, ip) {
  await db.prepare("INSERT INTO login_failures(ip,ts) VALUES(?,?)").bind(ip, now()).run();
}
