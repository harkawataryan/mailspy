function shortAgo(ts) {
  const d = Math.floor(Date.now() / 1000 - ts);
  if (d < 60) return "now";
  if (d < 3600) return Math.floor(d / 60) + "m";
  if (d < 86400) return Math.floor(d / 3600) + "h";
  return Math.floor(d / 86400) + "d";
}

function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : s; return d.innerHTML; }

function signInPrompt(text) {
  document.getElementById("feed").innerHTML =
    `<li class="empty"><b>${esc(text)}</b>Sign in with Google, or the email and password from your invite.<br>
     <button class="cta" id="signin">Sign in</button></li>`;
  document.getElementById("signin").addEventListener("click", () => chrome.runtime.openOptionsPage());
}

async function load() {
  chrome.storage.local.set({ unseen: 0, unseenKeys: [] });
  document.getElementById("dash").href = SERVER + "/emailtrack";
  document.getElementById("opts").addEventListener("click", e => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
  const { apiKey, email } = await getAuth();
  document.getElementById("me").textContent = email || "";
  if (!apiKey) return signInPrompt("You're not signed in");

  const feed = document.getElementById("feed");
  try {
    const r = await fetch(SERVER + "/api/activity", { headers: { "X-API-Key": apiKey } });
    if (r.status === 401) return signInPrompt("Please sign in again");
    if (!r.ok) throw new Error(r.status);
    const items = (await r.json()).filter(v => !v.is_bot);
    if (!items.length) {
      feed.innerHTML = '<li class="empty"><b>No opens yet</b>Send an email from Gmail. Opens and clicks appear here.</li>';
      return;
    }
    feed.innerHTML = items.map(v => {
      const who = esc(v.to_name || v.to_addr || "Someone");
      const what = v.kind === "open" ? "opened" : v.kind === "doc" ? "viewed a PDF" : v.kind === "link" ? "clicked your tracked link" : "clicked a link";
      const sub = [esc(v.kind === "doc" || v.kind === "link" ? v.title : v.subject), esc(v.geo || "")].filter(Boolean).join(" · ");
      return `<li><span class="dot ${v.kind === "click" || v.kind === "link" ? "click" : v.kind === "doc" ? "doc" : ""}"></span>
        <div><div class="l1"><b>${who}</b> ${what}</div><div class="l2">${sub}</div></div>
        <span class="tm">${shortAgo(v.ts)}</span></li>`;
    }).join("");
  } catch (e) {
    feed.innerHTML = '<li class="empty"><b>Can\'t reach MailSpy</b>Check your internet connection.</li>';
  }
}

load();
