// MailSpy content script for Gmail.
//
// When you click Send, this:
//   1. reads the recipient, subject and body from the compose window,
//   2. asks your MailSpy server to register the email and return tracked HTML
//      (invisible pixel + the links you chose to track, rewritten),
//   3. swaps that HTML into the compose body,
//   4. lets Gmail send as normal.
//
// Gmail's DOM is not a public API, so the selectors below are best-effort and
// may need a tweak if Google changes their markup. Everything is wrapped in
// try/catch so a failure never blocks your email — it just sends untracked.

// ---------------------------------------------------------------------------
// Only one live copy of this script per tab.
// After the extension reloads itself (auto-update), the old copy is orphaned:
// its chrome.runtime.id becomes undefined. The new copy, injected by the
// background worker, checks that and takes over; the old copy's handlers all
// bail out through alive().
// ---------------------------------------------------------------------------
function alive() { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } }
if (window.__mailspy && window.__mailspy.alive()) {
  throw new Error("MailSpy already running in this tab");
}
window.__mailspy = { alive };

var SKIP = "data-mailspy-sent";
var TOKEN = "data-mailspy-token";

var MAILSPY_SERVER = "https://mailspy.aryanh.dev";
var TRACK_HOST = "go.aryanh.dev";   // the short-link address used inside emails

// { server, apiKey } for the signed-in account (same storage as config.js).
async function cfg() {
  let { apiKey } = await chrome.storage.local.get(["apiKey"]);
  if (!apiKey) apiKey = (await chrome.storage.sync.get(["apiKey"])).apiKey || "";
  return { server: MAILSPY_SERVER, apiKey };
}

function composeRoot(el) {
  // climb to the dialog/compose container that holds this send button
  return el.closest("[role=dialog]") || el.closest(".iN") || el.closest(".nH") || document;
}

function findBody(root) {
  return root.querySelector('div[aria-label="Message Body"]')
      || root.querySelector('div[g_editable="true"]')
      || root.querySelector('div[role="textbox"][contenteditable="true"]');
}

