// Scheduled-email editor for Gmail. Pasted into Gmail tabs by Claude (in-page JavaScript) to change many
// scheduled emails quickly: each email is cancelled, edited, made sure it's tracked by
// MailSpy once, and scheduled again for the same "Last scheduled time".
//
// Parallel: open a few Gmail tabs (2-3; more makes Gmail refuse more often), paste this into each, then call __se.start() in
// each. They share one work queue (localStorage + Web Locks, so no email is taken
// twice) and one results list. Call __se.load(specs) once, in any tab, first.
//
// specs: { "<recipient email>": spec, ... }  where spec is either
//   { first, co, rest, hook? }  rewrite into the recruiter format:
//       "Hi <first>, I'm Aryan ... internship at <co>. <Stripe line> <rest> <resume ask>"
//       (hook replaces the second sentence when given)
//   { replace: [[from, to], ...] }  plain text replacements inside the body
// Every spec may add expect: "text the old body must contain" (safety check).
// localStorage mse_global = [[from, to], ...] is applied to every email in the run;
// an email with no spec gets only those.
//
// Safety: never clicks Send; checks the recipient and the PDF attachment before
// editing; stops an email (left as a draft, nothing sent) on anything unexpected.
(function () {
  const Q = "mse_queue", R = "mse_results", S = "mse_specs", WHEN = "mse_when", G = "mse_global";
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = el => el && el.offsetParent !== null;
  async function until(fn, ms = 12000) { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(200); } return null; }
  function press(el) {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0 };
    el.dispatchEvent(new MouseEvent("mousedown", o)); el.dispatchEvent(new MouseEvent("mouseup", o)); el.dispatchEvent(new MouseEvent("click", o));
  }
  const get = k => JSON.parse(localStorage.getItem(k) || "null");
  const set = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  const isPixel = img => /go\.aryanh\.dev\/(?:img|t)\//.test(img.getAttribute("src") || "");

  // ---- the edit itself ----
  const STRIPE = "This past summer I interned on Stripe's Core Infrastructure team working on the service mesh, and I'm heading back there this spring.";
  function rewrite(body, spec) {
    // the element holding "Hi <first>, ... Aryan Harkawat"
    const holders = [...body.querySelectorAll("div")].filter(d => d.textContent.includes("Aryan Harkawat") && /^\s*Hi\b/.test(d.textContent));
    const box = holders.find(d => !holders.some(o => o !== d && d.contains(o)));
    if (!box) return "couldn't find the email text";
    if (spec.expect && !box.textContent.includes(spec.expect)) {
      if (box.textContent.includes(spec.rest || "\u0000")) return "already";       // done on an earlier pass
      return "old text didn't match";
    }
    const link = box.querySelector("a") ? box.querySelector("a") : Object.assign(document.createElement("a"), { href: "https://aryanh.dev", textContent: "aryanh.dev" });
    const keep = [...box.querySelectorAll("img")];
    const opener = spec.hook || `I wanted to reach out early to express interest in a Summer 2027 internship at ${spec.co}.`;
    const para = `I'm Aryan, a junior studying CS at UT Austin. ${opener} ${STRIPE} ${spec.rest} I've attached my resume (or check out my portfolio at `;
    const tail = ") and would greatly appreciate it if you could get my profile in front of the right person.";
    while (box.firstChild) box.removeChild(box.firstChild);
    const t = s => box.appendChild(document.createTextNode(s)), br = () => box.appendChild(document.createElement("br"));
    t(`Hi ${spec.first},`); br(); br(); t(para); box.appendChild(link); t(tail); br(); br(); t("Thanks,"); br(); t("Aryan Harkawat");
    keep.forEach(i => box.appendChild(i));
    return "ok";
  }
  function replaceText(body, spec) {
    if (spec.expect && !body.textContent.includes(spec.expect)) return spec.replace.every(([, to]) => body.textContent.includes(to)) ? "already" : "old text didn't match";
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let n, hits = 0;
    while ((n = walker.nextNode())) for (const [from, to] of spec.replace) if (n.nodeValue.includes(from)) { n.nodeValue = n.nodeValue.split(from).join(to); hits++; }
    return hits ? "ok" : "nothing to replace";
  }

  // ---- one email ----
  async function openCompose(email) {
    if ([...document.querySelectorAll('div[aria-label="Message Body"]')].some(vis)) return { step: "a compose window is already open" };
    for (const where of ["in:scheduled", "in:draft"]) {
      location.hash = "#search/" + encodeURIComponent(`${where} to:${email}`);
      await sleep(1800);
      const rows = await until(() => { const r = [...document.querySelectorAll("tr.zA")].filter(vis); return r.length ? r : null; }, 6000);
      if (!rows) continue;
      if (rows.length !== 1) return { step: `${rows.length} ${where} emails for this address` };
      press(rows[0]);
      if (where === "in:scheduled") {
        const cancel = await until(() => [...document.querySelectorAll("*")].find(e => vis(e) && e.children.length === 0 && e.textContent.trim() === "Cancel send"));
        if (!cancel) return { step: "no Cancel send button" };
        press(cancel);
      }
      return { ok: true };
    }
    return { step: "not in Scheduled or Drafts" };
  }

  async function finish(email, spec, whenText) {
    const findBody = () => [...document.querySelectorAll('div[aria-label="Message Body"]')].find(vis);
    let body = await until(findBody, 5000);
    if (!body) {
      // drafts sometimes open minimized: click the title bar to expand
      const bar = [...document.querySelectorAll('[role=dialog] .aYF')].find(vis);
      if (bar) { press(bar); body = await until(findBody, 6000); }
    }
    if (!body) return { step: "compose didn't open (now a draft)" };
    const dlg = body.closest("[role=dialog]");
    if (!dlg) return { step: "compose dialog not found (draft open)" };
    await sleep(500);
    const to = [...new Set([...dlg.querySelectorAll("[email]")].map(e => e.getAttribute("email").toLowerCase()))];
    if (to.length !== 1 || to[0] !== email) return { step: `recipient mismatch: ${to.join(",")} (draft open)` };
    if (!/\.pdf/i.test(dlg.textContent)) return { step: "no PDF attachment (draft open)" };

    let edit = "none";
    if (spec && !body.getAttribute("data-se-edited")) {
      edit = spec.replace ? replaceText(body, spec) : rewrite(body, spec);
      if (edit !== "ok" && edit !== "already") return { step: `edit: ${edit} (draft open)` };
      body.setAttribute("data-se-edited", "1");
    }
    // replacements applied to every email in the run (mse_global: [[from, to], ...])
    let global = 0;
    for (const [from, to] of get(G) || []) {
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      for (let n; (n = walker.nextNode());) if (n.nodeValue.includes(from)) { n.nodeValue = n.nodeValue.split(from).join(to); global++; }
    }
    const mt =[...body.querySelectorAll("img")].filter(i => /mailtrack\.io/i.test(i.getAttribute("src") || ""));
    mt.forEach(i => i.remove());
    body.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(400);

    // tracked by MailSpy exactly once: reuse an image that's already there
    const arrow = dlg.querySelector('[aria-label="More send options"]');
    if (!arrow) return { step: "send-options arrow not found (draft open)" };
    const existing = [...body.querySelectorAll("img")].find(isPixel);
    if (existing && !body.getAttribute("data-mailspy-token")) {
      const m = existing.getAttribute("src").match(/\/(?:img|t)\/([A-Za-z0-9_-]+)\.gif/);
      body.setAttribute("data-mailspy-sent", "1"); if (m) body.setAttribute("data-mailspy-token", m[1]);
    }
    if (!body.getAttribute("data-mailspy-token")) {
      press(arrow);
      if (!await until(() => body.getAttribute("data-mailspy-token"), 15000)) return { step: "MailSpy didn't add tracking (draft open)" };
    }
    if ([...body.querySelectorAll("img")].filter(isPixel).length !== 1) return { step: "tracking image count isn't 1 (draft open)" };

    const menuItem = () => [...document.querySelectorAll("[role=menuitem]")].find(e => vis(e) && /^\s*Schedule send\s*$/i.test(e.textContent));
    let item = await until(menuItem, 2500);
    if (!item) { press(arrow); item = await until(menuItem, 4000); }
    if (!item) return { step: "Schedule send menu didn't open (draft open)" };
    press(item);
    const want = new RegExp("^Last scheduled time\\s*" + whenText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s*") + "$", "i");
    const last = await until(() => [...document.querySelectorAll("*")].find(e => vis(e) && e.children.length <= 3 && want.test(e.textContent.replace(/\s+/g, " ").trim())), 6000);
    if (!last) return { step: `no 'Last scheduled time ${whenText}' option (dialog open)` };
    press(last);
    const done = await until(() => !vis(body) && [...document.querySelectorAll("*")].find(e => vis(e) && e.children.length <= 4 && /^Send scheduled for/i.test(e.textContent.trim())), 10000);
    return done ? { ok: true, edit, global, mailtrackRemoved: mt.length } : { step: "no confirmation" };
  }

  async function one(email) {
    const spec = (get(S) || {})[email] || null;
    const whenText = get(WHEN) || "Mon, Nov 9, 10:00 AM";
    let r = await openCompose(email);
    if (r.ok) r = await finish(email, spec, whenText);
    for (let k = 1; k <= 4 && !r.ok && r.step === "no confirmation"; k++) {     // Gmail's "could not be sent, check your network"
      await sleep(4000 * k);
      if (![...document.querySelectorAll('div[aria-label="Message Body"]')].some(vis)) break;
      r = await finish(email, spec, whenText); r.retried = k;
    }
    return { email, ...r };
  }

  // ---- shared queue ----
  async function take() {
    return navigator.locks.request("mse-queue", () => { const q = get(Q) || []; const e = q.shift(); set(Q, q); return e || null; });
  }
  async function record(r) {
    return navigator.locks.request("mse-results", () => { const all = get(R) || []; all.push({ ...r, tab: window.__se.tab, at: Date.now() }); set(R, all); });
  }
  window.__se = {
    tab: Math.random().toString(36).slice(2, 6),
    busy: false,
    gap: 4000,      // pause between emails; Gmail answers "could not be sent" more often when rushed
    load(specs, emails, whenText) {       // once, in any tab
      set(S, specs); set(Q, emails || Object.keys(specs)); set(R, []); if (whenText) set(WHEN, whenText);
      return (get(Q) || []).length + " queued";
    },
    async start() {
      if (window.__se.busy) return "already running";
      window.__se.busy = true;
      try {
        for (let e; (e = await take());) {
          let r;
          try { r = await one(e); } catch (err) { r = { email: e, step: "error: " + err.message }; }
          if (!r.ok && /already open/.test(r.step || "")) {
            // this tab is still holding an earlier email: give this one back and stop
            await window.__se.requeue([e]);
            break;
          }
          await record(r);
          // Any failure stops this tab, leaving that email where it is (a draft at
          // worst, never sent) so it can be looked at; the other tabs carry on.
          if (!r.ok) break;
          await sleep(window.__se.gap);
        }
      } finally { window.__se.busy = false; }
      return "lane finished";
    },
    status() {
      const all = get(R) || [];
      return { left: (get(Q) || []).length, done: all.filter(r => r.ok).length, failed: all.filter(r => !r.ok), busyHere: window.__se.busy };
    },
    requeue(emails) { return navigator.locks.request("mse-queue", () => { set(Q, [...emails, ...(get(Q) || [])]); return "ok"; }); },
    one, finish,
  };
  return "scheduled-editor ready (tab " + window.__se.tab + ")";
})();
