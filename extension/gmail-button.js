// MailSpy button in Gmail's top bar, next to the Google apps grid.
// Click it for your latest opens and clicks, without leaving Gmail.
//
// Everything is drawn inside shadow roots so Gmail's styles can't touch it.
// Safe to inject twice (after an extension update): the newer copy replaces the old.

(function () {
  "use strict";

  function alive() { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } }
  if (window.__mailspyButton && window.__mailspyButton.alive()) return;
  window.__mailspyButton = { alive: alive };

  var SERVER = MAILSPY_APP;   // from site.js
  MAILSPY_READY.then(function () { SERVER = MAILSPY_APP; });   // a different MailSpy server, if chosen
  var MARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><defs><linearGradient id="mk-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#34d399"/><stop offset=".55" stop-color="#10b981"/><stop offset="1" stop-color="#047857"/></linearGradient><linearGradient id="mk-shine" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient><radialGradient id="mk-iris" cx=".5" cy=".38" r=".7"><stop offset="0" stop-color="#065f46"/><stop offset="1" stop-color="#022c22"/></radialGradient></defs><rect width="96" height="96" rx="26" fill="url(#mk-bg)"/><rect width="96" height="96" rx="26" fill="url(#mk-shine)"/><path d="M9.5 48 C23.5 21.5 72.5 21.5 86.5 48 C72.5 74.5 23.5 74.5 9.5 48Z" fill="#fff"/><circle cx="48" cy="48" r="19.5" fill="url(#mk-iris)"/><rect x="36.5" y="40.25" width="23" height="15.75" rx="3.2" fill="#fff"/><path d="M38.3 42.4 L48 49.6 L57.7 42.4" fill="none" stroke="#064e3b" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // Remove leftovers from an older copy of the extension.
  document.querySelectorAll("#mailspy-gbtn, #mailspy-gpanel").forEach(function (n) { n.remove(); });

  // ---------------------------------------------------------------- styles
  var BTN_CSS = `
    :host { all: initial; display: inline-flex; align-items: center; margin: 0 2px; }
    button { position: relative; width: 46px; height: 46px; border: 0; border-radius: 50%; background: transparent;
             display: grid; place-items: center; cursor: pointer; padding: 0; overflow: visible; }
    button:hover { background: rgba(60, 64, 67, .08); }
    button.on { background: rgba(60, 64, 67, .12); }
    .mk { width: 32px; height: 32px; display: block; }
    .mk svg { width: 100%; height: 100%; display: block; }
    .badge { position: absolute; top: 3px; right: 1px; min-width: 16px; height: 16px; padding: 0 4px;
             box-sizing: border-box; border-radius: 8px; background: #d93025; color: #fff;
             font: 600 10px/16px "Google Sans", Roboto, Arial, sans-serif; text-align: center; box-shadow: 0 0 0 2px #fff; }
    .badge[hidden] { display: none; }
  `;
  var PANEL_CSS = `
    :host { all: initial; position: fixed; z-index: 2147483000; }
    * { box-sizing: border-box; }
    .p { width: 380px; background: #fff; color: #191919; border-radius: 12px; overflow: hidden;
         font: 13px/1.5 "Google Sans", Roboto, ui-sans-serif, system-ui, "Segoe UI", Arial, sans-serif;
         box-shadow: 0 4px 8px 3px rgba(60,64,67,.15), 0 1px 3px rgba(60,64,67,.3); -webkit-font-smoothing: antialiased; }
    .hd { display: flex; align-items: center; gap: 9px; padding: 14px 16px; border-bottom: 1px solid #ececea; }
    .mk { width: 22px; height: 22px; display: block; flex: none; } .mk svg { width: 100%; height: 100%; display: block; }
    .hd b { font-size: 14px; font-weight: 600; letter-spacing: -.1px; }
    .hd .g { flex: 1; }
    .btn { height: 30px; padding: 0 12px; border-radius: 6px; border: 1px solid #191919; background: #191919; color: #fff;
           font: inherit; font-size: 12.5px; font-weight: 500; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; }
    .btn:hover { opacity: .88; }
    .sec { padding: 12px 16px 4px; color: #83837f; font-size: 12px; font-weight: 500; }
    ul { list-style: none; margin: 0; padding: 0 0 4px; max-height: 360px; overflow: auto; }
    li { display: grid; grid-template-columns: 12px minmax(0,1fr) auto; gap: 8px; padding: 9px 16px; align-items: start; cursor: pointer; }
    li:hover { background: #f6f6f4; }
    li + li { border-top: 1px solid #f0f0ee; }
    .dot { width: 7px; height: 7px; border-radius: 50%; margin-top: 6px; background: #0d8a5f; }
    .dot.click { background: #2f6fde; }
    .dot.doc { background: #c27a12; }
    .l1 b { font-weight: 500; }
    .l2 { color: #83837f; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tm { color: #a9a9a5; font-size: 11.5px; white-space: nowrap; padding-top: 1px; }
    .msg { padding: 26px 22px; color: #83837f; text-align: center; }
    .msg b { display: block; color: #191919; font-weight: 500; margin-bottom: 3px; }
    .msg .btn { margin-top: 12px; }
    .ft { display: flex; justify-content: space-between; align-items: center; padding: 10px 16px; border-top: 1px solid #ececea;
          color: #a9a9a5; font-size: 12px; }
    .ft a { color: #83837f; cursor: pointer; text-decoration: none; } .ft a:hover { color: #191919; }
  `;

  // ---------------------------------------------------------------- helpers
  function esc(s) { var d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  function shortAgo(ts) {
    var d = Math.floor(Date.now() / 1000 - ts);
    if (d < 60) return "now";
    if (d < 3600) return Math.floor(d / 60) + "m";
    if (d < 86400) return Math.floor(d / 3600) + "h";
    return Math.floor(d / 86400) + "d";
  }
  async function auth() {
    var s = await chrome.storage.local.get(["apiKey", "email"]);
    if (!s.apiKey) s.apiKey = (await chrome.storage.sync.get(["apiKey"])).apiKey || "";
    return s;
  }
  function openDashboard(path) { window.open(SERVER + (path || "/emailtrack"), "_blank", "noopener"); }
  function openAccount() { try { chrome.runtime.sendMessage("openOptions"); } catch (e) {} }

  // ---------------------------------------------------------------- the button
  var btnHost, btn, badge;

  function findAnchor() {
    var apps = document.querySelector('[aria-label="Google apps"], a[aria-label^="Google apps"], [data-tooltip="Google apps"]');
    if (!apps) return null;
    var el = apps;
    // climb to the wrapper that sits directly in the header's row of icons
    // (Gmail wraps the grid in block-level boxes; inserting into one of those would stack us above it)
    while (el.parentElement && el.parentElement.tagName !== "HEADER" &&
           !/flex/.test(getComputedStyle(el.parentElement).display)) el = el.parentElement;
    return el;
  }

  function mount() {
    if (!alive()) return false;
    if (btnHost && document.contains(btnHost)) return true;
    var anchor = findAnchor();
    if (!anchor || !anchor.parentElement) return false;
    btnHost = document.createElement("div");
    btnHost.id = "mailspy-gbtn";
    var root = btnHost.attachShadow({ mode: "open" });
    root.innerHTML = '<style>' + BTN_CSS + '</style><button type="button" title="MailSpy" aria-label="MailSpy">' +
      '<span class="mk">' + MARK + '</span><span class="badge" hidden></span></button>';
    btn = root.querySelector("button");
    badge = root.querySelector(".badge");
    btn.addEventListener("click", function (e) { e.stopPropagation(); open ? closePanel() : openPanel(); });
    anchor.parentElement.insertBefore(btnHost, anchor);
    refreshBadge();
    return true;
  }

  async function refreshBadge() {
    if (!badge || !alive()) return;
    var s = await chrome.storage.local.get(["unseen"]);
    var n = s.unseen || 0;
    badge.hidden = !n;
    badge.textContent = n > 9 ? "9+" : String(n);
  }

  // ---------------------------------------------------------------- the panel
  var panelHost, panel, open = false;

  function place() {
    if (!panelHost || !btnHost) return;
    var r = btnHost.getBoundingClientRect();
    panelHost.style.top = Math.round(r.bottom + 6) + "px";
    panelHost.style.right = Math.max(8, Math.round(window.innerWidth - r.right - 6)) + "px";
  }

  function openPanel() {
    if (!alive()) return;
    if (!panelHost) {
      panelHost = document.createElement("div");
      panelHost.id = "mailspy-gpanel";
      var root = panelHost.attachShadow({ mode: "open" });
      root.innerHTML = '<style>' + PANEL_CSS + '</style><div class="p">' +
        '<div class="hd"><span class="mk">' + MARK + '</span><b>MailSpy</b><span class="g"></span>' +
        '<a class="btn" id="dash">Open dashboard</a></div><div id="body"><div class="msg">Loading…</div></div>' +
        '<div class="ft"><span id="me"></span><a id="acct">Account</a></div></div>';
      panel = root;
      root.getElementById("dash").addEventListener("click", function () { openDashboard(); closePanel(); });
      root.getElementById("acct").addEventListener("click", function () { openAccount(); closePanel(); });
      document.body.appendChild(panelHost);
    }
    panelHost.style.display = "block";
    place();
    open = true;
    btn && btn.classList.add("on");
    chrome.storage.local.set({ unseen: 0, unseenKeys: [] }).then(refreshBadge);
    load();
  }

  function closePanel() {
    if (panelHost) panelHost.style.display = "none";
    open = false;
    btn && btn.classList.remove("on");
  }

  async function load() {
    var body = panel.getElementById("body");
    var a = await auth();
    panel.getElementById("me").textContent = a.email || "";
    if (!a.apiKey) {
      body.innerHTML = '<div class="msg"><b>You\'re not signed in</b>Sign in with the email and password from your invite.<br>' +
        '<a class="btn" id="signin">Sign in</a></div>';
      panel.getElementById("signin").addEventListener("click", function () { openAccount(); closePanel(); });
      return;
    }
    try {
      var r = await fetch(SERVER + "/api/activity", { headers: { "X-API-Key": a.apiKey } });
      if (r.status === 401) {
        body.innerHTML = '<div class="msg"><b>Please sign in again</b><a class="btn" id="signin">Sign in</a></div>';
        panel.getElementById("signin").addEventListener("click", function () { openAccount(); closePanel(); });
        return;
      }
      var items = (await r.json()).filter(function (v) { return !v.is_bot; }).slice(0, 8);
      if (!items.length) {
        body.innerHTML = '<div class="msg"><b>No opens yet</b>Send an email from Gmail. Opens and clicks appear here.</div>';
        return;
      }
      body.innerHTML = '<div class="sec">Latest activity</div><ul>' + items.map(function (v) {
        var who = esc(v.to_name || v.to_addr || "Someone");
        var what = v.kind === "open" ? "opened your email" : v.kind === "doc" ? "viewed a PDF" : v.kind === "link" ? "clicked your tracked link" : "clicked a link";
        var sub = [esc(v.kind === "doc" || v.kind === "link" ? v.title : v.subject), esc(v.geo || "")].filter(Boolean).join(" · ");
        var href = v.kind === "doc" ? "/docs/" + Number(v.item_id) : v.kind === "link" ? "/links/" + Number(v.item_id) : "/email/" + Number(v.email_id);
        var dot = v.kind === "click" || v.kind === "link" ? "click" : v.kind === "doc" ? "doc" : "";
        return '<li data-href="' + href + '"><span class="dot ' + dot + '"></span>' +
          '<div><div class="l1"><b>' + who + '</b> ' + what + '</div><div class="l2">' + sub + '</div></div>' +
          '<span class="tm">' + shortAgo(v.ts) + '</span></li>';
      }).join("") + '</ul>';
      body.querySelectorAll("li[data-href]").forEach(function (li) {
        li.addEventListener("click", function () { openDashboard(li.dataset.href); closePanel(); });
      });
    } catch (e) {
      body.innerHTML = '<div class="msg"><b>Can\'t reach MailSpy</b>Check your internet connection.</div>';
    }
  }

  // close on outside click / Escape; keep position on resize
  document.addEventListener("mousedown", function (e) {
    if (!open) return;
    var path = e.composedPath ? e.composedPath() : [];
    if (path.indexOf(panelHost) === -1 && path.indexOf(btnHost) === -1) closePanel();
  }, true);
  document.addEventListener("keydown", function (e) { if (open && e.key === "Escape") closePanel(); });
  window.addEventListener("resize", function () { if (open) place(); });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (!alive()) return;
    if (area === "local" && (changes.unseen || changes.apiKey)) refreshBadge();
  });

  // Gmail builds its header late and sometimes rebuilds it: keep the button in place.
  var timer = setInterval(function () {
    if (!alive()) {
      clearInterval(timer);
      if (btnHost) btnHost.remove();
      if (panelHost) panelHost.remove();
      return;
    }
    mount();
  }, 1500);
  mount();
})();
