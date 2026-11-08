// MailSpy email finder pop-up, shared by Gmail (compose) and LinkedIn.
//
//   window.__mailspyFinder.open({
//     anchor,            // element to sit next to (or omit for bottom-right)
//     mode,              // "person" | "recruiters"
//     name, company,     // prefill; a LinkedIn profile link in `name` works too
//     actionLabel,       // "Add" (Gmail) or "Write" (elsewhere)
//     onPick(email),     // what clicking a result does; return true to mark it done
//     auto,              // search straight away if the fields are filled
//     onAutoTry(list, name) // Gmail only: send to list[0], then the next on each bounce
//   })
//
// Results come from MailSpy (/api/find): addresses published by the company,
// real addresses from public sources, and the company's address format. On top
// of that, the best guesses are checked here, from your own browser, against
// public GitHub commits: an address that authored commits definitely exists.

(function () {
  "use strict";
  function alive() { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } }
  if (window.__mailspyFinder && window.__mailspyFinder.alive()) return;

  var SERVER = MAILSPY_APP;   // from site.js

  var CSS = `
    :host { all: initial; position: fixed; z-index: 2147483001; }
    .pop { width: 390px; max-height: 500px; display: flex; flex-direction: column; background: #fff; color: #1f1f1f;
           border-radius: 12px; box-shadow: 0 4px 8px 3px rgba(60,64,67,.15), 0 1px 3px rgba(60,64,67,.3);
           font: 13px/1.45 "Google Sans", Roboto, Arial, sans-serif; overflow: hidden; }
    .top { padding: 12px 12px 10px; border-bottom: 1px solid #e8eaed; }
    .hd { display: flex; align-items: center; justify-content: space-between; margin-bottom: 9px; }
    .hd b { font-size: 14px; font-weight: 500; }
    .x { border: 0; background: none; color: #5f6368; font-size: 18px; line-height: 1; cursor: pointer; padding: 2px 6px; border-radius: 6px; }
    .x:hover { background: #f1f3f4; }
    .tabs { display: flex; gap: 6px; margin-bottom: 9px; }
    .tab { border: 1px solid #c4c7c5; background: #fff; color: #444746; border-radius: 14px; height: 26px; padding: 0 11px;
           font: 500 12.5px/1 "Google Sans", Roboto, Arial, sans-serif; cursor: pointer; }
    .tab.on { background: #c2e7ff; border-color: #c2e7ff; color: #001d35; }
    .row { display: flex; gap: 6px; }
    input { flex: 1; min-width: 0; height: 32px; box-sizing: border-box; border: 1px solid #c4c7c5; border-radius: 8px; padding: 0 9px;
            font: 13px "Google Sans", Roboto, Arial, sans-serif; color: #1f1f1f; outline: none; background: #fff; }
    input:focus { border-color: #0b57d0; box-shadow: 0 0 0 1px #0b57d0; }
    .go { height: 32px; border: 0; border-radius: 16px; padding: 0 14px; background: #0b57d0; color: #fff; cursor: pointer;
          font: 500 13px "Google Sans", Roboto, Arial, sans-serif; }
    .go:disabled { opacity: .6; cursor: default; }
    .tip { font-size: 11.5px; color: #5f6368; margin-top: 7px; }
    .body { overflow-y: auto; padding: 4px 0 6px; flex: 1; }
    .msg { padding: 10px 14px; color: #5f6368; }
    .meta { padding: 8px 14px 2px; color: #5f6368; font-size: 12px; }
    .meta a.again { color: #1a73e8; text-decoration: none; white-space: nowrap; }
    .meta a.again:hover { text-decoration: underline; }
    .meta b { color: #1f1f1f; font-weight: 500; }
    .h { padding: 10px 14px 4px; font-size: 11px; font-weight: 500; letter-spacing: .4px; text-transform: uppercase; color: #5f6368; }
    .it { display: flex; align-items: center; gap: 8px; padding: 7px 10px 7px 14px; cursor: pointer; }
    .it:hover { background: #f1f3f4; }
    .it .t { flex: 1; min-width: 0; }
    .em { font: 12.5px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #1f1f1f; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sub { font-size: 11.5px; color: #5f6368; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ok { color: #188038; }
    .act { flex: none; font-size: 12px; font-weight: 500; color: #0b57d0; padding: 3px 6px; border-radius: 6px; }
    .cp { flex: none; border: 0; background: none; color: #5f6368; cursor: pointer; padding: 3px 5px; border-radius: 6px; font-size: 11.5px; }
    .cp:hover { background: #e8eaed; }
    .done .act { color: #188038; }
    .links { display: flex; gap: 6px; flex-wrap: wrap; padding: 8px 14px 4px; }
    .links a { font-size: 12px; color: #0b57d0; text-decoration: none; border: 1px solid #c4c7c5; border-radius: 12px; padding: 2px 9px; }
    .try { margin: 8px 12px 4px; padding: 9px 10px; border-radius: 10px; background: #e8f0fe; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .try .q { flex: 1 1 100%; font-size: 12px; color: #3c4043; }
    .try button.tgo { height: 30px; border: 0; border-radius: 15px; padding: 0 12px; background: #0b57d0; color: #fff; cursor: pointer;
                      font: 500 12.5px "Google Sans", Roboto, Arial, sans-serif; display: inline-flex; align-items: center; gap: 6px; }
    .step { display: inline-flex; align-items: center; background: #fff; border: 1px solid #c4c7c5; border-radius: 15px; height: 28px; }
    .step button { border: 0; background: none; width: 26px; height: 26px; cursor: pointer; color: #0b57d0; font-size: 16px; line-height: 1; border-radius: 50%; }
    .step button:disabled { color: #c4c7c5; cursor: default; }
    .step b { min-width: 14px; text-align: center; font-weight: 500; }
    .try.off { background: #f1f3f4; }
    .try.off a { color: #0b57d0; }
    .it .n { flex: none; width: 18px; height: 18px; border-radius: 50%; background: #0b57d0; color: #fff; font-size: 10.5px; display: none; place-items: center; }
    .picked .it.pk .n { display: grid; }
    .pp { border-bottom: 1px solid #f1f3f4; }
    .pr { display: flex; align-items: center; gap: 10px; padding: 8px 12px 8px 14px; cursor: pointer; }
    .pr:hover, .pp.open .pr { background: #f8f9fa; }
    .pr .t { flex: 1; min-width: 0; }
    .pn { font-weight: 500; color: #1f1f1f; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    a.li { color: #0b57d0; text-decoration: none; }
    a.li:hover { text-decoration: underline; }
    .pf { flex: none; font-size: 12px; font-weight: 500; color: #0b57d0; white-space: nowrap; }
    .px { padding: 0 0 6px 10px; background: #f8f9fa; }
    .px .try { margin: 4px 8px 4px 4px; }
    .px .h { padding-top: 6px; }
    details.inb { margin: 6px 0 2px; }
    details.inb summary { padding: 8px 14px; font-size: 12px; color: #5f6368; cursor: pointer; list-style: none; }
    details.inb summary::before { content: "▸ "; }
    details.inb[open] summary::before { content: "▾ "; }
    .foot { padding: 7px 14px; border-top: 1px solid #e8eaed; font-size: 11.5px; color: #5f6368; display: flex; justify-content: space-between; }
    .foot a { color: #0b57d0; text-decoration: none; }
  `;

  function esc(s) { var d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  function cap(w) { return w ? w.charAt(0).toUpperCase() + w.slice(1) : ""; }

  // "https://www.linkedin.com/in/jane-doe-1a2b3c4d/" -> "Jane Doe" (best effort; "" if not a profile link)
  function nameFromLinkedIn(s) {
    var m = String(s || "").match(/linkedin\.com\/in\/([^/?#\s]+)/i);
    if (!m) return null;
    var slug = decodeURIComponent(m[1]).toLowerCase();
    var parts = slug.split("-").filter(function (p) { return p && !/\d/.test(p); });
    return parts.length ? parts.map(cap).join(" ") : "";
  }

  // Did this exact address author public commits on GitHub? (10 checks a minute per browser)
  async function onGitHub(email) {
    try {
      var r = await fetch("https://api.github.com/search/commits?per_page=1&q=" + encodeURIComponent("author-email:" + email),
        { headers: { Accept: "application/vnd.github+json" } });
      if (!r.ok) return 0;
      var d = await r.json();
      return d.total_count || 0;
    } catch (e) { return 0; }
  }

  var host = null, opts = null;

  function close() {
    if (host) host.remove();
    host = null; opts = null;
    document.removeEventListener("mousedown", outside, true);
    document.removeEventListener("keydown", onKey, true);
  }
  function outside(e) { if (host && !e.composedPath().includes(host) && !(opts && opts.anchor && e.composedPath().includes(opts.anchor))) close(); }
  function onKey(e) { if (e.key === "Escape" && host) { e.stopPropagation(); close(); } }

  function place(anchor) {
    var W = 390, H = 500;
    if (!anchor) { host.style.right = "24px"; host.style.bottom = "24px"; return; }
    var r = anchor.getBoundingClientRect();
    var left = Math.min(Math.max(8, r.right - W), window.innerWidth - W - 8);
    var top = r.bottom + 6;
    if (top + H > window.innerHeight) top = Math.max(8, r.top - H - 6);
    host.style.left = Math.round(left) + "px";
    host.style.top = Math.round(top) + "px";
  }

  function open(o) {
    if (!alive()) return;
    close();
    opts = o || {};
    var mode = opts.mode === "recruiters" ? "recruiters" : "person";
    host = document.createElement("div");
    host.className = "mailspy-finder";
    var sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = "<style>" + CSS + "</style>" +
      '<div class="pop" role="dialog" aria-label="Find an email address">' +
      '<div class="top"><div class="hd"><b>Find an email</b><button class="x" title="Close" aria-label="Close">×</button></div>' +
      '<div class="tabs"><button class="tab" data-m="person">A person</button><button class="tab" data-m="recruiters">People at a company</button></div>' +
      '<form class="row"><input name="name" placeholder="Name or LinkedIn link" autocomplete="off"><input name="company" placeholder="Company or website" autocomplete="off">' +
      '<button class="go" type="submit">Find</button></form><div class="tip" hidden></div></div>' +
      '<div class="body"><div class="msg">Enter a name and company, or paste a LinkedIn profile link.</div></div>' +
      '<div class="foot"><span>MailSpy</span><a target="_blank" rel="noreferrer">Open full page ↗</a></div></div>';
    var pop = sr.querySelector(".pop"), form = sr.querySelector("form"), body = sr.querySelector(".body"), tip = sr.querySelector(".tip");
    var nameIn = form.querySelector('[name="name"]'), coIn = form.querySelector('[name="company"]'), go = form.querySelector(".go");
    var full = sr.querySelector(".foot a");
    sr.querySelector(".x").addEventListener("click", close);
    // keep the page's own keyboard shortcuts (Gmail, LinkedIn) out of our inputs
    ["keydown", "keypress", "keyup"].forEach(function (t) {
      pop.addEventListener(t, function (e) { if (e.key !== "Escape") e.stopPropagation(); });
    });

    function setMode(m) {
      mode = m;
      sr.querySelectorAll(".tab").forEach(function (t) { t.classList.toggle("on", t.getAttribute("data-m") === m); });
      nameIn.style.display = m === "person" ? "" : "none";
      full.href = SERVER + "/find?mode=" + m;
    }
    sr.querySelectorAll(".tab").forEach(function (t) {
      t.addEventListener("click", function (e) { e.preventDefault(); setMode(t.getAttribute("data-m")); (mode === "person" ? nameIn : coIn).focus(); });
    });

    // A pasted LinkedIn link becomes the person's name.
    function fromLinkedIn() {
      var n = nameFromLinkedIn(nameIn.value);
      if (n === null) { tip.hidden = true; return; }
      if (n) { nameIn.value = n; tip.textContent = "Got the name from the LinkedIn link. Add their company."; }
      else tip.textContent = "Couldn't read a name from that link. Type their full name instead.";
      tip.hidden = false;
      if (n && !coIn.value) coIn.focus();
    }
    nameIn.addEventListener("input", fromLinkedIn);

    function row(email, sub, cls) {
      return '<div class="it" data-email="' + esc(email) + '"><span class="n"></span><div class="t"><div class="em">' + esc(email) + "</div>" +
        (sub ? '<div class="sub' + (cls ? " " + cls : "") + '">' + sub + "</div>" : "") + "</div>" +
        '<button class="cp" type="button" title="Copy">Copy</button><span class="act">' + esc(opts.actionLabel || "Add") + "</span></div>";
    }

    async function apiFind(params) {
      var s = await chrome.storage.local.get(["apiKey"]);
      if (!s.apiKey) return { error: "Sign in to MailSpy first (click its icon in Chrome's toolbar)." };
      try {
        var r = await fetch(SERVER + "/api/find?" + new URLSearchParams(params), { headers: { "X-API-Key": s.apiKey } });
        var d = await r.json();
        if (!r.ok || d.error) return { error: (d && d.error) || "Search failed." };
        return d;
      } catch (e) { return { error: "Couldn't reach MailSpy. Check your connection." }; }
    }

    // li: how MailSpy's shared LinkedIn index is used ("both" = search again and add, "fresh" = new search only)
    async function search(li) {
      var name = nameIn.value.trim(), company = coIn.value.trim();
      if (!company || (mode === "person" && !name)) { (company ? nameIn : coIn).focus(); return; }
      go.disabled = true;
      body.innerHTML = '<div class="msg">Searching… a company\'s first search takes a few seconds.</div>';
      full.href = SERVER + "/find?" + new URLSearchParams({ mode: mode, name: name, company: company });
      var params = { mode: mode, name: name, company: company };
      if (typeof li === "string") params.li = li;
      var d = await apiFind(params);
      go.disabled = false;
      if (d.error) { body.innerHTML = '<div class="msg">' + esc(d.error) + "</div>"; return; }
      if (mode === "person") renderPerson(body, d, name, true);
      else renderPeople(d);
    }

    // Copy / Add on every address row inside a box
    function wireRows(box) {
      box.querySelectorAll(".it:not([data-wired])").forEach(function (it) {
        it.setAttribute("data-wired", "1");
        var email = it.getAttribute("data-email");
        it.querySelector(".cp").addEventListener("click", function (e) {
          e.stopPropagation();
          navigator.clipboard.writeText(email).then(function () { e.target.textContent = "Copied"; });
        });
        it.addEventListener("click", function () {
          if (opts.onPick && opts.onPick(email) !== false) {
            it.classList.add("done");
            it.querySelector(".act").textContent = (opts.doneLabel || "Added") + " ✓";
          }
        });
      });
    }

    // One person's addresses: known ones, then the likely ones (with auto-try).
    async function renderPerson(box, d, personName, withMeta) {
      var html = "";
      if (withMeta && d.domain) html += '<div class="meta"><b>' + esc(d.organization || d.domain) + "</b> · " + esc(d.domain) +
        (d.pattern ? " · usually " + esc(d.pattern.example) : "") + "</div>";
      if (withMeta) (d.notes || []).forEach(function (n) { html += '<div class="meta">' + esc(n) + "</div>"; });
      if ((d.people || []).length) {
        html += '<div class="h">Found</div>';
        d.people.forEach(function (p) {
          html += row(p.email, [p.name, p.position, p.confidence != null ? p.confidence + "%" : p.source].filter(Boolean).map(esc).join(" · "), "ok");
        });
      }
      if ((d.guesses || []).length) {
        html += '<div class="h">' + (d.people.length ? "Other possible" : "Likely, best first") + "</div>";
        d.guesses.slice(0, withMeta ? 8 : 5).forEach(function (g) {
          html += row(g.email, esc((g.badges || []).join(" · ") || "common format"), g.confirmed ? "ok" : "");
        });
      }
      var nRows = ((d.people || []).length + Math.min((d.guesses || []).length, withMeta ? 8 : 5));
      if (opts.onAutoTry && nRows >= 2) {
        html = (d.gmail
          ? '<div class="try"><span class="q">Not sure which one? MailSpy sends to the first; if it bounces, it sends the same email to the next, so only one ever arrives.</span>' +
            '<button class="tgo" type="button">↻ Try the top</button>' +
            '<span class="step"><button class="dn" type="button" aria-label="Fewer">−</button><b class="cap"></b><button class="up" type="button" aria-label="More">+</button></span>' +
            '<span style="font-size:12.5px;color:#3c4043">until one works</span></div>'
          : '<div class="try off"><span class="q">To try addresses automatically, <a href="' + SERVER + '/settings" target="_blank" rel="noreferrer">connect Gmail in MailSpy Settings</a>.</span></div>') + html;
      }
      if (withMeta && (d.links || []).length) {
        html += '<div class="links">' + d.links.map(function (l) {
          return '<a href="' + esc(l.href) + '" target="_blank" rel="noreferrer">' + esc(l.label) + " ↗</a>";
        }).join("") + "</div>";
      }
      box.innerHTML = html || '<div class="msg">Nothing found.</div>';
      // auto-try: N addresses, in the order shown (which the GitHub check below can improve)
      var tryBar = box.querySelector(".try:not(.off)");
      if (tryBar) {
        var maxCap = Math.min(5, nRows), cap = Math.min(3, maxCap);
        var capEl = tryBar.querySelector(".cap"), dn = tryBar.querySelector(".dn"), up = tryBar.querySelector(".up");
        var order = function () {
          return [].slice.call(box.querySelectorAll(".it[data-email]")).filter(function (x) { return !x.dataset.published; });
        };
        var mark = function () {
          capEl.textContent = cap; dn.disabled = cap <= 2; up.disabled = cap >= maxCap;
          box.classList.add("picked");
          order().forEach(function (x, i) {
            x.classList.toggle("pk", i < cap);
            var n = x.querySelector(".n"); if (n) n.textContent = i + 1;
          });
        };
        dn.addEventListener("click", function (e) { e.stopPropagation(); if (cap > 2) { cap--; mark(); } });
        up.addEventListener("click", function (e) { e.stopPropagation(); if (cap < maxCap) { cap++; mark(); } });
        tryBar.querySelector(".tgo").addEventListener("click", function (e) {
          e.stopPropagation();
          var list = order().slice(0, 5).map(function (x) { return x.getAttribute("data-email"); });
          if (opts.onAutoTry(list, personName, cap) !== false) close();
        });
        box._markTry = mark;
        mark();
      }
      wireRows(box);

      // Check the best unconfirmed guesses against public GitHub commits (from this browser).
      if (!(d.people || []).length) {
        var todo = (d.guesses || []).filter(function (g) { return !g.confirmed; }).slice(0, 4);
        for (var i = 0; i < todo.length; i++) {
          var n = await onGitHub(todo[i].email);
          if (!host || !n) continue;
          var el = box.querySelector('.it[data-email="' + CSS_escape(todo[i].email) + '"] .sub');
          if (el) { el.textContent = "confirmed: used in " + n + " public GitHub commit" + (n === 1 ? "" : "s"); el.className = "sub ok"; }
          var it = el && el.closest(".it");
          if (it && it.parentElement) it.parentElement.insertBefore(it, it.parentElement.querySelector(".it") || it);
          if (box._markTry) box._markTry();
          break; // one confirmed address is enough
        }
      }
    }

    // Where the LinkedIn people came from: MailSpy's shared index (no search credits) or a new search
    function liSummary(li) {
      if (!li || (!li.count && li.from === "index")) return null;
      var n = li.count + (li.count === 1 ? " person" : " people");
      var s = Math.max(0, Date.now() / 1000 - (li.updated || 0));
      var ago = s < 120 ? "just now" : s < 7200 ? Math.round(s / 60) + " min ago" : s < 172800 ? Math.round(s / 3600) + " hours ago" : Math.round(s / 86400) + " days ago";
      if (li.from === "index") return {
        text: li.good ? "LinkedIn: " + n + " from MailSpy's shared index, updated " + ago + ". No search credits used."
          : "LinkedIn: " + n + " from MailSpy's shared index so far." + (li.canSearch ? "" : " Add a search key in Settings to look for more."),
        again: li.canSearch };
      if (li.from === "index+search") return { text: "LinkedIn: searched again and added to MailSpy's shared index, " + n + " in all.", again: false };
      if (li.from === "search") return { text: "LinkedIn: " + n + " from a new search" + (li.count ? ", saved in MailSpy's shared index" : "") + ".", again: false };
      return null;
    }

    // People at a company: names and roles by group; click one for their address.
    function renderPeople(d) {
      var html = "";
      if (d.domain) html += '<div class="meta"><b>' + esc(d.organization || d.domain) + "</b> · " + esc(d.domain) +
        (d.pattern ? " · usually " + esc(d.pattern.example) : "") + "</div>";
      (d.notes || []).forEach(function (n) { html += '<div class="meta">' + esc(n) + "</div>"; });
      var lis = liSummary(d.li);
      if (lis) html += '<div class="meta lix">' + esc(lis.text) + (lis.again
        ? ' <a class="again" data-li="both" href="#">Search again, add to these</a> · <a class="again" data-li="fresh" href="#">New search only</a>' : "") + "</div>";
      var people = [];
      (d.groups || []).forEach(function (g) {
        html += '<div class="h">' + esc(g.label) + "</div>";
        g.people.forEach(function (p) {
          var i = people.push(p) - 1;
          var sub = [p.position, p.source === "their website" || p.source === "LinkedIn" ? "" : p.source].filter(Boolean).map(esc).join(" · ") +
            (p.linkedin ? (p.position ? " · " : "") + '<a class="li" href="' + esc(p.linkedin) + '" target="_blank" rel="noreferrer">LinkedIn ↗</a>' : "");
          html += '<div class="pp" data-i="' + i + '"><div class="pr"><div class="t"><div class="pn">' + esc(p.name) + "</div>" +
            (sub ? '<div class="sub">' + sub + "</div>" : "") + '</div><span class="pf">' + (p.email ? "Email ▾" : "Find email ▾") + "</span></div>" +
            '<div class="px" hidden></div></div>';
        });
      });
      if ((d.links || []).length) {
        html += '<div class="links">' + d.links.map(function (l) {
          return '<a href="' + esc(l.href) + '" target="_blank" rel="noreferrer">' + esc(l.label) + " ↗</a>";
        }).join("") + "</div>";
      }
      var inboxes = (d.published || []).map(function (p) { return row(p.email, (p.hiring ? "hiring · " : "") + esc(p.where || ""), p.hiring ? "ok" : ""); })
        .concat((d.guesses || []).map(function (g) { return row(g.email, "common, unconfirmed", ""); }));
      if (inboxes.length) html += '<details class="inb"><summary>Shared inboxes (careers@, jobs@…)</summary>' + inboxes.join("") + "</details>";
      body.innerHTML = html || '<div class="msg">Nothing found.</div>';
      wireRows(body);
      body.querySelectorAll("a.again").forEach(function (a) {
        a.addEventListener("click", function (e) { e.preventDefault(); search(a.getAttribute("data-li")); });
      });

      body.querySelectorAll(".pp").forEach(function (pp) {
        var p = people[+pp.getAttribute("data-i")], px = pp.querySelector(".px"), pf = pp.querySelector(".pf"), loaded = false;
        var li = pp.querySelector("a.li");
        if (li) li.addEventListener("click", function (e) { e.stopPropagation(); });
        pp.querySelector(".pr").addEventListener("click", async function () {
          var open = px.hidden;
          px.hidden = !open;
          pf.textContent = (p.email ? "Email " : "Find email ") + (open ? "▴" : "▾");
          pp.classList.toggle("open", open);
          if (!open || loaded) return;
          loaded = true;
          if (p.email) {
            // known address: show it, and the likely ones only if asked
            px.innerHTML = row(p.email, esc(p.emailNote || "known address"), "ok");
            wireRows(px);
            return;
          }
          px.innerHTML = '<div class="msg">Finding ' + esc(p.name) + "'s address…</div>";
          var dd = await apiFind({ mode: "person", name: p.name, company: d.domain });
          if (dd.error) { px.innerHTML = '<div class="msg">' + esc(dd.error) + "</div>"; return; }
          renderPerson(px, dd, p.name, false);
        });
      });
    }

    function CSS_escape(s) { return String(s).replace(/["\\]/g, "\\$&"); }

    form.addEventListener("submit", function (e) { e.preventDefault(); search(); });

    nameIn.value = opts.name || "";
    coIn.value = opts.company || "";
    fromLinkedIn();
    setMode(mode);
    document.body.appendChild(host);
    place(opts.anchor || null);
    (mode === "person" && !nameIn.value ? nameIn : coIn.value ? nameIn : coIn).focus();
    if (opts.auto && coIn.value && (mode === "recruiters" || nameIn.value)) search();
    setTimeout(function () {
      document.addEventListener("mousedown", outside, true);
      document.addEventListener("keydown", onKey, true);
    }, 0);
  }

  window.__mailspyFinder = { alive: alive, open: open, close: close, nameFromLinkedIn: nameFromLinkedIn };
})();