function findRecipient(root) {
  // chips first (modern Gmail: [email], or role=option with data-hovercard-id), then raw text
  const chip = root.querySelector('[email]');
  if (chip) return chip.getAttribute("email");
  const opt = root.querySelector('[role=option][data-hovercard-id*="@"]');
  if (opt) return opt.getAttribute("data-hovercard-id");
  const typed = root.querySelector('input[aria-label="To recipients"]');
  const m = typed && typed.value.match(/[^\s,<>;"']+@[^\s,<>;"']+\.[a-z]{2,}/i);
  if (m) return m[0];
  const ta = root.querySelector('textarea[name="to"]');
  if (ta && ta.value) return ta.value.split(",")[0].trim();
  const span = root.querySelector('span[email]');
  return span ? span.getAttribute("email") : "";
}

function findSubject(root) {
  const s = root.querySelector('input[name="subjectbox"]');
  return s ? s.value : "(no subject)";
}

// Auto-try plans prepared from the "More send options" menu, not started yet:
// they start on a plain Send, or show "Scheduled" if you schedule instead.
const pendingTry = new Map();   // email token -> plan
function startPendingTry(body) {
  const token = body && body.getAttribute(TOKEN);
  const mc = window.__mailspyCompose;
  if (!token || !pendingTry.has(token) || !mc || !mc.watchRetry) return;
  const plan = pendingTry.get(token);
  pendingTry.delete(token);
  mc.watchRetry(token, plan, body);
}

async function trackCompose(root, opts) {
  const body = findBody(root);
  if (!body || body.getAttribute(SKIP)) return true; // already processed
  // A saved draft that was tracked before (reopened from Drafts, or a scheduled
  // email you cancelled): it already has our image, so reuse that email
  // instead of adding a second one.
  const existing = [...body.querySelectorAll("img")].map(pixelToken).find(Boolean);
  if (existing) {
    body.setAttribute(SKIP, "1");
    body.setAttribute(TOKEN, existing);
    // Sent right now (not scheduled): its send time is now, not when it was first tracked.
    if (!(opts && opts.deferWatch)) api("/api/scheduled", { token: existing, at: Math.floor(Date.now() / 1000) });
    return true;
  }
  // Attached PDFs marked "Tracked" become tracked attachment tiles (gmail-compose.js).
  // Capped at 90 seconds so a slow upload never holds the email back for long.
  if (window.__mailspyCompose && window.__mailspyCompose.convertPdfs) {
    try {
      await Promise.race([window.__mailspyCompose.convertPdfs(root), new Promise(r => setTimeout(r, 90000))]);
    } catch (e) { console.warn("MailSpy: PDF tracking skipped", e); }
  }
  const to = findRecipient(root);
  const subject = findSubject(root);
  const { server, apiKey } = await cfg();
  if (!server || !apiKey) {
    console.warn("MailSpy: not signed in. Click the MailSpy icon to sign in.");
    return true; // let it send untracked rather than block
  }
  // Links you switched "Track clicks" on (or off) for, from gmail-compose.js.
  // The marker attribute is removed so it never goes out in the email.
  const track_urls = [], untrack_urls = [];
  body.querySelectorAll("a[data-mailspy-track]").forEach(a => {
    const href = (a.getAttribute("href") || "").trim();
    (a.getAttribute("data-mailspy-track") === "1" ? track_urls : untrack_urls).push(href);
    a.removeAttribute("data-mailspy-track");
  });
  // Auto-try plan from the finder ("Try the top N until one works"), if it still applies.
  const mc = window.__mailspyCompose;
  const plan = mc && mc.retryPlan ? mc.retryPlan(root) : null;
  const resp = await fetch(server.replace(/\/$/, "") + "/api/prepare", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify({ to, subject, html: body.innerHTML, track_urls, untrack_urls, retry: plan || undefined })
  });
  if (!resp.ok) { console.warn("MailSpy: prepare failed", resp.status); return true; }
  const data = await resp.json();
  if (data.skipped) {                  // recipient is on your "don't track" list
    body.setAttribute(SKIP, "1");
    return true;
  }
  body.innerHTML = data.html;          // tracked pixel + rewritten links
  body.setAttribute(SKIP, "1");
  body.setAttribute(TOKEN, data.token);
  if (data.retry && plan) {
    if (opts && opts.deferWatch) pendingTry.set(data.token, plan);   // scheduling, maybe: wait and see
    else if (mc.watchRetry) mc.watchRetry(data.token, plan, root);
  }
  chrome.runtime.sendMessage("poll");  // wake the alert poller
  window.dispatchEvent(new Event("mailspy:sent"));   // gmail-checks.js: show the checkmark soon
  return true;
}

async function api(path, payload) {
  const { server, apiKey } = await cfg();
  if (!server || !apiKey) return null;
  try {
    const r = await fetch(server.replace(/\/$/, "") + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify(payload)
    });
    return r.ok ? r.json() : null;
  } catch (e) { return null; }
}

// Intercept the Send button in the capture phase so we can do async work first.
document.addEventListener("click", async (ev) => {
  if (!alive()) return;
  const btn = ev.target.closest('[role=button]');
  if (!btn) return;
  const tip = (btn.getAttribute("data-tooltip") || btn.getAttribute("aria-label") || "");
  if (!/^Send\b/i.test(tip)) return;
  const root = composeRoot(btn);
  const body = findBody(root);
  if (body && body.getAttribute(SKIP)) { startPendingTry(body); return; } // our own re-dispatched click (or Send after the menu)

  ev.preventDefault();
  ev.stopImmediatePropagation();
  try { await trackCompose(root); } catch (e) { console.warn("MailSpy:", e); }
  // re-dispatch the send now that the body is tracked
  btn.click();
}, true);

// ---------------------------------------------------------------------------
// Scheduled sends.
// Gmail's "Schedule send" lives behind the small arrow next to Send. When you
// open that menu, the body is tracked right away (harmless if you then send
// normally). When you choose "Schedule send", the email is marked scheduled,
// and Gmail's "Send scheduled for …" confirmation gives us the time.
// ---------------------------------------------------------------------------
var lastScheduledToken = null;

document.addEventListener("click", async (ev) => {
  if (!alive()) return;
  const btn = ev.target.closest('[role=button]');
  if (!btn) return;
  const tip = (btn.getAttribute("data-tooltip") || btn.getAttribute("aria-label") || "");
  if (!/^More send options/i.test(tip)) return;
  const root = composeRoot(btn);
  const body = findBody(root);
  if (!body || body.getAttribute(SKIP)) return;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  try { await trackCompose(root, { deferWatch: true }); } catch (e) { console.warn("MailSpy:", e); }
  btn.click(); // open the menu now that the body is tracked
}, true);

