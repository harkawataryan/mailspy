// Shared by the popup, the sign-in page and the background worker.
// (content.js keeps its own copy so it stays a single self-contained file.)

var SERVER = MAILSPY_APP;   // from site.js (mailspy.config.json)
MAILSPY_READY.then(function () { SERVER = MAILSPY_APP; });   // a different MailSpy server, if chosen
// ...and if it's changed later (options page), follow it here too.
chrome.storage.onChanged.addListener((c, area) => {
  if (area !== "local" || !(c.server || c.trackHost)) return;
  chrome.storage.local.get(["server", "trackHost"]).then(v => {
    MAILSPY_APP = v.server || MAILSPY_DEFAULT_APP; SERVER = MAILSPY_APP;
    MAILSPY_TRACK_HOST = (v.server && v.trackHost) || MAILSPY_DEFAULT_TRACK_HOST; MAILSPY_TRACK = "https://" + MAILSPY_TRACK_HOST;
  });
});

// Your sign-in for this browser: { apiKey, email, name }.
// Older versions kept the API key in sync storage; move it over once.
async function getAuth() {
  let { apiKey, email, name } = await chrome.storage.local.get(["apiKey", "email", "name"]);
  if (!apiKey) {
    const legacy = await chrome.storage.sync.get(["apiKey"]);
    if (legacy.apiKey) {
      apiKey = legacy.apiKey;
      await chrome.storage.local.set({ apiKey });
      await chrome.storage.sync.remove(["apiKey", "server"]);
    }
  }
  return { apiKey: apiKey || "", email: email || "", name: name || "" };
}

async function signOut() {
  await chrome.storage.local.remove(["apiKey", "email", "name", "lastAlertId", "unseen", "unseenKeys"]);
}
