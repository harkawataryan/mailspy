// MailSpy on Cloudflare Workers + D1, for you and a few invited friends.
//
// Public:   /t/<token>.gif (open pixel)   /c/<token> (tracked link)   /privacy
//           <LOGIN_PATH> (sign in)   /signup?code=… (invite only)   /api/login, /api/version
// API:      other /api/* need the user's X-API-Key (used by the Chrome extension)
// Private:  everything else needs a signed-in session; outsiders get "Not Found".
// Every query on private pages and the API is limited to the signed-in user's data.

import { settings, now, json, html, notFound, redirect, readBody, CORS, esc } from "./util.js";
import { sessionUser, apiUser, checkPassword, hashPassword, makeSession, sessionCookie, SESSION_MAX_AGE,
         loginBlocked, noteLoginFailure, newApiKey, newInviteCode } from "./auth.js";
import { PIXEL_GIF, prepareEmail, recordEvent, markSelfView, markScheduled, runScheduled, placeOf } from "./tracking.js";
import { hideTracking, sweepSentCopies } from "./sentcopy.js";
import * as views from "./views.js";
import { prefsFor, prefsFromForm } from "./prefs.js";
import { findPerson, findRecruiters } from "./finder.js";
import { cleanPlan, startRetry, retryByToken, sweepRetries } from "./retry.js";
import { googleEnabled, authUrl, makeState, readState, exchangeCode, saveGmail, disconnectGmail, gmailStatus,
         ensureGoogleSchema, labelEmail, sweepLabels } from "./google.js";
import { listTemplates, getTemplate, saveTemplate, deleteTemplate, markUsed, templatesFor } from "./templates.js";
import { pendingLabels, saveLabels } from "./labels.js";   // older Apps Script labels (kept for anyone still running it)
import { uploadDoc, deleteDoc, docBeat, createLink, deleteLink, recordLinkClick, MAX_PDF_BYTES,
         saveThumb, thumbResponse, MAX_THUMB_BYTES } from "./docs.js";

// Everything a person has seen happen: email opens/clicks, PDF views, tracked-link clicks.
const ACTIVITY_SQL = `SELECT * FROM (
  SELECT v.id, v.kind, v.ts, v.geo, v.user_agent, v.is_bot, v.flagged, e.id AS email_id, e.to_addr, e.to_name, e.subject,
         NULL AS item_id, NULL AS title
    FROM events v JOIN emails e ON e.id=v.email_id WHERE e.user_id=?1
  UNION ALL
  SELECT dv.id, 'doc', dv.ts, dv.geo, dv.user_agent, dv.is_self, CASE WHEN dv.is_self THEN 'self' END, e.id, e.to_addr, e.to_name, e.subject,
         d.id, d.filename
    FROM doc_views dv JOIN docs d ON d.id=dv.doc_id LEFT JOIN emails e ON e.id=dv.email_id WHERE d.user_id=?1
  UNION ALL
  SELECT c.id, 'link', c.ts, c.geo, c.user_agent, c.is_bot, CASE WHEN c.is_bot THEN 'scanner' END, NULL, NULL, NULL, NULL,
         l.id, COALESCE(l.label, l.url)
    FROM tlink_clicks c JOIN tlinks l ON l.id=c.tlink_id WHERE l.user_id=?1
) ORDER BY ts DESC LIMIT ?2`;
import manifest from "../../extension/manifest.json";

// An activity row as the extension gets it: location shown as "via Gmail" for
// proxy fetches, and no user agent.
function shownActivity(v) {
  const { user_agent, ...rest } = v;
  return { ...rest, geo: placeOf(v) };
}

const EMAIL_COLS = "id,to_addr,to_name,subject,created_at,scheduled_at,user_id";
const GOOGLE_ONLY = "!google";   // password_hash of accounts made with Google (no password yet)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function pixel() {
  return new Response(PIXEL_GIF, {
    headers: {
      "Content-Type": "image/gif",
      "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0, private",
      "Pragma": "no-cache",
      "Expires": "0",
    },
  });
}

async function userCount(db) {
  return (await db.prepare("SELECT COUNT(*) AS n FROM users").first()).n;
}

