const $ = id => document.getElementById(id);

// ---- which MailSpy server (site.js: MAILSPY_APP, or one this browser chose)
const host = u => { try { return new URL(u).host; } catch (e) { return u; } };
const isDefault = () => MAILSPY_APP === MAILSPY_DEFAULT_APP;

// Check an address is a MailSpy server and remember it (with its tracking
// address, which the Gmail scripts need). "" means the built-in server.
async function chooseServer(input) {
  let origin = MAILSPY_DEFAULT_APP;
  const raw = String(input || "").trim();
  if (raw) {
    let u;
    try { u = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw); } catch (e) { throw new Error("That isn't a web address."); }
    if (u.protocol !== "https:") throw new Error("Use an https:// address.");
    origin = u.origin;
  }
  if (origin === MAILSPY_APP) return origin;
  let v;
  try { v = await fetch(origin + "/api/version").then(r => r.ok ? r.json() : null); } catch (e) { v = null; }
  if (!v || !v.version) throw new Error(`${host(origin)} doesn't look like a MailSpy server.`);
  const trackHost = v.track ? host(v.track) : "";
  if (origin === MAILSPY_DEFAULT_APP) await chrome.storage.local.remove(["server", "trackHost"]);
  else await chrome.storage.local.set({ server: origin, trackHost });
  // a different server means a different account: sign out of the old one
  await chrome.storage.local.remove(["apiKey", "email", "name"]);
  MAILSPY_APP = origin; SERVER = origin;
  if (trackHost) { MAILSPY_TRACK_HOST = trackHost; MAILSPY_TRACK = "https://" + trackHost; }
  return origin;
}

function showServer() {
  $("defaultSrv").textContent = host(MAILSPY_DEFAULT_APP);
  if (!isDefault()) { $("server").value = MAILSPY_APP; $("srvBox").open = true; }
  $("onServer").hidden = isDefault();
  $("onServer").textContent = "On your own MailSpy server: " + host(MAILSPY_APP);
  $("privacy").href = SERVER + "/privacy";
  $("googleBox").hidden = true;
  fetch(SERVER + "/api/version").then(r => r.json()).then(d => { if (d.google) $("googleBox").hidden = false; }).catch(() => {});
}

async function render(justSignedIn = false) {
  const { apiKey, email, name } = await getAuth();
  $("signedOut").hidden = !!apiKey;
  $("signedIn").hidden = !apiKey;
  if (apiKey) {
    let who = { email, name };
    if (!email) {
      // signed in by an older version: look up who this key belongs to
      try {
        const r = await fetch(SERVER + "/api/me", { headers: { "X-API-Key": apiKey } });
        if (r.ok) { who = await r.json(); await chrome.storage.local.set({ email: who.email, name: who.name || "" }); }
      } catch (e) {}
    }
    $("name").textContent = who.name || who.email || "Signed in";
    $("mail").textContent = who.name ? who.email : "";
    $("justNow").hidden = !justSignedIn;
  } else {
    $("email").focus();
  }
}

async function serverFromBox() {
  $("srvErr").style.display = "none";
  try { await chooseServer($("server").value); showServer(); return true; }
  catch (e) { $("srvErr").textContent = e.message; $("srvErr").style.display = "block"; $("srvBox").open = true; return false; }
}
$("server").addEventListener("change", serverFromBox);

$("form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  $("err").style.display = "none";
  $("go").disabled = true;
  $("go").textContent = "Signing in…";
  try {
    if (!(await serverFromBox())) return;
    const r = await fetch(SERVER + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: $("email").value.trim(), password: $("password").value }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "Couldn't sign in. Try again.");
    await chrome.storage.local.set({ apiKey: d.api_key, email: d.email, name: d.name || "" });
    $("password").value = "";
    render(true);
  } catch (e) {
    $("err").textContent = e.message.includes("fetch") ? `Can't reach ${host(SERVER)}. Check your connection.` : e.message;
    $("err").style.display = "block";
  } finally {
    $("go").disabled = false;
    $("go").textContent = "Sign in";
  }
});

// Sign in with Google: opens MailSpy's Google sign-in in a tab. When it's done,
// MailSpy's page hands the key to the extension (site-link.js) and this page updates.
// On your own server, Chrome first asks to let MailSpy read that one page.
$("google").addEventListener("click", async () => {
  if (!(await serverFromBox())) return;
  if (!isDefault()) {
    const ok = await chrome.permissions.request({ origins: [SERVER + "/*"] }).catch(() => false);
    if (!ok) { $("err").textContent = "MailSpy needs that permission to finish signing in with Google. You can sign in with your password instead."; $("err").style.display = "block"; return; }
    await chrome.runtime.sendMessage({ type: "register-site-link" }).catch(() => {});
  }
  chrome.tabs.create({ url: SERVER + "/auth/google?mode=ext" });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.apiKey && changes.apiKey.newValue) render(true);
});

$("out").addEventListener("click", async () => { await signOut(); render(); });
$("dash").addEventListener("click", () => chrome.tabs.create({ url: SERVER + "/emailtrack" }));

MAILSPY_READY.then(() => { showServer(); render(); });