document.addEventListener("click", (ev) => {
  if (!alive()) return;
  const item = ev.target.closest('[role=menuitem]');
  if (!item || !/schedule send/i.test(item.textContent || "")) return;
  // Find the compose window this menu belongs to: the one with a tracked,
  // not-yet-scheduled body.
  const bodies = [...document.querySelectorAll(`[${TOKEN}]`)];
  const body = bodies[bodies.length - 1];
  if (!body) return;
  lastScheduledToken = body.getAttribute(TOKEN);
  api("/api/scheduled", { token: lastScheduledToken, at: null });
}, true);

// "Send scheduled for Tomorrow, 8:00 AM" / "Mon, Nov 10, 8:00 AM" / "Nov 10, 2026, 8:00 AM"
function parseGmailSchedule(text) {
  const m = text.match(/Send scheduled for\s+(.+?)(?:\s*[\.·]|$)/i);
  if (!m) return null;
  let s = m[1].replace(/\s+/g, " ").trim();
  const now = new Date();
  const time = s.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
  if (!time) return null;
  let h = parseInt(time[1], 10) % 12 + (/pm/i.test(time[3]) ? 12 : 0);
  const min = parseInt(time[2] || "0", 10);
  let d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min);
  const datePart = s.slice(0, time.index).replace(/,\s*$/, "").trim();
  if (/^tomorrow$/i.test(datePart)) d.setDate(d.getDate() + 1);
  else if (/^today$/i.test(datePart) || datePart === "") { /* today */ }
  else {
    const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
    const md = datePart.match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?/);
    const wd = datePart.match(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)/i);
    if (md && months.includes(md[1].toLowerCase())) {
      const year = md[3] ? parseInt(md[3], 10) : now.getFullYear();
      d = new Date(year, months.indexOf(md[1].toLowerCase()), parseInt(md[2], 10), h, min);
      if (!md[3] && d < now) d.setFullYear(d.getFullYear() + 1);
    } else if (wd) {
      const days = ["sun","mon","tue","wed","thu","fri","sat"];
      let diff = (days.indexOf(wd[1].toLowerCase()) - now.getDay() + 7) % 7;
      if (diff === 0) diff = 7;
      d.setDate(d.getDate() + diff);
    } else return null;
  }
  if (d < now) d.setDate(d.getDate() + 1);
  return Math.floor(d.getTime() / 1000);
}

function watchScheduleToast(node) {
  if (node.nodeType !== 1) return;
  const text = node.textContent || "";
  if (!/Send scheduled for/i.test(text) || !lastScheduledToken) return;
  const at = parseGmailSchedule(text);
  const token = lastScheduledToken;
  lastScheduledToken = null;
  api("/api/scheduled", { token, at });
  // auto-try runs on MailSpy's side when it sends; just say so
  const mc = window.__mailspyCompose;
  if (pendingTry.has(token) && mc && mc.scheduledTry) {
    const when = (text.match(/Send scheduled for\s+(.+?)(?:\s*(?:Undo|View message)|$)/i) || [])[1] || "later";
    mc.scheduledTry(pendingTry.get(token), when.trim());
    pendingTry.delete(token);
  }
}

// Ctrl+Enter / Cmd+Enter send shortcut
document.addEventListener("keydown", async (ev) => {
  if (!alive()) return;
  if (!(ev.key === "Enter" && (ev.ctrlKey || ev.metaKey))) return;
  const root = composeRoot(ev.target);
  const body = findBody(root);
  if (!body) return;
  if (body.getAttribute(SKIP)) { startPendingTry(body); return; }
  ev.preventDefault();
  ev.stopImmediatePropagation();
  try { await trackCompose(root); } catch (e) { console.warn("MailSpy:", e); }
  const send = root.querySelector('[data-tooltip^="Send"],[aria-label^="Send"]');
  if (send) send.click();
}, true);