async function handle(req, env, ctx) {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;
  const cfg = settings(env);
  const base = cfg.baseUrl || url.origin;
  const tbase = cfg.trackUrl || base;  // address used in emails and shared links
  const db = env.DB;
  const secure = url.protocol === "https:";
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const log = p => ctx.waitUntil(p.catch(err => console.error("track error:", err)));
  const signIn = async (uid, to = "/") =>
    redirect(to, { "Set-Cookie": sessionCookie(await makeSession(cfg.sessionSecret, uid), SESSION_MAX_AGE, secure) });

  if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  // Forms posted from another site never carry our cookie (SameSite=Lax); this
  // also rejects any cross-site POST outright.
  // Chrome marks a same-site form post as Origin "null" under some referrer
  // policies, so rely on Sec-Fetch-Site when present and only reject a real,
  // different origin.
  const origin = req.headers.get("Origin");
  const fetchSite = req.headers.get("Sec-Fetch-Site");
  const crossSite = fetchSite ? fetchSite === "cross-site" || fetchSite === "same-site"
                              : !!(origin && origin !== "null" && origin !== url.origin);
  if (method === "POST" && crossSite && !path.startsWith("/api/")) {
    return new Response("Forbidden", { status: 403 });
  }

  // ---- the short-link address (TRACK_URL, e.g. https://go.aryanh.dev) ----
  // Emails and shared links only ever show this address. It behaves like a
  // plain URL shortener: /<code> redirects, the front page is a bland
  // short-link page, and nothing else (sign-in, dashboard, API) exists here.
  let trackHost = "";
  try { trackHost = cfg.trackUrl ? new URL(cfg.trackUrl).host : ""; } catch {}
  const onTrackHost = !!trackHost && (req.headers.get("Host") || url.host) === trackHost;

  // ---- open pixel ----  (/img/<token>.gif; /t/ is the older form)
  let m = path.match(/^\/(?:t|img)\/([A-Za-z0-9_-]+)(?:\.gif|\.png)?$/);
  if (m) {
    if (method === "GET") {
      log((async () => {
        const e = await db.prepare(`SELECT ${EMAIL_COLS} FROM emails WHERE token=?`).bind(m[1]).first();
        if (e) {
          await recordEvent(db, cfg, req, e, "open");
          await labelEmail(env, cfg, e.id);          // ✔ -> ✔✔ in their Gmail
        }
      })());
    }
    return pixel(); // unknown tokens still get an image
  }

  // A link in an email: log the click, then send them on.
  const emailLink = async token => {
    const l = await db.prepare(
      `SELECT l.id, l.url, e.id AS email_id, e.to_addr, e.to_name, e.subject, e.created_at, e.scheduled_at, e.user_id
       FROM links l JOIN emails e ON e.id=l.email_id WHERE l.token=?`).bind(token).first();
    if (!l) return null;
    if (method === "GET") {
      log(recordEvent(db, cfg, req,
        { id: l.email_id, to_addr: l.to_addr, to_name: l.to_name, subject: l.subject,
          created_at: l.created_at, scheduled_at: l.scheduled_at, user_id: l.user_id },
        "click", l.id).then(() => labelEmail(env, cfg, l.email_id)));
    }
    return redirect(l.url);
  };

  // A standalone short link from the Links page.
  const shortLink = async token => {
    const l = await db.prepare("SELECT * FROM tlinks WHERE token=?").bind(token).first();
    if (!l) return null;
    if (method === "GET") log(recordLinkClick(db, cfg, req, l));
    return redirect(l.url);
  };

  // A tracked PDF: the viewer page, its file, or a reading heartbeat.
  const serveDoc = async (token, sub) => {
    const doc = await db.prepare("SELECT * FROM docs WHERE token=?").bind(token).first();
    if (!doc) return null;
    if (sub === "/p.png") return (await thumbResponse(env, doc.token)) || notFound();
    if (sub === "/file") {
      const bytes = env.DOCS ? await env.DOCS.get(`doc:${doc.token}`, { type: "arrayBuffer" }) : null;
      if (!bytes) return html(views.docMissing(), 404);
      const prefs = await prefsFor(db, cfg, doc.user_id);
      const download = url.searchParams.get("dl") === "1" && prefs.allow_downloads;
      return new Response(bytes, { headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(doc.filename)}`,
        "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex",
      } });
    }
    if (sub === "/beat") {
      if (method !== "POST") return notFound();
      let body = {};
      try { body = JSON.parse(await req.text()); } catch {}
      const viewer = await sessionUser(req, db, cfg);
      return json(await docBeat(env, cfg, req, doc, body, viewer ? viewer.id : null));
    }
    const prefs = await prefsFor(db, cfg, doc.user_id);
    return html(views.docViewer({ doc, token: doc.token, r: url.searchParams.get("r"), allowDownload: prefs.allow_downloads }));
  };

  m = path.match(/^\/c\/([A-Za-z0-9_-]+)$/);
  if (m) return (await emailLink(m[1])) || notFound();

  m = path.match(/^\/d\/([A-Za-z0-9_-]+)(\/file|\/beat|\/p\.png)?$/);
  if (m) return (await serveDoc(m[1], m[2])) || html(views.docMissing(), 404);

  m = path.match(/^\/l\/([A-Za-z0-9_-]+)$/);
  if (m) return (await shortLink(m[1])) || notFound();

  if (onTrackHost) {
    m = path.match(/^\/([A-Za-z0-9_-]{6,})\/?$/);
    if (m) {
      const r = (await emailLink(m[1])) || (await shortLink(m[1])) || (await serveDoc(m[1], ""));
      if (r) return r;
    }
    if (path === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain" } });
    if (path === "/") return html(views.shortHome(cfg));
    return html(views.shortMissing(), 404);
  }

  if (path === "/privacy") return html(views.privacyPage(cfg, base));
  if (path === "/api/version") return json({ version: manifest.version, google: googleEnabled(cfg) });

  // ---- Sign in with Google (also lets MailSpy add ✔ / ✔✔ labels in Gmail) ----
  // mode: signin | signup (with an invite code) | connect (signed-in user adding Gmail) | ext (the extension)
  if (path === "/auth/google") {
    if (!googleEnabled(cfg) || !cfg.sessionSecret) return notFound();
    const q = url.searchParams;
    const mode = ["signin", "signup", "connect", "ext"].includes(q.get("mode")) ? q.get("mode") : "signin";
    const data = { mode };
    if (mode === "signup") data.code = String(q.get("code") || "").slice(0, 64);
    if (mode === "connect") {
      const u = await sessionUser(req, db, cfg);
      if (!u) return redirect(cfg.loginPath);
      data.uid = u.id;
    }
    const consent = mode === "signup" || mode === "connect";
    return redirect(authUrl(cfg, base, await makeState(cfg.sessionSecret, data), { consent }));
  }
  if (path === "/auth/google/callback") {
    if (!googleEnabled(cfg) || !cfg.sessionSecret) return notFound();
    const q = url.searchParams;
    const fail = msg => html(views.login(cfg, { mode: "login", error: msg, google: true }), 400);
    const st = await readState(cfg.sessionSecret, q.get("state"));
    if (!st) return fail("That sign-in took too long or was already used. Please try again.");
    if (q.get("error")) return fail(q.get("error") === "access_denied" ? "Google sign-in was cancelled." : "Google sign-in didn't work. Please try again.");
    const g = await exchangeCode(cfg, base, String(q.get("code") || ""));
    if (g.error) return fail(g.error);
    await ensureGoogleSchema(db);

    let uid = null;
    if (st.mode === "connect") {
      uid = st.uid;
    } else {
      const u = await db.prepare("SELECT id FROM users WHERE email=? OR google_sub=? ORDER BY (email=?) DESC LIMIT 1")
        .bind(g.email, g.sub, g.email).first();
      if (u) uid = u.id;
      else if (st.mode === "signup") {
        const invite = st.code && await db.prepare("SELECT code FROM invites WHERE code=? AND used_by IS NULL").bind(st.code).first();
        if (!invite) return fail("That invite link has already been used.");
        const res = await db.prepare("INSERT INTO users(email,name,password_hash,api_key,is_admin,created_at) VALUES(?,?,?,?,0,?)")
          .bind(g.email, g.name || null, GOOGLE_ONLY, newApiKey(), now()).run();
        uid = res.meta.last_row_id;
        const claimed = await db.prepare("UPDATE invites SET used_by=?, used_at=? WHERE code=? AND used_by IS NULL").bind(uid, now(), st.code).run();
        if (!claimed.meta.changes) {
          await db.prepare("DELETE FROM users WHERE id=?").bind(uid).run();
          return fail("That invite link has already been used.");
        }
      } else {
        return fail(`There's no MailSpy account for ${g.email}. MailSpy is invite-only, so you'll need an invite link to join.`);
      }
    }
    // Google only hands out a long-lived Gmail token on first consent. If Gmail
    // was allowed but no token came back and we don't have one, ask once more.
    const had = await db.prepare("SELECT gmail_token IS NOT NULL AS t FROM users WHERE id=?").bind(uid).first();
    if (g.gmail && !g.refreshToken && !(had && had.t) && !st.retried) {
      return redirect(authUrl(cfg, base, await makeState(cfg.sessionSecret, { ...st, retried: 1 }), { consent: true, hint: g.email }));
    }
    await saveGmail(db, cfg, uid, g);
    if (g.gmail) log(sweepLabels(env, cfg));
    const to = st.mode === "ext" ? "/extension-link" : st.mode === "connect" ? "/settings?gmail=1"
      : st.mode === "signup" ? "/?welcome=1" : "/";
    return signIn(uid, to);
  }

  // ---- sign in, owner setup, sign out ----
  if (path === cfg.loginPath) {
    if (!cfg.sessionSecret) return html(views.login(cfg, { mode: "disabled" }));
    const firstRun = (await userCount(db)) === 0;
    if (method === "POST") {
      if (await loginBlocked(db, ip)) return html(views.login(cfg, { mode: firstRun ? "claim" : "login", error: "Too many attempts. Try again in 15 minutes." }), 429);
      const form = await readBody(req);
      const email = String(form.email || "").trim().toLowerCase();
      const password = String(form.password || "");

      if (firstRun) {
        // The first account is the owner. Proving you know the original
        // dashboard password (from `npm run setup`) claims it, along with
        // every email tracked before accounts existed.
        if (!cfg.passwordHash) return html(views.login(cfg, { mode: "disabled" }));
        if (!EMAIL_RE.test(email)) return html(views.login(cfg, { mode: "claim", error: "Enter a valid email address.", form }), 400);
        if (!(await checkPassword(password, cfg.passwordHash))) {
          await noteLoginFailure(db, ip);
          return html(views.login(cfg, { mode: "claim", error: "That isn't the password you set with npm run setup.", form }), 401);
        }
        const res = await db.prepare(
          "INSERT INTO users(email,name,password_hash,api_key,is_admin,created_at) VALUES(?,?,?,?,1,?)")
          .bind(email, String(form.name || "").trim() || null, cfg.passwordHash, cfg.apiKey || newApiKey(), now()).run();
        const uid = res.meta.last_row_id;
        await db.batch([
          db.prepare("UPDATE emails SET user_id=? WHERE user_id IS NULL").bind(uid),
          db.prepare("UPDATE alerts SET user_id=? WHERE user_id IS NULL").bind(uid),
        ]);
        return signIn(uid);
      }

      const u = await db.prepare("SELECT id, password_hash FROM users WHERE email=?").bind(email).first();
      if (!u || !(await checkPassword(password, u.password_hash))) {
        await noteLoginFailure(db, ip);
        return html(views.login(cfg, { mode: "login", error: "Wrong email or password.", form }), 401);
      }
      return signIn(u.id);
    }
    if (await sessionUser(req, db, cfg)) return redirect("/");
    return html(views.login(cfg, { mode: firstRun ? (cfg.passwordHash ? "claim" : "disabled") : "login" }));
  }
  if (path === "/logout") return redirect(cfg.loginPath, { "Set-Cookie": sessionCookie("", 0, secure) });

  // ---- sign up with an invite code ----
  if (path === "/signup") {
    const code = String(url.searchParams.get("code") || "");
    const invite = code && await db.prepare("SELECT * FROM invites WHERE code=? AND used_by IS NULL").bind(code).first();
    if (!invite) {
      if (code) await noteLoginFailure(db, ip); // guessing codes counts against the same limit
      return notFound();
    }
    if (await loginBlocked(db, ip)) return html(views.signup({ code, error: "Too many attempts. Try again in 15 minutes.", google: googleEnabled(cfg) }), 429);
    if (method === "POST") {
      const form = await readBody(req);
      const email = String(form.email || "").trim().toLowerCase();
      const name = String(form.name || "").trim();
      const password = String(form.password || "");
      let error = "";
      if (!EMAIL_RE.test(email)) error = "Enter a valid email address.";
      else if (password.length < 10) error = "Use a password of at least 10 characters.";
      else if (password !== String(form.password2 || "")) error = "The two passwords don't match.";
      else if (await db.prepare("SELECT 1 AS x FROM users WHERE email=?").bind(email).first()) error = "There's already an account with that email.";
      if (error) return html(views.signup({ code, error, form, google: googleEnabled(cfg) }), 400);
      const res = await db.prepare(
        "INSERT INTO users(email,name,password_hash,api_key,is_admin,created_at) VALUES(?,?,?,?,0,?)")
        .bind(email, name || null, await hashPassword(password), newApiKey(), now()).run();
      const uid = res.meta.last_row_id;
      // Claim the invite only if nobody used it in the meantime.
      const claimed = await db.prepare("UPDATE invites SET used_by=?, used_at=? WHERE code=? AND used_by IS NULL")
        .bind(uid, now(), code).run();
      if (!claimed.meta.changes) {
        await db.prepare("DELETE FROM users WHERE id=?").bind(uid).run();
        return notFound();
      }
      return signIn(uid, "/?welcome=1");
    }
    return html(views.signup({ code, google: googleEnabled(cfg) }));
  }

  // ---- extension sign-in: email + password -> the user's API key ----
  if (path === "/api/login" && method === "POST") {
    if (await loginBlocked(db, ip)) return json({ error: "Too many attempts. Try again in 15 minutes." }, 429);
    const body = await readBody(req);
    const u = await db.prepare("SELECT id, email, name, password_hash, api_key FROM users WHERE email=?")
      .bind(String(body.email || "").trim().toLowerCase()).first();
    if (u && u.password_hash === GOOGLE_ONLY) {
      return json({ error: "This account signs in with Google. Use \"Sign in with Google\"." }, 401);
    }
    if (!u || !(await checkPassword(String(body.password || ""), u.password_hash))) {
      await noteLoginFailure(db, ip);
      return json({ error: "Wrong email or password." }, 401);
    }
    return json({ api_key: u.api_key, email: u.email, name: u.name });
  }

  // ---- API for the extension (per-user key) ----
  if (path.startsWith("/api/")) {
    const user = await apiUser(req, db, cfg);
    if (!user) return json({ error: "Sign in again in the MailSpy extension." }, 401);
    const uid = user.id;

    if (path === "/api/me") {
      const prefs = await prefsFor(db, cfg, uid);
      const gm = googleEnabled(cfg) ? await gmailStatus(db, uid) : { connected: false };
      return json({ email: user.email, name: user.name, notify: prefs.notify, track_all_links: prefs.track_all_links, pdf_tiles: prefs.pdf_tiles, gmail: gm.connected });
    }
    if (path === "/api/prepare" && method === "POST") {
      const data = await readBody(req);
      const out = await prepareEmail(db, tbase, uid, data, await prefsFor(db, cfg, uid), base);
      // Auto-try: if this goes to a guessed address, try the next ones if it bounces.
      const plan = out.id && cleanPlan(data);
      if (plan && googleEnabled(cfg) && (await gmailStatus(db, uid)).connected) {
        await startRetry(db, out.id, plan, Number(data.scheduled_at) || null);
        out.retry = true;
      }
      // Gmail sends a few seconds after this; then mark it ✔ in their Sent mail,
      // and swap their Sent copy for one without the tracking image (sentcopy.js).
      // (Anything missed here is picked up by the scheduled sweep.)
      if (out.id && googleEnabled(cfg)) {
        log(new Promise(r => setTimeout(r, 20000)).then(() => labelEmail(env, cfg, out.id))
          .then(() => hideTracking(env, cfg, out.id, [tbase, base])));
      }
      return json(out);
    }
    m = path.match(/^\/api\/docs\/(\d+)\/thumb$/);
    if (m && method === "POST") {
      const len = parseInt(req.headers.get("Content-Length") || "0", 10);
      if (len > MAX_THUMB_BYTES) return json({ error: "Thumbnail too large." }, 413);
      const out = await saveThumb(env, uid, parseInt(m[1], 10), await req.arrayBuffer());
      return json(out, out.error ? 400 : 200);
    }
    if (path === "/api/docs" && method === "POST") {
      const len = parseInt(req.headers.get("Content-Length") || "0", 10);
      if (len > MAX_PDF_BYTES) return json({ error: "PDFs can be up to 15 MB." }, 413);
      let name = "document.pdf";
      try { name = decodeURIComponent(req.headers.get("X-Filename") || name); } catch {}
      const out = await uploadDoc(env, tbase, uid, name, await req.arrayBuffer());
      return json(out, out.error ? 400 : 200);
    }
    if (path === "/api/scheduled" && method === "POST") {
      const body = await readBody(req);
      return json({ ok: await markScheduled(db, uid, String(body.token || ""), body.at) });
    }
    if (path === "/api/selfview" && method === "POST") {
      const body = await readBody(req);
      return json({ ok: await markSelfView(db, uid, String(body.token || "")) });
    }
    // Gmail labels, applied by the user's Apps Script (src/labels.js)
    if (path === "/api/labels") {
      if (method === "POST") return json({ saved: await saveLabels(db, uid, (await readBody(req)).done) });
      return json({ pending: await pendingLabels(db, uid) });
    }
    // Templates, for the Templates pop-up in Gmail compose
    if (path === "/api/templates") {
      if (method === "POST") {
        const out = await saveTemplate(db, uid, await readBody(req));
        return json(out, out.error ? 400 : 200);
      }
      return json(await templatesFor(env, db, user, url.searchParams.get("to") || ""));
    }
    m = path.match(/^\/api\/templates\/(\d+)\/(used|delete)$/);
    if (m && method === "POST") {
      const id = parseInt(m[1], 10);
      if (m[2] === "used") { await markUsed(db, uid, id); return json({ ok: true }); }
      return json({ ok: await deleteTemplate(db, uid, id) });
    }
    // Email finder, for the Find pop-up in Gmail compose
    if (path === "/api/find") {
      const prefs = await prefsFor(db, cfg, uid);
      const q = Object.fromEntries(url.searchParams);
      const name = String(q.name || "").slice(0, 120), company = String(q.company || "").slice(0, 200);
      const r = q.mode === "recruiters" ? await findRecruiters(env, prefs, company) : await findPerson(env, prefs, name, company);
      const gm = googleEnabled(cfg) ? await gmailStatus(db, uid) : { connected: false };
      return json({ ...r, hasKey: !!prefs.hunter_key, gmail: gm.connected });
    }
    // Auto-try progress, asked for by the Gmail tab every few seconds after Send
    if (path === "/api/retry" && method === "POST") {
      const st = await retryByToken(env, cfg, uid, (await readBody(req)).token);
      return st ? json(st) : json({ error: "not found" }, 404);
    }
    if (path === "/api/activity") {
      // "via Gmail" etc. instead of the mail provider's data centre (the extension shows geo as is)
      return json((await db.prepare(ACTIVITY_SQL).bind(uid, 50).all()).results.map(shownActivity));
    }
    if (path === "/api/alerts") {
      const since = parseInt(url.searchParams.get("since") || "", 10);
      const r = Number.isFinite(since)
        ? await db.prepare("SELECT * FROM alerts WHERE user_id=? AND id>? ORDER BY id LIMIT 100").bind(uid, since).all()
        : await db.prepare("SELECT * FROM alerts WHERE user_id=? ORDER BY id DESC LIMIT 100").bind(uid).all();
      return json(r.results);
    }
    if (path === "/api/emails") {
      return json((await db.prepare("SELECT * FROM emails WHERE user_id=? ORDER BY id DESC LIMIT 200").bind(uid).all()).results);
    }
    m = path.match(/^\/api\/emails\/(\d+)$/);
    if (m) {
      const id = parseInt(m[1], 10);
      const e = await db.prepare("SELECT * FROM emails WHERE id=? AND user_id=?").bind(id, uid).first();
      if (!e) return json({ error: "not found" }, 404);
      const [links, events] = await db.batch([
        db.prepare("SELECT * FROM links WHERE email_id=? ORDER BY id").bind(id),
        db.prepare("SELECT * FROM events WHERE email_id=? ORDER BY ts DESC").bind(id),
      ]);
      return json({ email: e, links: links.results, events: events.results.map(v => ({ ...v, geo: placeOf(v) })) });
    }
    return json({ error: "not found" }, 404);
  }

  // ---- everything below needs a signed-in session ----
  const user = await sessionUser(req, db, cfg);
  if (!user && path === "/extension-link") return redirect(googleEnabled(cfg) ? "/auth/google?mode=ext" : cfg.loginPath);
  if (!user) return path === "/" ? redirect(cfg.loginPath) : notFound(); // bare address -> sign in
  const uid = user.id;

  if (path === "/" && method === "GET") {
    const [emails, totals, activity, reminders, maxA, week] = await db.batch([
      db.prepare("SELECT * FROM emails WHERE user_id=? ORDER BY id DESC LIMIT 200").bind(uid),
      db.prepare("SELECT COUNT(*) AS total, SUM(opens>0) AS opened, SUM(opens) AS opens, SUM(clicks) AS clicks FROM emails WHERE user_id=?").bind(uid),
      db.prepare(ACTIVITY_SQL).bind(uid, 30),
      db.prepare("SELECT * FROM alerts WHERE user_id=? AND kind IN ('followup','spike','revived') ORDER BY id DESC LIMIT 6").bind(uid),
      db.prepare("SELECT COALESCE(MAX(id),0) AS m FROM alerts WHERE user_id=?").bind(uid),
      db.prepare("SELECT COUNT(*) AS sent FROM emails WHERE user_id=? AND created_at>=?").bind(uid, now() - 7 * 86400),
    ]);
    return html(views.dashboard({
      user, cfg, prefs: await prefsFor(db, cfg, uid),
      emails: emails.results, totals: totals.results[0] || {}, activity: activity.results,
      reminders: reminders.results, maxAlert: maxA.results[0].m, week: week.results[0] || {},
    }));
  }

  m = path.match(/^\/email\/(\d+)$/);
  if (m && method === "GET") {
    const id = parseInt(m[1], 10);
    const e = await db.prepare("SELECT * FROM emails WHERE id=? AND user_id=?").bind(id, uid).first();
    if (!e) return notFound();
    const [links, events, maxA] = await db.batch([
      db.prepare("SELECT * FROM links WHERE email_id=? ORDER BY id").bind(id),
      db.prepare(`SELECT v.*, l.url FROM events v LEFT JOIN links l ON l.id=v.link_id
                  WHERE v.email_id=? ORDER BY v.ts DESC`).bind(id),
      db.prepare("SELECT COALESCE(MAX(id),0) AS m FROM alerts WHERE user_id=?").bind(uid),
    ]);
    return html(views.emailPage({
      user, prefs: await prefsFor(db, cfg, uid), email: e, links: links.results, events: events.results, maxAlert: maxA.results[0].m, base,
    }));
  }

  if (path === "/live" && method === "GET") {
    const since = parseInt(url.searchParams.get("since") || "0", 10) || 0;
    const r = await db.prepare(
      "SELECT id, email_id, kind, message, ts FROM alerts WHERE user_id=? AND id>? ORDER BY id LIMIT 20")
      .bind(uid, since).all();
    const max = r.results.length ? r.results[r.results.length - 1].id : since;
    return json({ alerts: r.results, max });
  }

  if (path === "/compose") {
    if (method === "POST") {
      const form = await readBody(req);
      if (!form.to || !form.subject) {
        return html(views.compose({ user, notice: '<div class="note bad">To and subject are required.</div>', form }));
      }
      const data = { to: form.to, to_name: form.to_name, subject: form.subject };
      if (form.fmt === "html") data.html = form.body || ""; else data.text = form.body || "";
      const out = await prepareEmail(db, tbase, uid, data, null, base);
      return html(views.compose({
        user, notice: `<div class="note ok">Tracked email #${out.id} created. It is tracked from now on.</div>`,
        form, result: out.html,
      }));
    }
    return html(views.compose({ user }));
  }

  if (path === "/report" && method === "GET") {
    const until = now();
    const since = until - 7 * 86400;
    const [sent, opened, clicks, bots, top] = await db.batch([
      db.prepare("SELECT COUNT(*) AS n FROM emails WHERE user_id=? AND created_at>=?").bind(uid, since),
      db.prepare("SELECT COUNT(*) AS n FROM emails WHERE user_id=? AND created_at>=? AND opens>0").bind(uid, since),
      db.prepare(`SELECT COUNT(*) AS n FROM events v JOIN emails e ON e.id=v.email_id
                  WHERE e.user_id=? AND v.kind='click' AND v.is_bot=0 AND v.ts>=?`).bind(uid, since),
      db.prepare(`SELECT COUNT(*) AS n FROM events v JOIN emails e ON e.id=v.email_id
                  WHERE e.user_id=? AND v.is_bot=1 AND v.ts>=?`).bind(uid, since),
      db.prepare(`SELECT e.id, e.subject, e.to_addr, COUNT(*) AS opens FROM events v JOIN emails e ON e.id=v.email_id
                  WHERE e.user_id=? AND v.kind='open' AND v.is_bot=0 AND v.ts>=? GROUP BY e.id ORDER BY opens DESC LIMIT 5`).bind(uid, since),
    ]);
    return html(views.report({
      user, sent: sent.results[0].n, opened: opened.results[0].n, clicks: clicks.results[0].n,
      bots: bots.results[0].n, top: top.results, since, until,
    }));
  }

  if (path === "/settings") {
    let notice = "";
    if (method === "POST") {
      const form = await readBody(req);
      if (form.action === "theme") {
        const t = ["light", "dark"].includes(form.theme) ? form.theme : null; // null = follow the device
        await db.prepare("UPDATE users SET theme=? WHERE id=?").bind(t, uid).run();
        user.theme = t;
        if (req.headers.get("X-Autosave")) return json({ ok: true });
        notice = '<div class="note ok">Appearance saved.</div>';
      } else if (form.action === "prefs") {
        const prefs = prefsFromForm(cfg, form);
        await db.prepare("UPDATE users SET prefs=? WHERE id=?").bind(JSON.stringify(prefs), uid).run();
        if (req.headers.get("X-Autosave")) return json({ ok: true });   // settings page saves as you go
        notice = '<div class="note ok">Settings saved.</div>';
      } else if (form.action === "gmail_disconnect") {
        await disconnectGmail(db, cfg, uid);
        notice = '<div class="note ok">Gmail disconnected. MailSpy will no longer add ✔ labels.</div>';
      } else {
        const row = await db.prepare("SELECT password_hash FROM users WHERE id=?").bind(uid).first();
        const pw = String(form.new_password || "");
        const googleOnly = row.password_hash === GOOGLE_ONLY;   // made with Google: no current password to check
        if (!googleOnly && !(await checkPassword(String(form.current_password || ""), row.password_hash))) notice = '<div class="note bad">Your current password is wrong.</div>';
        else if (pw.length < 10) notice = '<div class="note bad">Use a new password of at least 10 characters.</div>';
        else if (pw !== String(form.new_password2 || "")) notice = '<div class="note bad">The two new passwords don\'t match.</div>';
        else {
          await db.prepare("UPDATE users SET password_hash=? WHERE id=?").bind(await hashPassword(pw), uid).run();
          notice = '<div class="note ok">Password changed.</div>';
        }
      }
    }
    if (url.searchParams.get("gmail")) notice = '<div class="note ok">Gmail connected. Your tracked emails will get ✔ when sent and ✔✔ when opened.</div>';
    const pwRow = await db.prepare("SELECT password_hash FROM users WHERE id=?").bind(uid).first();
    const gmailInfo = { enabled: googleEnabled(cfg), ...(googleEnabled(cfg) ? await gmailStatus(db, uid) : {}) };
    return html(views.settingsPage({ cfg, base, user, prefs: await prefsFor(db, cfg, uid), ip, notice,
      gmail: gmailInfo, hasPassword: pwRow.password_hash !== GOOGLE_ONLY }));
  }

  // ---- the extension signs in through here (after Sign in with Google) ----
  // A content script in the extension reads the key from this page.
  if (path === "/extension-link") {
    return new Response(views.extensionLink(user), { headers: {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin" } });
  }

  // ---- documents ----
  if (path === "/docs" || path === "/docs/upload") {
    let notice = "", created = null;
    if (path === "/docs/upload" && method === "POST") {
      const form = await readBody(req);
      const file = form.file;
      if (!file || typeof file.arrayBuffer !== "function") notice = '<div class="note bad">Choose a PDF to upload.</div>';
      else {
        const out = await uploadDoc(env, tbase, uid, file.name, await file.arrayBuffer());
        if (out.error) notice = `<div class="note bad">${esc(out.error)}</div>`; else created = out;
      }
    }
    const docs = await db.prepare(`SELECT d.*,
        (SELECT COUNT(*) FROM doc_views v WHERE v.doc_id=d.id AND v.is_self=0) AS views,
        (SELECT SUM(seconds) FROM doc_views v WHERE v.doc_id=d.id AND v.is_self=0) AS seconds,
        (SELECT MAX(ts) FROM doc_views v WHERE v.doc_id=d.id AND v.is_self=0) AS last_view
      FROM docs d WHERE d.user_id=? ORDER BY d.id DESC`).bind(uid).all();
    return html(views.docsPage({ user, base: tbase, docs: docs.results, notice, created }));
  }
  m = path.match(/^\/docs\/(\d+)(\/delete)?$/);
  if (m) {
    const id = parseInt(m[1], 10);
    if (m[2]) {
      if (method === "POST") await deleteDoc(env, uid, id);
      return redirect("/docs");
    }
    const doc = await db.prepare("SELECT * FROM docs WHERE id=? AND user_id=?").bind(id, uid).first();
    if (!doc) return notFound();
    const v = await db.prepare(`SELECT v.*, e.to_addr, e.to_name FROM doc_views v LEFT JOIN emails e ON e.id=v.email_id
      WHERE v.doc_id=? ORDER BY v.ts DESC`).bind(id).all();
    return html(views.docPage({ user, base: tbase, doc, views: v.results }));
  }

  // ---- tracked links ----
  // ---- email finder ----
  if (path === "/find") {
    const prefs = await prefsFor(db, cfg, uid);
    const q = Object.fromEntries(url.searchParams);
    const form = { mode: q.mode === "person" ? "person" : "recruiters", name: (q.name || "").slice(0, 120), company: (q.company || "").slice(0, 200) };
    let result = null;
    if (form.company.trim()) {
      result = form.mode === "person"
        ? await findPerson(env, prefs, form.name, form.company)
        : await findRecruiters(env, prefs, form.company);
    }
    return html(views.findPage({ user, hasKey: !!prefs.hunter_key, form, result }));
  }

  if (path === "/links") {
    let notice = "", created = null, form = {};
    if (method === "POST") {
      form = await readBody(req);
      const out = await createLink(db, uid, form.url, form.label);
      if (out.error) notice = `<div class="note bad">${esc(out.error)}</div>`; else { created = out; form = {}; }
    }
    const links = await db.prepare(`SELECT l.*,
        (SELECT COUNT(*) FROM tlink_clicks c WHERE c.tlink_id=l.id AND c.is_bot=0) AS clicks,
        (SELECT MAX(ts) FROM tlink_clicks c WHERE c.tlink_id=l.id AND c.is_bot=0) AS last_click
      FROM tlinks l WHERE l.user_id=? ORDER BY l.id DESC`).bind(uid).all();
    return html(views.linksPage({ user, base: tbase, links: links.results, notice, created, form }));
  }
  m = path.match(/^\/links\/(\d+)(\/delete)?$/);
  if (m) {
    const id = parseInt(m[1], 10);
    if (m[2]) {
      if (method === "POST") await deleteLink(db, uid, id);
      return redirect("/links");
    }
    const link = await db.prepare("SELECT * FROM tlinks WHERE id=? AND user_id=?").bind(id, uid).first();
    if (!link) return notFound();
    const c = await db.prepare("SELECT * FROM tlink_clicks WHERE tlink_id=? ORDER BY ts DESC LIMIT 500").bind(id).all();
    return html(views.linkPage({ user, base: tbase, link, clicks: c.results }));
  }

  // ---- templates ----
  if (path === "/templates" || path === "/templates/new") {
    let notice = "", form = null;
    if (method === "POST") {
      const data = await readBody(req);
      const out = await saveTemplate(db, uid, data);
      if (out.error) { notice = `<div class="note bad">${esc(out.error)}</div>`; form = data; }
      else return redirect("/templates?saved=1");
    }
    if (path === "/templates/new" || form) {
      return html(views.templateEdit({ user, t: form || { scope_type: url.searchParams.get("for") ? "company" : "any", scope_value: url.searchParams.get("for") || "" }, notice, isNew: true }));
    }
    if (url.searchParams.get("saved")) notice = `<div class="note ok">Template saved.</div>`;
    if (url.searchParams.get("deleted")) notice = `<div class="note ok">Template deleted.</div>`;
    return html(views.templatesPage({ user, templates: await listTemplates(db, uid), notice }));
  }
  m = path.match(/^\/templates\/(\d+)(\/delete)?$/);
  if (m) {
    const id = parseInt(m[1], 10);
    if (m[2]) {
      if (method === "POST") await deleteTemplate(db, uid, id);
      return redirect("/templates?deleted=1");
    }
    let notice = "", t = await getTemplate(db, uid, id);
    if (!t) return notFound();
    if (method === "POST") {
      const data = await readBody(req);
      const out = await saveTemplate(db, uid, data, id);
      if (out.error) { notice = `<div class="note bad">${esc(out.error)}</div>`; t = { ...t, ...data }; }
      else return redirect("/templates?saved=1");
    }
    return html(views.templateEdit({ user, t, notice, isNew: false }));
  }

  // ---- admin: invites and accounts (owner only) ----
  if (path === "/admin" || path.startsWith("/admin/")) {
    if (!user.is_admin) return notFound();
    let notice = "", created = null;
    if (method === "POST") {
      const form = await readBody(req);
      if (path === "/admin/invite") {
        created = newInviteCode();
        await db.prepare("INSERT INTO invites(code,note,created_at) VALUES(?,?,?)")
          .bind(created, String(form.note || "").trim() || null, now()).run();
      } else if (path === "/admin/invite/revoke") {
        await db.prepare("DELETE FROM invites WHERE code=? AND used_by IS NULL").bind(String(form.code || "")).run();
        notice = '<div class="note ok">Invite revoked.</div>';
      } else if (path === "/admin/user/reset") {
        const target = parseInt(form.id, 10);
        const temp = newInviteCode();
        const r = await db.prepare("UPDATE users SET password_hash=? WHERE id=? AND is_admin=0")
          .bind(await hashPassword(temp), target).run();
        const who = await db.prepare("SELECT email FROM users WHERE id=?").bind(target).first();
        notice = r.meta.changes
          ? `<div class="note ok">Temporary password for <b>${esc(who.email)}</b>: <code>${esc(temp)}</code><br>Send it to them privately. They can change it under Settings.</div>`
          : '<div class="note bad">Could not reset that account.</div>';
      } else if (path === "/admin/user/delete") {
        const target = parseInt(form.id, 10);
        const who = await db.prepare("SELECT email FROM users WHERE id=? AND is_admin=0").bind(target).first();
        if (who) {
          const ids = "SELECT id FROM emails WHERE user_id=?1";
          await db.batch([
            db.prepare(`DELETE FROM events WHERE email_id IN (${ids})`).bind(target),
            db.prepare(`DELETE FROM links WHERE email_id IN (${ids})`).bind(target),
            db.prepare(`DELETE FROM self_views WHERE email_id IN (${ids})`).bind(target),
            db.prepare("DELETE FROM alerts WHERE user_id=?").bind(target),
            db.prepare("DELETE FROM doc_views WHERE doc_id IN (SELECT id FROM docs WHERE user_id=?1)").bind(target),
            db.prepare("DELETE FROM docs WHERE user_id=?").bind(target),
            db.prepare("DELETE FROM tlink_clicks WHERE tlink_id IN (SELECT id FROM tlinks WHERE user_id=?1)").bind(target),
            db.prepare("DELETE FROM tlinks WHERE user_id=?").bind(target),
            db.prepare("DELETE FROM emails WHERE user_id=?").bind(target),
            db.prepare("DELETE FROM users WHERE id=?").bind(target),
          ]);
          notice = `<div class="note ok">Removed ${esc(who.email)} and all of their tracking data.</div>`;
        }
      }
    }
    const [users, invites] = await db.batch([
      db.prepare(`SELECT u.id, u.email, u.name, u.is_admin, u.created_at,
                    (SELECT COUNT(*) FROM emails e WHERE e.user_id=u.id) AS emails,
                    (SELECT MAX(created_at) FROM emails e WHERE e.user_id=u.id) AS last_sent
                  FROM users u ORDER BY u.id`),
      db.prepare(`SELECT i.*, u.email AS used_email FROM invites i LEFT JOIN users u ON u.id=i.used_by
                  ORDER BY i.created_at DESC LIMIT 50`),
    ]);
    return html(views.adminPage({ user, base, users: users.results, invites: invites.results, notice, created }));
  }

  return notFound();
}

export default {
  async fetch(req, env, ctx) {
    try {
      return await handle(req, env, ctx);
    } catch (err) {
      console.error(err);
      return new Response("Internal Error", { status: 500 });
    }
  },
  async scheduled(event, env, ctx) {
    const cfg = settings(env);
    ctx.waitUntil(runScheduled(env.DB, cfg));
    // Labels first: the Sent-copy swap needs the message the label sweep finds.
    ctx.waitUntil(sweepLabels(env, cfg).catch(err => console.error("label sweep:", err))
      .then(() => sweepSentCopies(env, cfg)).catch(err => console.error("sent copy sweep:", err)));
    ctx.waitUntil(sweepRetries(env, cfg).catch(err => console.error("auto-try sweep:", err)));
  },
};
