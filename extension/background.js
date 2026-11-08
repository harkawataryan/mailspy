// MailSpy background service worker.
//
// Every 30 seconds:
//   * fetches alerts newer than the last one seen and shows each as a desktop
//     notification;
//   * asks the server which extension version is current. If this copy is
//     behind, it updates: a Chrome Web Store install asks Chrome to fetch the
//     update now; an unpacked (developer) install reloads itself from its folder.

importScripts("config.js");

const NOTIFY = ["open", "click", "doc", "link", "spike", "revived", "followup", "retry"];
const BADGE_KINDS = ["open", "click", "doc", "link"];

// Your notification choices from Settings, refreshed every 10 minutes.
async function notifyPrefs(apiKey) {
  const { notifyCache, notifyAt = 0 } = await chrome.storage.local.get(["notifyCache", "notifyAt"]);
  if (notifyCache && Date.now() - notifyAt < 600000) return notifyCache;
  try {
    const r = await fetch(`${SERVER}/api/me`, { headers: { "X-API-Key": apiKey } });
    if (r.ok) {
      const d = await r.json();
      await chrome.storage.local.set({ notifyCache: d.notify || null, notifyAt: Date.now() });
      return d.notify || null;
    }
  } catch (e) {}
  return notifyCache || null;
}
const GMAIL = "https://mail.google.com/*";
const FROM_STORE = !!chrome.runtime.getManifest().update_url;

function newer(a, b) { // is version a newer than b?
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

// Red badge on the toolbar icon: how many emails (or PDFs / links) have new
// activity since you last looked. "!" means you need to sign in.
let signedIn = true;

async function updateBadge() {
  chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
  if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: "#ffffff" });
  if (!signedIn) {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setTitle({ title: "MailSpy: click to sign in" });
    return;
  }
  const { unseen = 0 } = await chrome.storage.local.get("unseen");
  chrome.action.setBadgeText({ text: unseen ? (unseen > 99 ? "99+" : String(unseen)) : "" });
  chrome.action.setTitle({ title: unseen ? `MailSpy: ${unseen} with new activity` : "MailSpy" });
}

function setSignedInBadge(ok) {
  signedIn = ok;
  updateBadge();
}

// One entry per email (or per PDF view / link click that isn't tied to an email).
function activityKey(a) {
  return a.email_id ? "e:" + a.email_id : "a:" + a.id;
}

async function pollAlerts(apiKey) {
  const { lastAlertId } = await chrome.storage.local.get("lastAlertId");
  const firstRun = lastAlertId === undefined;
  const r = await fetch(`${SERVER}/api/alerts?since=${firstRun ? 0 : lastAlertId}`, { headers: { "X-API-Key": apiKey } });
  if (r.status === 401) { setSignedInBadge(false); return; }
  if (!r.ok) return;
  setSignedInBadge(true);
  const alerts = (await r.json()).sort((a, b) => a.id - b.id);
  if (!alerts.length) {
    if (firstRun) await chrome.storage.local.set({ lastAlertId: 0 });
    return;
  }
  if (!firstRun) {
    // count emails with new activity for the badges (toolbar icon and Gmail button)
    const fresh = alerts.filter(a => BADGE_KINDS.includes(a.kind)).map(activityKey);
    if (fresh.length) {
      const { unseenKeys = [] } = await chrome.storage.local.get("unseenKeys");
      const keys = [...new Set([...unseenKeys, ...fresh])].slice(-500);
      await chrome.storage.local.set({ unseenKeys: keys, unseen: keys.length });
    }
    const notify = await notifyPrefs(apiKey);
    for (const a of alerts) {
      if (!NOTIFY.includes(a.kind)) continue;
      if (notify && notify[a.kind] === false) continue;
      chrome.notifications.create("mailspy-" + a.id, {
        type: "basic", iconUrl: "icon128.png", title: "MailSpy", message: a.message, priority: 1,
      });
    }
  }
  // On first run just remember where we are, so old alerts don't flood you.
  await chrome.storage.local.set({ lastAlertId: alerts[alerts.length - 1].id });
}

async function checkVersion() {
  const r = await fetch(`${SERVER}/api/version`);
  if (!r.ok) return;
  const { version } = await r.json();
  const mine = chrome.runtime.getManifest().version;
  if (!version || !newer(version, mine)) return;
  if (FROM_STORE) {
    // Ask Chrome to fetch the update from the Web Store now (at most hourly).
    // If one is ready, onUpdateAvailable below reloads into it.
    const { lastUpdateCheck = 0 } = await chrome.storage.local.get("lastUpdateCheck");
    if (Date.now() - lastUpdateCheck < 3600 * 1000) return;
    await chrome.storage.local.set({ lastUpdateCheck: Date.now() });
    chrome.runtime.requestUpdateCheck(() => void chrome.runtime.lastError);
  } else {
    // Unpacked: the folder already has the new files. Reload once per version.
    const { reloadedFor } = await chrome.storage.local.get("reloadedFor");
    if (reloadedFor === version) return;
    await chrome.storage.local.set({ reloadedFor: version });
    chrome.runtime.reload();
  }
}

async function poll() {
  const { apiKey } = await getAuth();
  if (!apiKey) { setSignedInBadge(false); return; }
  try { await pollAlerts(apiKey); } catch (e) { /* offline; next time */ }
  try { await checkVersion(); } catch (e) { /* ignore */ }
}

// After an update the old content script in open Gmail tabs is cut off.
// Put a fresh one in so nobody has to reload Gmail.
async function reattach() {
  try {
    for (const t of await chrome.tabs.query({ url: GMAIL })) {
      try { await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["content.js", "gmail-button.js", "finder-ui.js", "gmail-compose.js"] }); } catch (e) {}
    }
  } catch (e) {}
}

function start() {
  chrome.alarms.create("poll", { periodInMinutes: 0.5 });
  updateBadge();
  poll();
  reattach();
}

chrome.runtime.onInstalled.addListener(async (details) => {
  start();
  // First install: go straight to sign-in.
  if (details.reason === "install" && !(await getAuth()).apiKey) chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(start);
chrome.runtime.onUpdateAvailable.addListener(() => chrome.runtime.reload());
chrome.alarms.onAlarm.addListener(a => { if (a.name === "poll") poll(); });

// Signed in or out: start fresh with that account's alerts.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.unseen) updateBadge();
  if (area === "local" && changes.apiKey) {
    chrome.storage.local.remove(["lastAlertId", "notifyCache", "notifyAt"]);
    poll();
  }
});

// Clicking a notification opens the dashboard.
chrome.notifications.onClicked.addListener(() => chrome.tabs.create({ url: SERVER + "/emailtrack" }));

// The Gmail script pings this right after a send.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg === "poll") { poll(); reply(true); }
  if (msg === "openOptions") { chrome.runtime.openOptionsPage(); reply(true); }
  return true;
});