// Space or Enter on a focused Send button (Tab to Send, then a key). Gmail
// sends on these without a click, so catch them too, or the email would go
// out untracked. Gmail may act on keydown or keyup, so both are held back
// while MailSpy tracks the email, then Send is clicked as usual.
function focusedSend(ev) {
  if (ev.key !== " " && ev.key !== "Enter" && ev.key !== "Spacebar") return null;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return null;
  const btn = ev.target && ev.target.closest && ev.target.closest("[role=button]");
  if (!btn) return null;
  const tip = btn.getAttribute("data-tooltip") || btn.getAttribute("aria-label") || "";
  return /^Send\b/i.test(tip) ? btn : null;
}
document.addEventListener("keydown", async (ev) => {
  if (!alive()) return;
  const btn = focusedSend(ev);
  if (!btn) return;
  const root = composeRoot(btn);
  const body = findBody(root);
  if (!body) return;
  if (body.getAttribute(SKIP)) { startPendingTry(body); return; }   // already tracked: let Gmail send
  ev.preventDefault();
  ev.stopImmediatePropagation();
  try { await trackCompose(root); } catch (e) { console.warn("MailSpy:", e); }
  btn.click();
}, true);
document.addEventListener("keyup", (ev) => {
  if (!alive()) return;
  const btn = focusedSend(ev);
  if (!btn) return;
  const body = findBody(composeRoot(btn));
  if (body && !body.getAttribute(SKIP)) { ev.preventDefault(); ev.stopImmediatePropagation(); }
}, true);

// ---------------------------------------------------------------------------
// Self-open prevention.
// When you look at a message you sent (Sent folder, or the thread right after
// sending), Gmail loads the tracking pixel through its image proxy, which would
// look exactly like the recipient opening it. Gmail keeps the original image URL
// after a "#" in the proxied src, so we can spot our pixel, hide it, and tell
// the server "that was me" so the open is not counted.
// ---------------------------------------------------------------------------
var serverHost = "";
var reported = new Set();

async function reportSelfView(token) {
  if (reported.has(token)) return;
  reported.add(token);
  setTimeout(() => reported.delete(token), 60000);
  const { server, apiKey } = await cfg();
  if (!server || !apiKey) return;
  fetch(server.replace(/\/$/, "") + "/api/selfview", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify({ token })
  }).catch(() => {});
}

// The token of our tracking image, whether its src is our own address or
// Gmail's image proxy (which keeps the original address after a "#").
function pixelToken(img) {
  const src = (img && img.getAttribute && img.getAttribute("src")) || "";
  if (!(src.includes(TRACK_HOST) || (serverHost && src.includes(serverHost)))) return null;
  const m = src.match(/\/(?:t|img)\/([A-Za-z0-9_-]{8,})\.gif/);
  return m ? m[1] : null;
}

// Our image inside a compose window (a new email, or a draft you reopened):
// Gmail loads it right away, through its image proxy for a saved draft, which
// looks exactly like the recipient opening it. Tell the server it's you. The
// image has to stay in, since it's the copy that gets sent. Repeated (at most
// every 5 seconds per email) for as long as the window is open, because Gmail
// reloads the image when it redraws the compose window.
var composeReported = new Map();   // token -> last report time
function reportComposeView(token) {
  const t = Date.now();
  if (t - (composeReported.get(token) || 0) < 5000) return;
  composeReported.set(token, t);
  cfg().then(({ server, apiKey }) => {
    if (!server || !apiKey) return;
    fetch(server.replace(/\/$/, "") + "/api/selfview", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ token })
    }).catch(() => {});
  });
}
setInterval(() => {
  if (!alive()) return;
  document.querySelectorAll('[contenteditable="true"] img').forEach(img => {
    const tk = pixelToken(img);
    if (tk && img.offsetParent !== null) reportComposeView(tk);
  });
}, 10000);

function checkImg(img) {
  const token = pixelToken(img);
  if (!token) return;
  if (img.closest('[contenteditable="true"]')) { reportComposeView(token); return; } // the copy you are about to send
  img.removeAttribute("src");
  img.remove();
  reportSelfView(token);
}

function scan(node) {
  if (node.nodeType !== 1) return;
  if (node.tagName === "IMG") checkImg(node);
  else node.querySelectorAll("img").forEach(checkImg);
}

cfg().then(({ server }) => {
  try { serverHost = new URL(server).host; } catch (e) { return; }
  scan(document.documentElement);
  const mo = new MutationObserver(muts => {
    if (!alive()) { mo.disconnect(); return; }
    for (const m of muts) {
      if (m.type === "attributes") { if (m.target.tagName === "IMG") checkImg(m.target); }
      else m.addedNodes.forEach(n => { scan(n); watchScheduleToast(n); });
    }
  });
  mo.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ["src"]
  });
});

console.log("MailSpy for Gmail active.");
