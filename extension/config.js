// Shared by the popup, the sign-in page and the background worker.
// (content.js keeps its own copy so it stays a single self-contained file.)

var SERVER = "https://mailspy.aryanh.dev";

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
