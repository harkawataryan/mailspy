const $ = id => document.getElementById(id);

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

$("form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  $("err").style.display = "none";
  $("go").disabled = true;
  $("go").textContent = "Signing in…";
  try {
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
    $("err").textContent = e.message.includes("fetch") ? "Can't reach MailSpy. Check your connection." : e.message;
    $("err").style.display = "block";
  } finally {
    $("go").disabled = false;
    $("go").textContent = "Sign in";
  }
});

// Sign in with Google: opens MailSpy's Google sign-in in a tab. When it's done,
// MailSpy's page hands the key to the extension (site-link.js) and this page updates.
$("google").addEventListener("click", () => chrome.tabs.create({ url: SERVER + "/auth/google?mode=ext" }));
fetch(SERVER + "/api/version").then(r => r.json()).then(d => { if (d.google) $("googleBox").hidden = false; }).catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.apiKey && changes.apiKey.newValue) render(true);
});

$("out").addEventListener("click", async () => { await signOut(); render(); });
$("dash").addEventListener("click", () => chrome.tabs.create({ url: SERVER + "/emailtrack" }));
$("privacy").href = SERVER + "/privacy";

render();
