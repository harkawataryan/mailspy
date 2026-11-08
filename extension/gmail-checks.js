// ✔ / ✔✔ next to each tracked email in Gmail's message lists (Sent, Inbox, search...).
// Grey ✔ = sent, not opened yet. Green ✔✔ = opened (or a link clicked).
//
// MailSpy also puts ✔ / ✔✔ labels on the messages in Gmail, but those labels are
// hidden from the list when Mailsuite made them, so the checkmarks are drawn here.
// Rows are matched by Gmail's own conversation id (data-legacy-thread-id), the same
// id the server gets from the Gmail API, so the subject or recipient never matters.
// Safe to inject twice (after an extension update): the newer copy replaces the old.

(function () {
  "use strict";

  function alive() { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } }
  if (window.__mailspyChecks && window.__mailspyChecks.alive()) return;
  window.__mailspyChecks = { alive: alive };

  var SERVER = MAILSPY_APP;   // from site.js
  MAILSPY_READY.then(function () { SERVER = MAILSPY_APP; });   // a different MailSpy server, if chosen
  var CLS = "mailspy-ck";
  var REFRESH_MS = 45000;
  var checks = {};          // thread id (hex) -> { s: "sent"|"opened", n, c, last, replied }

  // Leftovers from an older copy of the extension.
  document.querySelectorAll("." + CLS).forEach(function (n) { n.remove(); });

  var SVG = {
    sent: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    opened: '<svg viewBox="0 0 20 16" width="20" height="16" aria-hidden="true"><path d="M1.5 8.5l3 3 6-7M8.5 11.5l.5.5 7-8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  var COLOR = { sent: "#9aa0a6", opened: "#1e8e3e" };

  function ago(ts) {
    var s = Math.max(0, Date.now() / 1000 - ts);
    if (s < 90) return "just now";
    if (s < 5400) return Math.round(s / 60) + " min ago";
    if (s < 129600) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " days ago";
  }

  function titleOf(v) {
    var parts = [];
    if (v.s === "opened") {
      if (v.n) parts.push("Opened " + (v.n === 1 ? "once" : v.n + " times") + (v.last ? ", last " + ago(v.last) : ""));
      else parts.push("Opened");
      if (v.c) parts.push(v.c === 1 ? "1 link click" : v.c + " link clicks");
    } else parts.push("Sent, not opened yet");
    if (v.replied) parts.push("replied " + ago(v.replied));
    return "MailSpy: " + parts.join(" · ");
  }

  function mark(v) {
    var el = document.createElement("span");
    el.className = CLS;
    el.style.cssText = "display:inline-flex;align-items:center;vertical-align:-3px;margin-right:6px;flex:none;line-height:0";
    paint(el, v);
    return el;
  }

  function paint(el, v) {
    var key = v.s + "|" + v.n + "|" + v.c + "|" + (v.replied ? 1 : 0);
    if (el.getAttribute("data-k") === key) return;
    el.setAttribute("data-k", key);
    el.style.color = COLOR[v.s] || COLOR.sent;
    el.innerHTML = SVG[v.s] || SVG.sent;
    el.title = titleOf(v);
  }

  // One list row: add, update or remove its checkmark.
  function drawRow(row) {
    var idEl = row.querySelector("[data-legacy-thread-id]");
    var cell = row.querySelector(".xT") || row.querySelector(".y6") && row.querySelector(".y6").parentElement;
    if (!idEl || !cell) return;
    var v = checks[idEl.getAttribute("data-legacy-thread-id")];
    var el = cell.querySelector(":scope > ." + CLS);
    if (!v) { if (el) el.remove(); return; }
    if (el) paint(el, v);
    else cell.insertBefore(mark(v), cell.firstChild);
  }

  function drawAll() {
    if (!alive()) return;
    document.querySelectorAll("tr.zA").forEach(drawRow);
  }

  var queued = false;
  function soon() {
    if (queued) return;
    queued = true;
    setTimeout(function () { queued = false; drawAll(); }, 120);
  }

  async function apiKey() {
    var s = await chrome.storage.local.get(["apiKey"]);
    if (s.apiKey) return s.apiKey;
    return (await chrome.storage.sync.get(["apiKey"])).apiKey || "";
  }

  var loading = false;
  async function refresh() {
    if (!alive() || loading) return;
    loading = true;
    try {
      var key = await apiKey();
      if (!key) { checks = {}; drawAll(); return; }
      var r = await fetch(SERVER + "/api/checks", { headers: { "X-API-Key": key } });
      if (!r.ok) return;
      checks = (await r.json()) || {};
      drawAll();
    } catch (e) { /* offline: keep what we have */ }
    finally { loading = false; }
  }

  var mo = new MutationObserver(function (muts) {
    if (!alive()) { mo.disconnect(); return; }
    for (var i = 0; i < muts.length; i++) {
      var t = muts[i].target;
      // ignore our own changes
      if (t.nodeType === 1 && (t.classList.contains(CLS) || (t.closest && t.closest("." + CLS)))) continue;
      soon();
      return;
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });

  // Fresh data now, every so often while the tab is in view, and right after sending.
  refresh();
  setInterval(function () { if (document.visibilityState === "visible") refresh(); }, REFRESH_MS);
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") refresh(); });
  window.addEventListener("hashchange", soon);
  window.addEventListener("mailspy:sent", function () { setTimeout(refresh, 25000); setTimeout(refresh, 70000); });
})();
