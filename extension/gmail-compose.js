// MailSpy additions to Gmail compose windows:
//   * attached PDFs: a Tracked / Not tracked switch on each PDF chip; tracked
//     PDFs are sent as attachment-style tiles that report opens (convertPdfs,
//     called by content.js on Send),
//   * a Templates button next to Send,
//   * a Draft button next to it that writes or polishes the email with AI,
//   * a Find link next to Cc / Bcc,
//   * a "Track clicks" switch on links.
//
// Everything is drawn inside shadow roots so Gmail's styles can't affect it.
// Safe to inject twice (after an extension update): the newer copy takes over.

(function () {
  "use strict";

  function alive() { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } }
  if (window.__mailspyCompose && window.__mailspyCompose.alive()) return;
  window.__mailspyCompose = { alive: alive };

  var SERVER = "https://mailspy.aryanh.dev";
  var MAX = 15 * 1024 * 1024;

  document.querySelectorAll(".mailspy-pdf-host").forEach(function (n) { n.remove(); });

  var CSS = `
    :host { all: initial; display: inline-flex; align-items: center; }
    button { display: inline-flex; align-items: center; gap: 7px; height: 36px; padding: 0 14px 0 12px; margin-left: 8px;
             border: 1px solid #c4c7c5; border-radius: 18px; background: #fff; color: #444746; cursor: pointer;
             font: 500 14px/1 "Google Sans", Roboto, Arial, sans-serif; white-space: nowrap; }
    button:hover { background: #f2f2f2; }
    button:disabled { opacity: .6; cursor: default; }
    svg { width: 18px; height: 18px; flex: none; }
    .err { color: #b3261e; }
    input { display: none; }
  `;
  var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 14h6M9 17h4"/></svg>';

  function esc(s) { var d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  function size(b) { return b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB"; }

  function composeRoot(el) {
    return el.closest("[role=dialog]") || el.closest(".M9") || el.closest(".iN") || el.closest(".nH");
  }
  function findBody(root) {
    return root && (root.querySelector('div[aria-label="Message Body"]') ||
      root.querySelector('div[g_editable="true"]') ||
      root.querySelector('div[role="textbox"][contenteditable="true"]'));
  }

  // ------------------------------------------------------- attached PDFs
  // Attach PDFs the normal Gmail way. Each PDF chip gets a small switch,
  // "Tracked" (the default, from Settings) or "Not tracked". When you send,
  // every tracked PDF is uploaded to MailSpy and swapped for a tile that looks
  // like Gmail's own attachment tile: a picture of the first page, the PDF
  // icon and the file name. Opening it shows the PDF in a Gmail-style viewer
  // and tells you who opened it, for how long and which pages they read.
  //
  // (A real attachment can't report back: Gmail keeps the file and shows it in
  // its own viewer, so nothing ever reaches MailSpy.)
  //
  // Gmail doesn't let a page read back a file once it's attached, so we keep
  // the files you attach (file picker, drag and drop, paste) as you add them.
  var attached = new Map(); // "name|size" and "name" -> File
  // Off unless "Send PDFs I attach in Gmail as tracked links" is on in Settings:
  // then attachments stay completely normal and nothing is added to their chips.
  var pdfTilesOn = false;

  function remember(files) {
    for (var i = 0; files && i < files.length; i++) {
      var f = files[i];
      if (!f || !/\.pdf$/i.test(f.name)) continue;
      attached.set(f.name + "|" + f.size, f);
      attached.set(f.name, f);
    }
  }
  document.addEventListener("change", function (e) {
    var t = e.target;
    if (alive() && t && t.tagName === "INPUT" && t.type === "file") remember(t.files);
  }, true);
  document.addEventListener("drop", function (e) {
    if (alive() && e.dataTransfer) remember(e.dataTransfer.files);
  }, true);
  document.addEventListener("paste", function (e) {
    if (alive() && e.clipboardData) remember(e.clipboardData.files);
  }, true);

  // Upload a PDF to MailSpy. Returns { doc } or { error } (short, for a label).
  async function uploadPdf(file) {
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") return { error: "PDFs only" };
    if (file.size > MAX) return { error: "Too large to track (15 MB max)" };
    var s = await chrome.storage.local.get(["apiKey"]);
    if (!s.apiKey) return { error: "Sign in to MailSpy to track" };
    try {
      var r = await fetch(SERVER + "/api/docs", {
        method: "POST",
        headers: { "Content-Type": "application/pdf", "X-API-Key": s.apiKey, "X-Filename": encodeURIComponent(file.name) },
        body: file,
      });
      var d = await r.json().catch(function () { return {}; });
      if (!r.ok || !d.url) return { error: d.error || "Upload failed" };
      return { doc: d, key: s.apiKey };
    } catch (e) {
      return { error: "Upload failed" };
    }
  }

  // A picture of the first page (360x240, cropped from the top), drawn with the
  // copy of PDF.js bundled in the extension. Null if it can't be drawn.
  var pdfjsP = null;
  function pdfjs() {
    if (!pdfjsP) {
      pdfjsP = import(chrome.runtime.getURL("lib/pdf.min.mjs")).then(function (m) {
        m.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.mjs");
        return m;
      });
      pdfjsP.catch(function () { pdfjsP = null; });
    }
    return pdfjsP;
  }
  async function firstPagePicture(file) {
    var W = 360, H = 240, pdf = null;
    try {
      var lib = await pdfjs();
      pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
      var page = await pdf.getPage(1);
      var base = page.getViewport({ scale: 1 });
      var vp = page.getViewport({ scale: W / base.width });
      var c = document.createElement("canvas");
      c.width = W; c.height = H;
      var ctx = c.getContext("2d");
      ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, W, H);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      return await new Promise(function (res) { c.toBlob(res, "image/jpeg", 0.85); });
    } catch (e) {
      console.warn("MailSpy: couldn't draw a PDF preview", e);
      return null;
    } finally {
      try { if (pdf) pdf.destroy(); } catch (e) {}
    }
  }
  function withTimeout(p, ms) {
    return Promise.race([p, new Promise(function (res) { setTimeout(function () { res(null); }, ms); })]);
  }

  // Email-safe tile, modelled on Gmail's attachment tile.
  function tileHTML(d, hasThumb) {
    var href = esc(d.url);
    var base = d.url.slice(0, d.url.lastIndexOf("/"));
    var top = hasThumb
      ? '<img src="' + esc(base + "/d/" + d.token + "/p.png") + '" width="180" height="120" alt="' + esc(d.filename) + '" ' +
        'style="display:block;width:180px;height:120px;border:0;border-radius:8px 8px 0 0;background:#f1f3f4">'
      : '<div style="width:180px;height:120px;border-radius:8px 8px 0 0;background:#f1f3f4;text-align:center;line-height:120px">' +
        '<span style="display:inline-block;background:#d93025;color:#ffffff;font:bold 13px Arial,sans-serif;line-height:20px;padding:2px 7px;border-radius:3px;vertical-align:middle">PDF</span></div>';
    return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-table;width:182px;margin:0 8px 8px 0;' +
      'border:1px solid #dadce0;border-radius:8px;border-collapse:separate;vertical-align:top;background:#ffffff">' +
      '<tr><td style="padding:0"><a href="' + href + '" target="_blank" style="display:block;text-decoration:none">' + top + "</a></td></tr>" +
      '<tr><td style="padding:9px 10px;border-top:1px solid #dadce0">' +
      '<a href="' + href + '" target="_blank" style="display:block;width:160px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;' +
      'color:#3c4043;text-decoration:none;font:500 13px/18px Arial,Helvetica,sans-serif">' +
      '<span style="display:inline-block;background:#d93025;color:#ffffff;font:bold 8px/12px Arial,sans-serif;padding:1px 3px;border-radius:2px;margin-right:7px;vertical-align:1px">PDF</span>' +
      esc(d.filename) + "</a></td></tr></table>";
  }

  // Tiles go where Gmail puts attachments: at the end, below your signature
  // (above the quoted email in a reply).
  function insertTiles(root, html) {
    var body = findBody(root);
    if (!body) return false;
    var box = body.querySelector(".mailspy-attachments");
    if (!box) {
      box = document.createElement("div");
      box.className = "mailspy-attachments";
      box.style.cssText = "margin:16px 0 8px";
      var quote = body.querySelector(".gmail_quote");
      if (quote) {
        while (quote.parentElement && quote.parentElement !== body) quote = quote.parentElement;
        body.insertBefore(box, quote);
      } else {
        body.appendChild(box);
      }
    }
    var tmp = document.createElement("div");
    tmp.innerHTML = html;
    while (tmp.firstChild) box.appendChild(tmp.firstChild);
    body.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  var CHIP_CSS = `
    :host { all: initial; display: inline-flex; vertical-align: middle; margin: 0 4px 0 8px; }
    button { display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 8px 0 6px; border-radius: 10px;
             border: 1px solid #c4c7c5; background: #fff; color: #5f6368; cursor: pointer;
             font: 500 11.5px/1 "Google Sans", Roboto, Arial, sans-serif; white-space: nowrap; }
    button.on { border-color: #a8dab5; background: #e6f4ea; color: #137333; }
    button.warn { border-color: #fdd663; background: #fef7e0; color: #b06000; }
    button.busy { cursor: default; }
    svg { width: 13px; height: 13px; flex: none; }
  `;
  var EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M2 12s3.6-7 10-7c2 0 3.7.7 5.1 1.6M22 12s-3.6 7-10 7c-2 0-3.7-.7-5.1-1.6"/><path d="M3 3l18 18"/></svg>';

  function chipName(chip) {
    var n = chip.querySelector(".vI");
    if (n && n.textContent) return n.textContent.trim();
    var m = (chip.getAttribute("aria-label") || "").match(/^Attachment:\s*(.+?\.pdf)\b/i);
    return m ? m[1] : "";
  }

  function chipFile(chip, name) {
    var size = chip.querySelector(".vJ");                       // "(1K)", "(245K)", "(1.2M)"
    var exact = null;
    attached.forEach(function (f, k) {
      if (exact || k.indexOf("|") < 0 || f.name !== name) return;
      if (!size) { exact = f; return; }
      var kb = f.size / 1024, label = size.textContent.replace(/[()\s]/g, "");
      var guess = kb < 1024 ? Math.max(1, Math.round(kb)) + "K" : (kb / 1024).toFixed(1) + "M";
      if (label === guess || label.replace(/\.0M$/, "M") === guess.replace(/\.0M$/, "M")) exact = f;
    });
    return exact || attached.get(name) || null;
  }

  function pressGmailButton(el) {
    ["mousedown", "mouseup", "click"].forEach(function (t) {
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    });
  }

  // Is this chip's PDF going out tracked?
  function chipWanted(chip) {
    var v = chip.getAttribute("data-mailspy-pdf");
    if (!pdfTilesOn) return false;
    return v ? v === "on" : true;
  }

  function paintChip(chip) {
    var host = chip.querySelector(".mailspy-chip-host");
    if (!host || !host.shadowRoot) return;
    var b = host.shadowRoot.querySelector("button");
    if (b.classList.contains("busy")) return;
    var name = chipName(chip), on = chipWanted(chip), file = chipFile(chip, name);
    if (on && !file) {
      b.className = "warn";
      b.innerHTML = EYE_OFF + "<span>Re-attach to track</span>";
      b.title = "MailSpy can only track a PDF attached in this window. Remove it and attach it again, or click to send it as a normal attachment.";
    } else if (on) {
      b.className = "on";
      b.innerHTML = EYE + "<span>Tracked</span>";
      b.title = "Sent as a tracked attachment: you'll see when it's opened and which pages were read. Click to send it as a normal attachment instead.";
    } else {
      b.className = "";
      b.innerHTML = EYE_OFF + "<span>Not tracked</span>";
      b.title = "Sent as a normal Gmail attachment, which can't tell you when it's opened. Click to track it.";
    }
  }

  function addChipToggle(chip) {
    if (!chip.querySelector('[aria-label="Remove attachment"], [data-tooltip="Remove attachment"]')) return; // not in a compose window
    var name = chipName(chip);
    if (!/\.pdf$/i.test(name)) return;
    if (chip.querySelector(".mailspy-chip-host")) { paintChip(chip); return; }
    var host = document.createElement("span");
    host.className = "mailspy-chip-host";
    var sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = "<style>" + CHIP_CSS + '</style><button type="button"></button>';
    var b = sr.querySelector("button");
    // Gmail opens the attachment on click/Enter anywhere in the chip; keep ours to ourselves.
    ["mousedown", "mouseup", "keydown"].forEach(function (t) { host.addEventListener(t, function (e) { e.stopPropagation(); }); });
    b.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      if (b.classList.contains("busy")) return;
      chip.setAttribute("data-mailspy-pdf", chipWanted(chip) ? "off" : "on");
      paintChip(chip);
    });
    var size = chip.querySelector(".vJ");
    var rmBtn = chip.querySelector('[aria-label="Remove attachment"]');
    if (size && size.parentElement === chip) chip.insertBefore(host, size.nextSibling);
    else if (rmBtn && rmBtn.parentElement === chip) chip.insertBefore(host, rmBtn);
    else chip.appendChild(host);
    paintChip(chip);
  }

  function scanChips() {
    if (!pdfTilesOn) {
      document.querySelectorAll(".mailspy-chip-host").forEach(function (n) { n.remove(); });
      return;
    }
    document.querySelectorAll('div[aria-label^="Attachment: "]').forEach(addChipToggle);
  }

  function chipSay(chip, text) {
    var host = chip.querySelector(".mailspy-chip-host");
    if (!host || !host.shadowRoot) return;
    var b = host.shadowRoot.querySelector("button");
    b.className = "on busy";
    b.innerHTML = EYE + "<span>" + esc(text) + "</span>";
  }

  // Called by content.js when you press Send (or schedule): swap every tracked
  // PDF in this compose window for a tracked tile. Anything that can't be
  // tracked is left as a normal attachment, so sending never fails because of this.
  async function convertPdfs(root) {
    if (!root || !alive() || !pdfTilesOn) return 0;
    var chips = Array.prototype.slice.call(root.querySelectorAll('div[aria-label^="Attachment: "]')).filter(function (c) {
      return /\.pdf$/i.test(chipName(c)) && chipWanted(c) && c.querySelector('[aria-label="Remove attachment"], [data-tooltip="Remove attachment"]');
    });
    var done = 0;
    for (var i = 0; i < chips.length; i++) {
      var chip = chips[i], file = chipFile(chip, chipName(chip));
      if (!file) continue;
      chipSay(chip, "Uploading…");
      var res = await uploadPdf(file);
      if (res.error) { console.warn("MailSpy:", res.error); continue; }
      chipSay(chip, "Adding preview…");
      var pic = await withTimeout(firstPagePicture(file), 8000);
      var hasThumb = false;
      if (pic) {
        try {
          var t = await fetch(SERVER + "/api/docs/" + res.doc.id + "/thumb", {
            method: "POST", headers: { "Content-Type": pic.type || "image/jpeg", "X-API-Key": res.key }, body: pic,
          });
          hasThumb = t.ok;
        } catch (e) {}
      }
      if (!insertTiles(root, tileHTML(res.doc, hasThumb))) continue;
      var rm = chip.querySelector('[aria-label="Remove attachment"], [data-tooltip="Remove attachment"]');
      if (rm) pressGmailButton(rm);
      done++;
    }
    return done;
  }
  window.__mailspyCompose.convertPdfs = convertPdfs;

  // A slot in the Send row for one of our buttons. Gmail lays that row out as a
  // table, and a table cell can't hold a shadow root, so the button lives in a
  // <span> inside a new cell.
  function sendRowHost(sendBtn, cls) {
    var span = document.createElement("span");
    span.style.cssText = "display:inline-flex;vertical-align:middle";
    var cell = sendBtn.closest("td");
    if (cell && cell.parentElement && cell.parentElement.tagName === "TR") {
      var td = document.createElement("td");
      td.className = cls;
      td.style.verticalAlign = "middle";
      td.appendChild(span);
      cell.parentElement.insertBefore(td, cell.nextSibling);
    } else {
      span.className = cls;
      sendBtn.parentElement.insertBefore(span, sendBtn.nextSibling);
    }
    return span;
  }

  function scan() {
    if (!alive()) return;
    document.querySelectorAll('[role=button][data-tooltip^="Send"], [role=button][aria-label^="Send"]').forEach(function (b) {
      if (/^Send\b/i.test(b.getAttribute("data-tooltip") || b.getAttribute("aria-label") || "")) { addDraftButton(b); addTemplatesButton(b); }
    });
  }

  // ------------------------------------------------------------ templates
  // A "Templates" button next to Send. It lists your templates, with the ones
  // for this recipient (or their company) first, and fills in {first_name},
  // {company} and so on when you pick one. "Save this email" turns what you've
  // written into a template, swapping the recipient's name and company for
  // placeholders. Full editing is on the dashboard (/templates).
  var TPL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>';
  var TPL_CSS = `
    :host { all: initial; position: fixed; z-index: 2147483001; }
    .pop { width: 400px; max-height: 480px; display: flex; flex-direction: column; background: #fff; color: #1f1f1f;
           border-radius: 12px; box-shadow: 0 4px 8px 3px rgba(60,64,67,.15), 0 1px 3px rgba(60,64,67,.3);
           font: 13px/1.45 "Google Sans", Roboto, Arial, sans-serif; overflow: hidden; }
    .top { padding: 12px 12px 8px; border-bottom: 1px solid #e8eaed; }
    .ttl { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .ttl b { font-size: 14px; font-weight: 500; }
    .ctx { font-size: 12px; color: #5f6368; }
    input[type=text] { width: 100%; height: 32px; box-sizing: border-box; border: 1px solid #c4c7c5; border-radius: 8px; padding: 0 9px;
            font: 13px "Google Sans", Roboto, Arial, sans-serif; color: #1f1f1f; outline: none; background: #fff; }
    input[type=text]:focus { border-color: #0b57d0; box-shadow: 0 0 0 1px #0b57d0; }
    .body { overflow-y: auto; padding: 2px 0 6px; flex: 1; }
    .h { padding: 10px 14px 4px; font-size: 11px; font-weight: 500; letter-spacing: .4px; text-transform: uppercase; color: #5f6368; }
    .it { padding: 7px 14px; cursor: pointer; }
    .it:hover, .it.sel { background: #f1f3f4; }
    .nm { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pv { font-size: 12px; color: #5f6368; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .msg { padding: 12px 14px; color: #5f6368; }
    .foot { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; border-top: 1px solid #e8eaed; }
    .foot a { color: #0b57d0; text-decoration: none; font-size: 12.5px; }
    .btn { height: 30px; border: 1px solid #c4c7c5; border-radius: 15px; padding: 0 13px; background: #fff; color: #0b57d0; cursor: pointer;
           font: 500 12.5px "Google Sans", Roboto, Arial, sans-serif; }
    .btn.pri { background: #0b57d0; border-color: #0b57d0; color: #fff; }
    .btn:disabled { opacity: .6; cursor: default; }
    .form { padding: 12px 14px; display: grid; gap: 10px; }
    .lbl { font-size: 12px; color: #5f6368; margin-bottom: 4px; }
    .seg { display: flex; gap: 6px; flex-wrap: wrap; }
    .seg button { height: 28px; border: 1px solid #c4c7c5; background: #fff; color: #444746; border-radius: 14px; padding: 0 11px;
                  font: 500 12.5px "Google Sans", Roboto, Arial, sans-serif; cursor: pointer; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .seg button.on { background: #c2e7ff; border-color: #c2e7ff; color: #001d35; }
    .chk { display: flex; gap: 8px; align-items: flex-start; font-size: 12.5px; color: #444746; }
    .err { color: #b3261e; font-size: 12.5px; }
  `;
  var tplHost = null, tplRoot = null;

  function addTemplatesButton(sendBtn) {
    var root = composeRoot(sendBtn);
    if (!root || !findBody(root) || root.querySelector(".mailspy-tpl-host")) return;
    var sr = sendRowHost(sendBtn, "mailspy-tpl-host").attachShadow({ mode: "open" });
    sr.innerHTML = "<style>" + CSS + '</style><button type="button" title="Insert or save a template (MailSpy)">' + TPL_ICON + "<span>Templates</span></button>";
    var b = sr.querySelector("button");
    b.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      if (tplHost && tplRoot === root) closeTemplates(); else openTemplates(b, root);
    });
  }

  function closeTemplates() {
    if (tplHost) tplHost.remove();
    tplHost = null; tplRoot = null;
    document.removeEventListener("mousedown", outsideTpl, true);
    document.removeEventListener("keydown", escTpl, true);
  }
  function outsideTpl(e) { if (tplHost && !e.composedPath().includes(tplHost)) closeTemplates(); }
  function escTpl(e) { if (e.key === "Escape" && tplHost) { e.stopPropagation(); closeTemplates(); } }

  var ROLE_LOCAL = /^(info|hello|hi|contact|support|help|sales|press|team|office|jobs|careers|recruiting|talent|hr|people|admin|hiring)$/i;
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : ""; }

  // Who this email is to: { email, first, last, full, company, domain }
  function recipientOf(root) {
    // Gmail marks recipient chips either with [email] or as role=option with data-hovercard-id
    var chip = root.querySelector("[email]") || root.querySelector('[role=option][data-hovercard-id*="@"]');
    if (!chip) return null;
    var email = (chip.getAttribute("email") || chip.getAttribute("data-hovercard-id") || "").trim().toLowerCase();
    if (!email) return null;
    var name = (chip.getAttribute("name") || chip.getAttribute("data-name") || "").trim();
    if (name.toLowerCase() === email) name = "";
    if (!name) {
      var t = (chip.textContent || "").trim();
      if (t && t.toLowerCase() !== email && t.indexOf("@") < 0) name = t;
    }
    var first = "", last = "";
    if (name) {
      var parts = name.replace(/\(.*?\)/g, " ").replace(/,.*$/, "").trim().split(/\s+/);
      first = parts[0] || ""; last = parts.length > 1 ? parts[parts.length - 1] : "";
    } else {
      // jane.doe@ / jane_doe@ / jane-doe@ / jane@ -> Jane Doe / Jane
      var local = email.split("@")[0];
      var m = local.match(/^([a-z]{2,})[._-]([a-z]{2,})$/);
      if (m) { first = cap(m[1]); last = cap(m[2]); }
      else if (/^[a-z]{2,15}$/.test(local) && !ROLE_LOCAL.test(local)) first = cap(local);
    }
    return { email: email, first: first, last: last, full: [first, last].filter(Boolean).join(" "), domain: email.split("@")[1] || "" };
  }

  function fillText(s, v) {
    return String(s || "").replace(/\{(first_name|last_name|full_name|company|my_name)\}/g, function (m, k) { return v[k] || m; });
  }
  function fillHtml(s, v) {
    return String(s || "").replace(/\{(first_name|last_name|full_name|company|my_name)\}/g, function (m, k) {
      return v[k] ? esc(v[k]) : '<span style="background:#fde293">' + m + "</span>";
    });
  }
  function plain(html) {
    var d = document.createElement("div");
    d.innerHTML = String(html || "").replace(/<br\s*\/?>|<\/(p|div|li)>/gi, " ");
    return (d.textContent || "").replace(/\s+/g, " ").trim();
  }

  function insertTemplate(root, t, v, savedRange) {
    var body = findBody(root);
    if (!body) return false;
    var subj = root.querySelector('input[name="subjectbox"]');
    if (subj && !subj.value.trim() && t.subject) {
      subj.value = fillText(t.subject, v);
      subj.dispatchEvent(new Event("input", { bubbles: true }));
    }
    var tmp = document.createElement("div");
    tmp.innerHTML = fillHtml(t.body, v);
    var frag = document.createDocumentFragment();
    while (tmp.firstChild) frag.appendChild(tmp.firstChild);
    var range = savedRange || null;
    var onlySignature = !plain(body.innerHTML.replace(/<div[^>]*class="[^"]*gmail_(signature|quote)[\s\S]*$/i, ""));
    if (range && body.contains(range.startContainer) && !onlySignature) {
      range.deleteContents();
      range.insertNode(frag);
    } else {
      var before = body.querySelector(".gmail_signature, [data-smartmail='gmail_signature'], .gmail_quote");
      if (before) {
        while (before.parentElement && before.parentElement !== body) before = before.parentElement;
        // drop the empty lines Gmail leaves above the signature
        while (before.previousSibling && !plain(before.previousSibling.outerHTML || before.previousSibling.textContent || "") &&
               !(before.previousSibling.querySelector && before.previousSibling.querySelector("img"))) before.previousSibling.remove();
        body.insertBefore(frag, before);
        var gap = document.createElement("div"); gap.appendChild(document.createElement("br"));
        body.insertBefore(gap, before);
      } else {
        while (body.firstChild && !plain(body.innerHTML) && !body.querySelector("img")) body.removeChild(body.firstChild);
        body.appendChild(frag);
      }
    }
    body.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  // The email as written, ready to save: no signature, quoted reply, or MailSpy markers;
  // the recipient's name and company swapped for placeholders if asked.
  function currentEmail(root, swaps) {
    var body = findBody(root);
    var copy = body.cloneNode(true);
    copy.querySelectorAll(".gmail_signature, [data-smartmail='gmail_signature'], .gmail_quote, .gmail_extra").forEach(function (n) { n.remove(); });
    copy.querySelectorAll('img[src*="/img/"], img[src*="/t/"]').forEach(function (n) { n.remove(); });
    copy.querySelectorAll("[data-mailspy-track]").forEach(function (n) { n.removeAttribute("data-mailspy-track"); });
    var subj = root.querySelector('input[name="subjectbox"]');
    var subject = subj ? subj.value : "";
    if (swaps && swaps.length) {
      var walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
      var nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
      var swap = function (s) {
        swaps.forEach(function (p) {
          var re = new RegExp("(^|[^A-Za-z])" + p[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![A-Za-z])", "g");
          s = s.replace(re, function (m, pre) { return pre + p[1]; });
        });
        return s;
      };
      nodes.forEach(function (n) { n.nodeValue = swap(n.nodeValue); });
      subject = swap(subject);
    }
    var html = copy.innerHTML.replace(/(<div><br><\/div>\s*)+$/i, "").trim();
    return { subject: subject.trim(), body: html };
  }

  function openTemplates(btn, root) {
    closeTemplates();
    tplRoot = root;
    tplHost = document.createElement("div");
    tplHost.className = "mailspy-tpl-pop";
    var sr = tplHost.attachShadow({ mode: "open" });
    sr.innerHTML = "<style>" + TPL_CSS + '</style><div class="pop" role="dialog" aria-label="Templates"></div>';
    var pop = sr.querySelector(".pop");
    ["keydown", "keypress", "keyup"].forEach(function (t) {
      pop.addEventListener(t, function (e) { if (e.key !== "Escape") e.stopPropagation(); });
    });
    document.body.appendChild(tplHost);
    var r = btn.getBoundingClientRect();
    tplHost.style.left = Math.round(Math.min(Math.max(8, r.left), window.innerWidth - 408)) + "px";
    tplHost.style.bottom = Math.round(Math.max(8, window.innerHeight - r.top + 8)) + "px";
    setTimeout(function () {
      document.addEventListener("mousedown", outsideTpl, true);
      document.addEventListener("keydown", escTpl, true);
    }, 0);

    var who = recipientOf(root);
    var data = null, vals = {};
    // where the cursor was in the email, so the template goes there
    var sel0 = document.getSelection(), savedRange = null;
    var body0 = findBody(root);
    if (sel0 && sel0.rangeCount && body0 && body0.contains(sel0.getRangeAt(0).startContainer)) savedRange = sel0.getRangeAt(0).cloneRange();
    pop.addEventListener("mousedown", function (e) {
      var tag = e.composedPath()[0] && e.composedPath()[0].tagName;
      if (tag !== "INPUT" && tag !== "BUTTON") e.preventDefault();
    });

    async function api(path, payload) {
      var s = await chrome.storage.local.get(["apiKey"]);
      if (!s.apiKey) throw new Error("signin");
      var r = await fetch(SERVER + path, payload ? {
        method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": s.apiKey }, body: JSON.stringify(payload),
      } : { headers: { "X-API-Key": s.apiKey } });
      var d = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(d.error || "failed");
      return d;
    }

    function listView() {
      pop.innerHTML = '<div class="top"><div class="ttl"><b>Templates</b><span class="ctx"></span></div>' +
        '<input type="text" placeholder="Search templates" autocomplete="off"></div>' +
        '<div class="body"><div class="msg">Loading…</div></div>' +
        '<div class="foot"><button class="btn save">Save this email as a template</button><a target="_blank" rel="noreferrer" href="' + SERVER + '/templates">Manage ↗</a></div>';
      var search = pop.querySelector("input"), list = pop.querySelector(".body"), ctx = pop.querySelector(".ctx");
      pop.querySelector(".save").addEventListener("click", saveView);
      search.focus();

      function render() {
        if (!data) return;
        var q = search.value.trim().toLowerCase();
        var items = data.templates.filter(function (t) {
          return !q || (t.name + " " + t.subject + " " + plain(t.body)).toLowerCase().indexOf(q) >= 0;
        });
        if (!data.templates.length) {
          list.innerHTML = '<div class="msg">No templates yet. Write an email, then press <b>Save this email as a template</b>. ' +
            "Use {first_name} and {company} to have them filled in for each person.</div>";
          return;
        }
        if (!items.length) { list.innerHTML = '<div class="msg">No templates match.</div>'; return; }
        var groups = [
          ["person", "For " + (who && (who.full || who.email))],
          ["company", "For " + (vals.company || (who && who.domain))],
          ["", who ? "General" : "Templates"],
          ["other", "For other people and companies"],
        ];
        var html = "";
        groups.forEach(function (g) {
          var inG = items.filter(function (t) { return t.match === g[0]; });
          if (!inG.length) return;
          html += '<div class="h">' + esc(g[1]) + "</div>";
          inG.forEach(function (t) {
            var pv = fillText(t.subject ? t.subject + " — " + plain(t.body) : plain(t.body), vals);
            html += '<div class="it" data-id="' + t.id + '"><div class="nm">' + esc(t.name) + '</div><div class="pv">' + esc(pv.slice(0, 140)) + "</div></div>";
          });
        });
        list.innerHTML = html;
        list.querySelectorAll(".it").forEach(function (it) {
          it.addEventListener("click", function () {
            var t = data.templates.find(function (x) { return String(x.id) === it.getAttribute("data-id"); });
            if (t && insertTemplate(root, t, vals, savedRange)) {
              api("/api/templates/" + t.id + "/used", {}).catch(function () {});
              closeTemplates();
            }
          });
        });
      }
      search.addEventListener("input", render);
      search.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { var first = list.querySelector(".it"); if (first) first.click(); }
      });

      (async function () {
        try {
          data = await api("/api/templates?to=" + encodeURIComponent(who ? who.email : ""));
          vals = { first_name: who && who.first, last_name: who && who.last, full_name: who && who.full, company: data.company, my_name: data.my_name };
          ctx.textContent = who ? [who.full || who.email, data.company].filter(Boolean).join(" · ") : "Add a recipient to fill in names";
          render();
        } catch (e) {
          list.innerHTML = '<div class="msg">' + (e.message === "signin" ? "Sign in to MailSpy first (click its icon in Chrome's toolbar)." : "Couldn't load your templates.") + "</div>";
        }
      })();
    }

    function saveView() {
      var cur = currentEmail(root, null);
      if (!plain(cur.body) && !cur.subject) {
        pop.querySelector(".body").innerHTML = '<div class="msg">Write something first, then save it as a template.</div>';
        return;
      }
      var company = (data && data.company) || "";
      var scopes = [["any", "Anyone", ""]];
      if (who && data && data.domain) scopes.push(["company", company || who.domain, who.domain]);
      if (who) scopes.push(["person", who.full || who.email, who.email]);
      var text = plain(cur.body) + " " + cur.subject;
      var swaps = [];
      if (who && who.full && who.last && text.indexOf(who.full) >= 0) swaps.push([who.full, "{full_name}"]);
      if (who && who.first && text.indexOf(who.first) >= 0) swaps.push([who.first, "{first_name}"]);
      if (company && text.indexOf(company) >= 0) swaps.push([company, "{company}"]);
      var scope = "any";
      pop.innerHTML = '<div class="top"><div class="ttl"><b>Save as template</b></div></div>' +
        '<div class="body"><div class="form">' +
        '<div><div class="lbl">Name</div><input type="text" class="nm" maxlength="120" placeholder="Like: Coffee chat ask"></div>' +
        '<div><div class="lbl">Use for</div><div class="seg">' + scopes.map(function (s) {
          return '<button data-s="' + s[0] + '"' + (s[0] === "any" ? ' class="on"' : "") + ' title="' + esc(s[1]) + '">' + esc(s[1]) + "</button>";
        }).join("") + "</div></div>" +
        (swaps.length ? '<label class="chk"><input type="checkbox" class="sw" checked><span>Replace ' +
          swaps.map(function (p) { return "<b>" + esc(p[0]) + "</b> with " + p[1]; }).join(", ") + " so it fits anyone</span></label>" : "") +
        '<div class="err"></div></div></div>' +
        '<div class="foot"><button class="btn back">Back</button><button class="btn pri go">Save template</button></div>';
      var nm = pop.querySelector(".nm"), err = pop.querySelector(".err"), go = pop.querySelector(".go");
      nm.value = (cur.subject || "").slice(0, 120);
      nm.focus(); nm.select();
      pop.querySelectorAll(".seg button").forEach(function (b) {
        b.addEventListener("click", function () {
          scope = b.getAttribute("data-s");
          pop.querySelectorAll(".seg button").forEach(function (x) { x.classList.toggle("on", x === b); });
        });
      });
      pop.querySelector(".back").addEventListener("click", listView);
      go.addEventListener("click", async function () {
        if (!nm.value.trim()) { err.textContent = "Give it a name."; nm.focus(); return; }
        var sw = pop.querySelector(".sw");
        var email = currentEmail(root, sw && sw.checked ? swaps : null);
        var sv = (scopes.find(function (s) { return s[0] === scope; }) || ["any", "", ""])[2];
        go.disabled = true; go.textContent = "Saving…";
        try {
          await api("/api/templates", { name: nm.value.trim(), subject: email.subject, body: email.body, scope_type: scope, scope_value: sv });
          data = null;
          listView();
        } catch (e) {
          go.disabled = false; go.textContent = "Save template";
          err.textContent = e.message === "signin" ? "Sign in to MailSpy first." : e.message;
        }
      });
    }

    listView();
  }

  // ------------------------------------------------------------ AI drafter
  // A "Draft" button next to Send. Say what the email is for (or let it polish
  // what you wrote); Claude writes it with your own API key (set in MailSpy
  // Settings, used only on MailSpy's server), you check it, then Insert.
  var AI_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>';
  var AI_CSS = TPL_CSS + `
    textarea { width: 100%; box-sizing: border-box; border: 1px solid #c4c7c5; border-radius: 8px; padding: 8px 9px; resize: vertical;
               font: 13px/1.45 "Google Sans", Roboto, Arial, sans-serif; color: #1f1f1f; outline: none; background: #fff; }
    textarea:focus { border-color: #0b57d0; box-shadow: 0 0 0 1px #0b57d0; }
    .goal { min-height: 64px; }
    .out { min-height: 210px; }
    .note { font-size: 12px; color: #5f6368; }
    .note a { color: #0b57d0; text-decoration: none; }
    .acts { display: flex; gap: 8px; }
    .spin { display: inline-block; width: 12px; height: 12px; border: 2px solid #c2e7ff; border-top-color: #0b57d0; border-radius: 50%;
            animation: r .8s linear infinite; vertical-align: -2px; margin-right: 6px; }
    @keyframes r { to { transform: rotate(360deg); } }
  `;
  var aiHost = null, aiRoot = null;
  var aiMemory = new WeakMap();   // compose -> { goal, tone, mode, result } so Back / reopening keeps your words

  function addDraftButton(sendBtn) {
    var root = composeRoot(sendBtn);
    if (!root || !findBody(root) || root.querySelector(".mailspy-ai-host")) return;
    var sr = sendRowHost(sendBtn, "mailspy-ai-host").attachShadow({ mode: "open" });
    sr.innerHTML = "<style>" + CSS + '</style><button type="button" title="Write or polish this email with AI (MailSpy)">' + AI_ICON + "<span>Draft</span></button>";
    var b = sr.querySelector("button");
    b.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      if (aiHost && aiRoot === root) closeDrafter(); else openDrafter(b, root);
    });
  }

  function closeDrafter() {
    if (aiHost) aiHost.remove();
    aiHost = null; aiRoot = null;
    document.removeEventListener("mousedown", outsideAi, true);
    document.removeEventListener("keydown", escAi, true);
  }
  function outsideAi(e) { if (aiHost && !e.composedPath().includes(aiHost)) closeDrafter(); }
  function escAi(e) { if (e.key === "Escape" && aiHost) { e.stopPropagation(); closeDrafter(); } }

  // Text of some email HTML, keeping line and paragraph breaks
  function textOf(html) {
    var d = document.createElement("div");
    d.innerHTML = String(html || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h\d|blockquote)>/gi, "\n");
    return (d.textContent || "").replace(/ /g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  // Plain-text draft -> Gmail-style HTML: one <div> per line, an empty line between paragraphs
  function draftHtml(text) {
    return String(text || "").trim().split(/\n\s*\n/).map(function (p) {
      return p.split("\n").map(function (l) { return "<div>" + (esc(l) || "<br>") + "</div>"; }).join("");
    }).join("<div><br></div>");
  }
  // Remove what's been written, keeping the signature and any quoted reply
  function clearWritten(root) {
    var body = findBody(root);
    var stop = body.querySelector(".gmail_signature, [data-smartmail='gmail_signature'], .gmail_quote");
    while (stop && stop.parentElement && stop.parentElement !== body) stop = stop.parentElement;
    while (body.firstChild && body.firstChild !== stop) body.removeChild(body.firstChild);
  }
  // The message this is a reply to, if any: the quoted text, or the last message shown in the thread
  function replyContext(root) {
    var body = findBody(root);
    var q = body && body.querySelector(".gmail_quote");
    if (q && textOf(q.innerHTML)) return textOf(q.innerHTML).slice(0, 4000);
    var subj = root.querySelector('input[name="subjectbox"]');
    var isReply = (subj && /^(re|aw|sv):/i.test(subj.value)) || !subj;
    if (!isReply) return "";
    var shown = [].slice.call(document.querySelectorAll(".a3s")).filter(function (n) { return !root.contains(n) && n.offsetParent; });
    return shown.length ? textOf(shown[shown.length - 1].innerHTML).slice(0, 4000) : "";
  }

  function openDrafter(btn, root) {
    closeDrafter();
    closeTemplates();
    aiRoot = root;
    aiHost = document.createElement("div");
    aiHost.className = "mailspy-ai-pop";
    var sr = aiHost.attachShadow({ mode: "open" });
    sr.innerHTML = "<style>" + AI_CSS + '</style><div class="pop" role="dialog" aria-label="Draft with AI" style="width:440px;max-height:560px"></div>';
    var pop = sr.querySelector(".pop");
    ["keydown", "keypress", "keyup"].forEach(function (t) {
      pop.addEventListener(t, function (e) { if (e.key !== "Escape") e.stopPropagation(); });
    });
    document.body.appendChild(aiHost);
    var r = btn.getBoundingClientRect();
    aiHost.style.left = Math.round(Math.min(Math.max(8, r.left), window.innerWidth - 448)) + "px";
    aiHost.style.bottom = Math.round(Math.max(8, window.innerHeight - r.top + 8)) + "px";
    setTimeout(function () {
      document.addEventListener("mousedown", outsideAi, true);
      document.addEventListener("keydown", escAi, true);
    }, 0);

    var who = recipientOf(root);
    var mem = aiMemory.get(root) || {};
    aiMemory.set(root, mem);
    var written = currentEmail(root, null);
    var hasText = !!textOf(written.body);
    var mode = mem.mode || (hasText ? "improve" : "new");
    if (!hasText) mode = "new";
    var tone = mem.tone || "direct";
    var ctxText = who ? "To " + (who.full || who.email) + (who.domain ? " · " + who.domain : "") : "Add a recipient for a more personal draft";

    function seg(cls, items, on) {
      return '<div class="seg ' + cls + '">' + items.map(function (x) {
        return '<button type="button" data-v="' + x[0] + '"' + (x[0] === on ? ' class="on"' : "") + ">" + esc(x[1]) + "</button>";
      }).join("") + "</div>";
    }

    function formView(errText) {
      pop.innerHTML = '<div class="top"><div class="ttl" style="margin:0"><b>Draft with AI</b><span class="ctx">' + esc(ctxText) + "</span></div></div>" +
        '<div class="body"><div class="form">' +
        (hasText ? "<div>" + seg("md", [["improve", "Polish what I wrote"], ["new", "Write a new one"]], mode) + "</div>" : "") +
        '<div><div class="lbl">' + (mode === "improve" ? "Anything to change? (optional)" : "What's it for?") + "</div>" +
        '<textarea class="goal" maxlength="1500" placeholder="' + (mode === "improve"
          ? "e.g. shorter, friendlier, mention I can start in June"
          : "e.g. ask about new-grad backend roles on the payments team; mention my Go internship") + '"></textarea></div>' +
        "<div><div class=\"lbl\">Tone</div>" + seg("tn", [["direct", "Short & direct"], ["warm", "Warm"], ["formal", "Formal"]], tone) + "</div>" +
        '<div class="err"></div></div></div>' +
        '<div class="foot"><a target="_blank" rel="noreferrer" href="' + SERVER + '/settings#ai_about">What it knows about you ↗</a>' +
        '<button class="btn pri go" type="button">Draft</button></div>';
      var goal = pop.querySelector(".goal"), go = pop.querySelector(".go");
      goal.value = mem.goal || "";
      if (errText) pop.querySelector(".err").innerHTML = errText;
      goal.focus();
      goal.addEventListener("input", function () { mem.goal = goal.value; });
      goal.addEventListener("keydown", function (e) { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go.click(); } });
      pop.querySelectorAll(".md button").forEach(function (b) {
        b.addEventListener("click", function () { mode = mem.mode = b.getAttribute("data-v"); formView(); });
      });
      pop.querySelectorAll(".tn button").forEach(function (b) {
        b.addEventListener("click", function () {
          tone = mem.tone = b.getAttribute("data-v");
          pop.querySelectorAll(".tn button").forEach(function (x) { x.classList.toggle("on", x === b); });
        });
      });
      go.addEventListener("click", function () { run(go); });
    }

    async function run(go) {
      var cur = currentEmail(root, null);
      var body = findBody(root);
      var payload = {
        mode: mode, tone: tone, goal: (mem.goal || "").trim(),
        to_email: who ? who.email : "", to_name: who ? who.full : "",
        subject: cur.subject, draft: mode === "improve" ? textOf(cur.body) : "",
        thread: replyContext(root),
        has_signature: !!(body && body.querySelector(".gmail_signature, [data-smartmail='gmail_signature']")),
      };
      if (mode === "new" && !payload.goal && !payload.thread) {
        pop.querySelector(".err").textContent = "Say what the email is for.";
        pop.querySelector(".goal").focus();
        return;
      }
      go.disabled = true;
      go.innerHTML = '<span class="spin"></span>Writing…';
      var s = await chrome.storage.local.get(["apiKey"]);
      if (!s.apiKey) { formView("Sign in to MailSpy first (click its icon in Chrome's toolbar)."); return; }
      var d;
      try {
        var res = await fetch(SERVER + "/api/draft", { method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": s.apiKey }, body: JSON.stringify(payload) });
        d = await res.json().catch(function () { return { error: "Drafting failed. Try again." }; });
      } catch (e) { d = { error: "Couldn't reach MailSpy. Check your connection." }; }
      if (!aiHost) return;
      if (d.error) {
        formView(esc(d.error) + (d.needsKey ? ' <a target="_blank" rel="noreferrer" href="' + SERVER + '/settings#claude_key">Open Settings ↗</a>' : ""));
        return;
      }
      mem.result = d;
      resultView(d);
    }

    function resultView(d) {
      var meta = [d.role, d.company].filter(Boolean).join(" at ");
      pop.innerHTML = '<div class="top"><div class="ttl" style="margin:0"><b>Draft</b><span class="ctx">' + esc(meta ? "Knows: " + meta : ctxText) + "</span></div></div>" +
        '<div class="body"><div class="form">' +
        '<div><div class="lbl">Subject</div><input type="text" class="sj" maxlength="300"></div>' +
        '<div><div class="lbl">Email (edit it here or after inserting)</div><textarea class="out"></textarea></div>' +
        (d.cut ? '<div class="err">This draft was cut off. Try again, or ask for a shorter one.</div>' : "") +
        '<div class="note">Read it before you send: check every fact is right.</div></div></div>' +
        '<div class="foot"><div class="acts"><button class="btn back" type="button">Back</button><button class="btn again" type="button">Try again</button></div>' +
        '<button class="btn pri ins" type="button">' + (hasText ? "Replace my email" : "Insert") + "</button></div>";
      var sj = pop.querySelector(".sj"), out = pop.querySelector(".out");
      sj.value = d.subject || "";
      out.value = d.body || "";
      pop.querySelector(".back").addEventListener("click", function () { formView(); });
      pop.querySelector(".again").addEventListener("click", function (e) { formView(); run(pop.querySelector(".go")); });
      pop.querySelector(".ins").addEventListener("click", function () {
        var subj = root.querySelector('input[name="subjectbox"]');
        var newSubj = sj.value.trim();
        if (subj && newSubj && (!subj.value.trim() || mode === "improve" || !hasText)) {
          if (!/^(re|fwd?):/i.test(subj.value.trim())) {        // keep "Re:" subjects as Gmail set them
            subj.value = newSubj;
            subj.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }
        if (textOf(currentEmail(root, null).body)) clearWritten(root);
        insertTemplate(root, { subject: "", body: draftHtml(out.value) }, {}, null);
        aiMemory.delete(root);
        closeDrafter();
        var b = findBody(root);
        if (b) b.focus();
      });
    }

    if (mem.result) resultView(mem.result); else formView();
  }

  // ------------------------------------------------------------ find an email
  // Two ways in, both opening the finder (finder-ui.js):
  //   * a "Find email" link next to Cc / Bcc,
  //   * a hint under the To field when you type a name, or paste a LinkedIn
  //     link, instead of an address: "Find email for Jane Doe".
  // Picking a result adds it as a recipient (pasted into To, so Gmail makes a
  // normal recipient chip).
  var FIND_CSS = `
    :host { all: initial; display: inline; }
    a { font: 14px/24px "Google Sans", Roboto, RobotoDraft, Helvetica, Arial, sans-serif; color: #444746; cursor: pointer; margin-right: 8px;
        display: inline-flex; align-items: center; gap: 4px; height: 24px; white-space: nowrap; }
    a:hover { color: #0b57d0; }
    svg { width: 15px; height: 15px; }
  `;
  var SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>';
  var HINT_CSS = `
    :host { all: initial; position: fixed; z-index: 2147483000; }
    button { display: inline-flex; align-items: center; gap: 7px; max-width: 360px; height: 32px; padding: 0 12px; border-radius: 16px;
             border: 1px solid #c4c7c5; background: #fff; color: #1f1f1f; cursor: pointer; white-space: nowrap; overflow: hidden;
             font: 13px "Google Sans", Roboto, Arial, sans-serif; box-shadow: 0 1px 3px rgba(60,64,67,.2), 0 2px 8px rgba(60,64,67,.12); }
    button:hover { background: #f8f9fa; }
    b { font-weight: 500; overflow: hidden; text-overflow: ellipsis; }
    svg { width: 15px; height: 15px; flex: none; color: #0b57d0; }
    kbd { font: 11px Roboto, Arial, sans-serif; color: #5f6368; border: 1px solid #dadce0; border-radius: 4px; padding: 0 4px; }
  `;

  // Add an address to this compose window's To field, the way a paste would.
  function addRecipient(root, email, replaceTyped) {
    var to = root.querySelector('input[aria-label="To recipients"]') || root.querySelector('textarea[name="to"]');
    if (!to) return false;
    to.focus();
    if (replaceTyped && to.value) { to.value = ""; to.dispatchEvent(new Event("input", { bubbles: true })); }
    var dt = new DataTransfer();
    dt.setData("text/plain", email);
    var ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    to.dispatchEvent(ev);
    if (!ev.defaultPrevented) {                       // Gmail didn't take the paste: type it in instead
      to.value = (to.value ? to.value.replace(/[,\s]*$/, ", ") : "") + email + ", ";
      to.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return true;
  }

  function openFind(anchor, root, prefill) {
    if (!window.__mailspyFinder) return;
    prefill = prefill || {};
    window.__mailspyFinder.open({
      anchor: anchor, mode: "person", name: prefill.name || "", company: prefill.company || "",
      actionLabel: "Add", doneLabel: "Added",
      onPick: function (email) { return addRecipient(root, email, !!prefill.fromTyped); },
      onAutoTry: function (list, name, cap) {
        if (!addRecipient(root, list[0], !!prefill.fromTyped)) return false;
        plans.set(root, { cands: list.slice(), name: name, cap: Math.max(2, Math.min(cap || list.length, list.length)) });
        renderTryPill(root);
        return true;
      },
      auto: !!(prefill.name && prefill.company),
    });
  }

  function addFindLink(cc) {
    var holder = cc.parentElement;
    if (!holder || holder.querySelector(".mailspy-find-host")) return;
    var root = composeRoot(cc);
    if (!root) return;
    var host = document.createElement("span");
    host.className = "mailspy-find-host";
    var sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = "<style>" + FIND_CSS + '</style><a role="link" title="Find someone\'s work email, or a company\'s recruiters (MailSpy)">' +
      SEARCH_ICON + "Find email</a>";
    var a = sr.querySelector("a");
    a.addEventListener("mousedown", function (e) { e.preventDefault(); e.stopPropagation(); });
    a.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); openFind(a, root); });
    // Placed just left of "Cc" without taking up room: Gmail sizes the To box
    // before we arrive, so a wider row would push Cc and Bcc onto a new line.
    if (getComputedStyle(holder).position === "static") holder.style.position = "relative";
    // same 24px line box as Gmail's Cc / Bcc, so the text shares their baseline
    host.style.cssText = "position:absolute;right:100%;top:0;height:24px;white-space:nowrap";
    holder.insertBefore(host, cc);
    var to = root.querySelector('input[aria-label="To recipients"]');
    if (to) to.style.paddingRight = "96px";           // typed addresses stay clear of "Find email"
  }

  // The hint under To: shown when what you've typed is a name or a LinkedIn link, not an address.
  var hintHost = null, hintFor = null;
  function hideHint() { if (hintHost) hintHost.style.display = "none"; hintFor = null; }
  function typedLooksLikePerson(v) {
    v = String(v || "").trim();
    if (!v || v.indexOf("@") >= 0) return false;
    if (window.__mailspyFinder && window.__mailspyFinder.nameFromLinkedIn(v)) return true;
    return /^[A-Za-zÀ-ÿ'’.-]{2,}(\s+[A-Za-zÀ-ÿ'’.-]{1,}){1,3}$/.test(v);   // two to four words, letters only
  }
  function showHint(to, root) {
    var v = to.value.trim();
    if (!hintHost || !document.contains(hintHost)) {
      hintHost = document.createElement("div");
      hintHost.className = "mailspy-find-hint";
      var sr = hintHost.attachShadow({ mode: "open" });
      sr.innerHTML = "<style>" + HINT_CSS + "</style><button type=\"button\">" + SEARCH_ICON + "<span>Find email for <b></b></span><kbd>Tab</kbd></button>";
      var b = sr.querySelector("button");
      b.addEventListener("mousedown", function (e) { e.preventDefault(); e.stopPropagation(); });
      b.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); useHint(); });
      document.body.appendChild(hintHost);
    }
    var li = window.__mailspyFinder && window.__mailspyFinder.nameFromLinkedIn(v);
    hintHost.shadowRoot.querySelector("b").textContent = li || v;
    hintFor = { to: to, root: root };
    var r = to.getBoundingClientRect();
    hintHost.style.left = Math.round(r.left) + "px";
    hintHost.style.top = Math.round(r.bottom + 4) + "px";
    hintHost.style.display = "block";
  }
  function useHint() {
    if (!hintFor) return;
    var to = hintFor.to, root = hintFor.root, v = to.value.trim();
    hideHint();
    openFind(to, root, { name: v, fromTyped: true });
  }
  document.addEventListener("input", function (e) {
    var t = e.target;
    if (!alive() || !t || t.tagName !== "INPUT" || t.getAttribute("aria-label") !== "To recipients") return;
    var root = composeRoot(t);
    if (root && typedLooksLikePerson(t.value)) showHint(t, root); else hideHint();
  }, true);
  document.addEventListener("keydown", function (e) {
    if (!hintFor || !hintHost || hintHost.style.display === "none") return;
    if (e.target !== hintFor.to) return;
    if (e.key === "Tab" && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); useHint(); }
    else if (e.key === "Escape") hideHint();
  }, true);
  document.addEventListener("focusout", function (e) {
    if (hintFor && e.target === hintFor.to) setTimeout(function () { if (hintFor && document.activeElement !== hintFor.to) hideHint(); }, 150);
  }, true);

  // ------------------------------------------------------------ auto-try
  // From the finder: "Try the top N until one works". The best guess becomes
  // the recipient, and a small "↻ Try N" pill sits next to Send (click it to
  // change N, see the order, or turn it off). On Send, content.js passes the
  // plan to MailSpy, which sends to the next address each time one bounces
  // (src/retry.js). A small note bottom-left shows how it's going.
  var plans = new Map();   // compose root -> { cands, name, cap }

  var TRY_CSS = `
    :host { all: initial; display: inline-flex; vertical-align: middle; position: relative; }
    .pill { display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 14px 0 12px; margin-left: 8px;
            border: 1px solid #a8dab5; border-radius: 18px; background: #e6f4ea; color: #137333; cursor: pointer;
            font: 500 14px/1 "Google Sans", Roboto, Arial, sans-serif; white-space: nowrap; }
    .pill:hover { background: #d7efdf; }
    .menu { position: absolute; bottom: 44px; left: 8px; width: 300px; background: #fff; color: #1f1f1f; border-radius: 12px; padding: 12px;
            box-shadow: 0 4px 8px 3px rgba(60,64,67,.15), 0 1px 3px rgba(60,64,67,.3); font: 13px/1.45 "Google Sans", Roboto, Arial, sans-serif; }
    .menu[hidden] { display: none; }
    .menu p { margin: 0 0 8px; color: #5f6368; font-size: 12px; }
    ol { margin: 0 0 10px; padding-left: 20px; }
    ol { list-style: decimal inside; padding-left: 2px; }
    li { font: 12.5px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    li.off { color: #bdc1c6; text-decoration: line-through; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .step { display: inline-flex; align-items: center; border: 1px solid #c4c7c5; border-radius: 15px; height: 28px; }
    .step button { border: 0; background: none; width: 26px; height: 26px; cursor: pointer; color: #0b57d0; font-size: 16px; border-radius: 50%; }
    .step button:disabled { color: #c4c7c5; cursor: default; }
    .step b { min-width: 14px; text-align: center; font-weight: 500; }
    .stop { border: 0; background: none; color: #b3261e; cursor: pointer; font: 500 12.5px "Google Sans", Roboto, Arial, sans-serif; padding: 4px 6px; border-radius: 6px; }
    .stop:hover { background: #fce8e6; }
  `;

  function rootOfPlan(el) {
    var found = null;
    plans.forEach(function (p, r) { if (!found && (r === el || r.contains(el) || el.contains(r))) found = r; });
    return found;
  }

  function renderTryPill(root) {
    var plan = plans.get(root);
    var old = root.querySelector(".mailspy-try-host");
    if (!plan) { if (old) old.remove(); return; }
    var send = root.querySelector('[role=button][data-tooltip^="Send"], [role=button][aria-label^="Send"]');
    if (!send) return;
    var host = old;
    if (!host) {
      var span = sendRowHost(send, "mailspy-try-host");
      var sr = span.attachShadow({ mode: "open" });
      sr.innerHTML = "<style>" + TRY_CSS + "</style>" +
        '<button class="pill" type="button"></button>' +
        '<div class="menu" hidden><p>MailSpy sends to the first address. If it bounces, the same email goes to the next one, so only one ever arrives.</p>' +
        '<ol></ol><div class="row"><span class="step"><button class="dn" type="button" aria-label="Fewer">−</button><b></b>' +
        '<button class="up" type="button" aria-label="More">+</button></span><button class="stop" type="button">Turn off</button></div></div>';
      host = root.querySelector(".mailspy-try-host");
      var menu = sr.querySelector(".menu");
      sr.querySelector(".pill").addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); menu.hidden = !menu.hidden; });
      sr.querySelector(".dn").addEventListener("click", function () { var p = plans.get(root); if (p && p.cap > 2) { p.cap--; renderTryPill(root); } });
      sr.querySelector(".up").addEventListener("click", function () { var p = plans.get(root); if (p && p.cap < p.cands.length) { p.cap++; renderTryPill(root); } });
      sr.querySelector(".stop").addEventListener("click", function () { plans.delete(root); renderTryPill(root); });
      ["mousedown", "keydown"].forEach(function (t) { span.addEventListener(t, function (e) { e.stopPropagation(); }); });
      document.addEventListener("mousedown", function (e) { if (!e.composedPath().includes(span)) menu.hidden = true; }, true);
    }
    var s = (host.querySelector("span") || host).shadowRoot || host.shadowRoot;
    s.querySelector(".pill").textContent = "↻ Try " + plan.cap;
    s.querySelector(".pill").title = "Auto-try " + plan.cap + " addresses: " + plan.cands.slice(0, plan.cap).join(", ");
    s.querySelector("ol").innerHTML = plan.cands.map(function (c, i) { return '<li class="' + (i < plan.cap ? "" : "off") + '">' + esc(c) + "</li>"; }).join("");
    s.querySelector("b").textContent = plan.cap;
    s.querySelector(".dn").disabled = plan.cap <= 2;
    s.querySelector(".up").disabled = plan.cap >= plan.cands.length;
  }

  // What's in To right now (chips, or typed addresses)
  function recipientsOf(root) {
    var out = [];
    root.querySelectorAll("[email], [role=option][data-hovercard-id*='@']").forEach(function (c) {
      var e = (c.getAttribute("email") || c.getAttribute("data-hovercard-id") || "").toLowerCase();
      if (e && out.indexOf(e) < 0) out.push(e);
    });
    return out;
  }

  // For content.js at Send: the plan, if it still fits (one recipient: the first guess).
  function retryPlan(el) {
    var root = rootOfPlan(el);
    var plan = root && plans.get(root);
    if (!plan) return null;
    var rec = recipientsOf(root);
    if (rec.length !== 1 || rec[0] !== plan.cands[0]) return null;    // you changed the recipients: send normally
    return { cands: plan.cands.slice(0, plan.cap), name: plan.name };
  }

  // ---- progress note (bottom-left, like Gmail's own) ----
  var TOAST_CSS = `
    :host { all: initial; position: fixed; left: 24px; bottom: 24px; z-index: 2147483002; }
    .t { display: flex; align-items: flex-start; gap: 12px; max-width: 420px; padding: 12px 14px 12px 16px; border-radius: 8px;
         background: #323232; color: #fff; font: 14px/1.4 "Google Sans", Roboto, Arial, sans-serif; box-shadow: 0 3px 8px rgba(0,0,0,.3); }
    .m { flex: 1; } .s { display: block; color: #bdc1c6; font-size: 12.5px; margin-top: 2px; word-break: break-all; }
    .ok { color: #81c995; } .bad { color: #f28b82; }
    button { border: 0; background: none; color: #bdc1c6; cursor: pointer; font-size: 18px; line-height: 1; padding: 0 2px; }
  `;
  function toast() {
    var h = document.createElement("div");
    h.className = "mailspy-try-toast";
    var sr = h.attachShadow({ mode: "open" });
    sr.innerHTML = "<style>" + TOAST_CSS + '</style><div class="t"><div class="m"><span class="l"></span><span class="s"></span></div><button aria-label="Close">×</button></div>';
    sr.querySelector("button").addEventListener("click", function () { h.remove(); });
    document.body.appendChild(h);
    return {
      set: function (line, sub, cls) {
        var l = sr.querySelector(".l"); l.textContent = line; l.className = "l " + (cls || "");
        sr.querySelector(".s").textContent = sub || "";
      },
      close: function (ms) { setTimeout(function () { h.remove(); }, ms || 0); },
    };
  }

  // After Send: ask MailSpy every few seconds how it's going, for up to ~6 minutes.
  async function watchRetry(token, plan) {
    var t = toast(), started = Date.now(), lastStep = 1;
    t.set("Sending to " + plan.cands[0] + "…", "Auto-try: " + plan.cands.length + " addresses");
    var s = await chrome.storage.local.get(["apiKey"]);
    for (;;) {
      await new Promise(function (r) { setTimeout(r, 5000); });
      if (!alive()) return;
      var st = null;
      try {
        var r = await fetch(SERVER + "/api/retry", { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": s.apiKey },
          body: JSON.stringify({ token: token }) });
        if (r.ok) st = await r.json();
      } catch (e) {}
      if (!st) continue;
      var secs = Math.round((Date.now() - started) / 1000);
      if (st.state === "watching" || st.state === "scheduled") {
        if (st.state === "scheduled") { t.set("Scheduled. MailSpy will auto-try when it sends.", ""); t.close(6000); return; }
        var bounced = (st.tried || []).filter(function (x) { return x.result === "bounced"; }).map(function (x) { return x.to; });
        if (st.step !== lastStep) started = Date.now(), lastStep = st.step;
        t.set(bounced.length ? "Bounced. Trying " + st.current + " (" + st.step + " of " + st.total + ")…"
                             : "Checking " + st.current + " for a bounce…",
              bounced.length ? "Didn't exist: " + bounced.join(", ") : "Usually takes under a minute");
      } else if (st.state === "delivered") {
        t.set("Delivered to " + st.current + " ✓", st.step > 1 ? (st.step - 1) + " bounced first (moved to Trash)" : "No bounce, so it got through", "ok");
        t.close(9000); return;
      } else if (st.state === "exhausted") {
        t.set("None of the " + st.total + " addresses worked", "Try Find email again with a different name or company", "bad");
        t.close(15000); return;
      } else {
        t.set(st.state === "nogmail" ? "Connect Gmail in MailSpy Settings to auto-try" : "Couldn't check this email", "", "bad");
        t.close(9000); return;
      }
      if (Date.now() - started > 360000) {
        t.set("Still checking in the background", "MailSpy will keep trying and notify you", "");
        t.close(8000); return;
      }
    }
  }

  // Scheduled instead of sent: MailSpy runs auto-try when Gmail sends it.
  function scheduledTry(plan, when) {
    var t = toast();
    t.set("Scheduled for " + when + " · Auto-try " + plan.cands.length + " addresses",
          "If " + plan.cands[0] + " bounces, MailSpy sends it to the next one. You'll get a notification.", "ok");
    t.close(10000);
  }
  // A short note in the corner (content.js: email sent untracked from another account).
  window.__mailspyCompose.notice = function (line, sub) {
    var t = toast(); t.set(line, sub || ""); t.close(10000);
  };
  window.__mailspyCompose.scheduledTry = function (plan, when) {
    scheduledTry(plan, when);
    var root = null;
    plans.forEach(function (p, r) { if (p.cands[0] === plan.cands[0]) root = r; });
    if (root) plans.delete(root);
  };
  window.__mailspyCompose.retryPlan = retryPlan;
  window.__mailspyCompose.watchRetry = function (token, plan, el) {
    var root = el && rootOfPlan(el);
    if (root) { plans.delete(root); }
    watchRetry(token, plan);
  };

  function scanFind() {
    document.querySelectorAll('[aria-label^="Add Cc recipients"]').forEach(addFindLink);
  }

  // ------------------------------------------------------------ link tracking
  // Links are left alone unless you choose to track them. Hover a link in the
  // email (or put the cursor in it, or add a new one) and a small "Track clicks"
  // switch appears above it. Your choice is kept on the link as
  // data-mailspy-track="1" / "0"; content.js reads it and removes it on Send.
  // With "Track every link" on in Settings, links start switched on instead.
  var MARK_ATTR = "data-mailspy-track";
  var OURS = [SERVER, "https://go.aryanh.dev"];
  var trackAll = false;

  (async function loadPref() {
    try {
      var s = await chrome.storage.local.get(["apiKey"]);
      if (!s.apiKey) return;
      var r = await fetch(SERVER + "/api/me", { headers: { "X-API-Key": s.apiKey } });
      if (r.ok) {
        var me = await r.json();
        trackAll = !!me.track_all_links;
        pdfTilesOn = me.pdf_tiles === true;
        scanChips();
      }
    } catch (e) {}
  })();

  // A dotted underline and a small arrow mark tracked links while you write.
  // This stylesheet lives in Gmail's page, not in the email, so none of it is sent.
  document.querySelectorAll("style.mailspy-link-style").forEach(function (n) { n.remove(); });
  var linkStyle = document.createElement("style");
  linkStyle.className = "mailspy-link-style";
  linkStyle.textContent =
    '[contenteditable="true"] a[' + MARK_ATTR + '="1"] { text-decoration: underline dotted #188038 !important; text-underline-offset: 3px; }' +
    '[contenteditable="true"] a[' + MARK_ATTR + '="1"]::after { content: ""; display: inline-block; width: 11px; height: 11px; margin-left: 3px;' +
    ' vertical-align: -1px; background: url("data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#188038" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M8 7h9v9"/></svg>') +
    '") center/contain no-repeat; }';
  document.head.appendChild(linkStyle);

  function isTrackable(a) {
    var href = (a.getAttribute("href") || "").trim();
    if (!/^https?:\/\//i.test(href)) return false;
    for (var i = 0; i < OURS.length; i++) if (href.indexOf(OURS[i] + "/") === 0) return false;
    return !!a.closest('[contenteditable="true"]') && !!composeRoot(a);
  }
  function isTracked(a) {
    var v = a.getAttribute(MARK_ATTR);
    return v === "1" || (v !== "0" && trackAll);
  }

  var PILL_CSS = `
    :host { all: initial; position: fixed; z-index: 2147483000; }
    .pill { display: inline-flex; align-items: center; gap: 8px; height: 30px; padding: 0 6px 0 10px; border-radius: 15px;
            background: #fff; border: 1px solid #dadce0; box-shadow: 0 1px 3px rgba(60,64,67,.2), 0 2px 8px rgba(60,64,67,.12);
            font: 500 12.5px/1 "Google Sans", Roboto, Arial, sans-serif; color: #3c4043; cursor: pointer; user-select: none;
            white-space: nowrap; }
    .pill:hover { background: #f8f9fa; }
    .sw { position: relative; width: 28px; height: 16px; border-radius: 8px; background: #bdc1c6; transition: background .15s; flex: none; }
    .sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: #fff;
                 transition: transform .15s; box-shadow: 0 1px 2px rgba(0,0,0,.25); }
    .on .sw { background: #188038; }
    .on .sw::after { transform: translateX(12px); }
    .on .lbl { color: #188038; }
  `;
  var pillHost = null, pill = null, pillLink = null, hideTimer = null;

  function ensurePill() {
    if (pillHost && document.contains(pillHost)) return;
    document.querySelectorAll(".mailspy-link-pill").forEach(function (n) { n.remove(); });
    pillHost = document.createElement("div");
    pillHost.className = "mailspy-link-pill";
    var sr = pillHost.attachShadow({ mode: "open" });
    sr.innerHTML = "<style>" + PILL_CSS + '</style><div class="pill" role="switch" title="Count clicks on this link (MailSpy)">' +
      '<span class="lbl">Track clicks</span><span class="sw"></span></div>';
    pill = sr.querySelector(".pill");
    // mousedown, not click: keeps the cursor (and Gmail's selection) where it is
    pill.addEventListener("mousedown", function (e) {
      e.preventDefault(); e.stopPropagation();
      if (!pillLink || !document.contains(pillLink)) return hidePill(0);
      pillLink.setAttribute(MARK_ATTR, isTracked(pillLink) ? "0" : "1");
      var body = pillLink.closest('[contenteditable="true"]');
      if (body) body.dispatchEvent(new Event("input", { bubbles: true })); // Gmail saves the draft
      paint();
    });
    pillHost.addEventListener("mouseenter", function () { clearTimeout(hideTimer); });
    pillHost.addEventListener("mouseleave", function () { hidePill(350); });
    pillHost.style.display = "none";
    document.body.appendChild(pillHost);
  }

  function paint() {
    if (!pill || !pillLink) return;
    var on = isTracked(pillLink);
    pill.classList.toggle("on", on);
    pill.setAttribute("aria-checked", on ? "true" : "false");
    pill.querySelector(".lbl").textContent = on ? "Tracking clicks" : "Track clicks";
  }

  function place() {
    if (!pillHost || !pillLink) return;
    var rects = pillLink.getClientRects();
    var r = rects.length ? rects[0] : pillLink.getBoundingClientRect();
    if (!r.width && !r.height) return hidePill(0);
    var top = r.top - 36;                       // above the link (Gmail's own link bubble goes below)
    if (top < 4) top = r.bottom + 6;
    pillHost.style.top = Math.round(top) + "px";
    pillHost.style.left = Math.round(Math.max(4, Math.min(r.left, window.innerWidth - 160))) + "px";
  }

  function showPill(a, autoHideMs) {
    if (!alive()) return;
    ensurePill();
    clearTimeout(hideTimer);
    pillLink = a;
    paint();
    pillHost.style.display = "block";
    place();
    if (autoHideMs) hidePill(autoHideMs);
  }

  function hidePill(ms) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      if (pillHost) pillHost.style.display = "none";
      pillLink = null;
    }, ms || 0);
  }

  function linkFrom(node) {
    var el = node && (node.nodeType === 1 ? node : node.parentElement);
    var a = el && el.closest && el.closest("a[href]");
    return a && isTrackable(a) ? a : null;
  }

  // hover
  document.addEventListener("mouseover", function (e) {
    if (!alive()) return;
    var a = linkFrom(e.target);
    if (a) showPill(a);
  }, true);
  document.addEventListener("mouseout", function (e) {
    if (!pillLink) return;
    var a = linkFrom(e.target);
    if (a && a === pillLink && !(e.relatedTarget && pillHost && pillHost.contains(e.relatedTarget))) hidePill(450);
  }, true);

  // cursor inside a link
  document.addEventListener("selectionchange", function () {
    if (!alive()) return;
    var sel = document.getSelection();
    var a = sel && sel.rangeCount ? linkFrom(sel.anchorNode) : null;
    if (a) showPill(a);
    else if (pillLink && pillHost && !pillHost.matches(":hover")) hidePill(200);
  });

  // a link was just added (typed, pasted or inserted): offer it for a few seconds
  var seen = new WeakSet();
  function noteLinks(body, offer) {
    var fresh = null;
    body.querySelectorAll("a[href]").forEach(function (a) {
      if (seen.has(a)) return;
      seen.add(a);
      if (offer && isTrackable(a)) fresh = a;
    });
    if (fresh) showPill(fresh, 6000);
  }
  // Gmail only turns a typed or pasted web address into a link when the email
  // is sent, so there'd be nothing to switch on while writing. Make it a link
  // as soon as it's finished (space, Enter, or paste); the email looks the same.
  var URL_IN_TEXT = /(?:https?:\/\/|www\.)[^\s<>"']*[^\s<>"'.,;:!?)\]}]/g;

  function linkifyAtCaret(body, allowAtCaret) {
    var sel = document.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
    var node = sel.anchorNode, caret = sel.anchorOffset;
    if (!node || node.nodeType !== 3 || !body.contains(node)) return;
    if (node.parentElement && node.parentElement.closest("a")) return;
    var text = node.data, hits = [], m;
    URL_IN_TEXT.lastIndex = 0;
    while ((m = URL_IN_TEXT.exec(text))) {
      var end = m.index + m[0].length;
      if (m.index > 0 && !/\s/.test(text[m.index - 1])) continue;   // part of a longer word
      if (end < caret || (allowAtCaret && end === caret)) hits.push([m.index, end, m[0]]);
    }
    if (!hits.length) return;
    var tail = node, last = hits[hits.length - 1];
    for (var i = hits.length - 1; i >= 0; i--) {
      var h = hits[i];
      var after = node.splitText(h[1]);
      if (i === hits.length - 1) tail = after;
      var mid = node.splitText(h[0]);
      var a = document.createElement("a");
      a.href = /^www\./i.test(h[2]) ? "https://" + h[2] : h[2];
      mid.parentNode.insertBefore(a, mid);
      a.appendChild(mid);
    }
    var r = document.createRange();
    r.setStart(tail, Math.max(0, Math.min(tail.length, caret - last[1])));
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  var watched = new WeakSet();
  function watchBodies() {
    document.querySelectorAll('[role=dialog] [contenteditable="true"], .M9 [contenteditable="true"], .iN [contenteditable="true"]').forEach(function (body) {
      if (watched.has(body)) return;
      watched.add(body);
      noteLinks(body, false); // links already there (signature, quoted reply) don't pop up
      body.addEventListener("input", function (e) {
        if (!alive()) return;
        if (e.inputType === "insertFromPaste" || e.inputType === "insertFromDrop") linkifyAtCaret(body, true);
        else if (e.inputType === "insertText" && /^\s$/.test(e.data || "")) linkifyAtCaret(body, false);
      });
      body.addEventListener("keydown", function (e) {
        if (alive() && e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) linkifyAtCaret(body, true);
      }, true);
      new MutationObserver(function () { if (alive()) noteLinks(body, true); })
        .observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] });
    });
  }

  window.addEventListener("scroll", function () { if (pillLink) place(); }, true);
  window.addEventListener("resize", function () { if (pillLink) place(); });

  var timer = setInterval(function () {
    if (!alive()) {
      clearInterval(timer);
      document.querySelectorAll(".mailspy-pdf-host, .mailspy-tpl-host, .mailspy-tpl-pop, .mailspy-ai-host, .mailspy-ai-pop, .mailspy-link-pill, .mailspy-chip-host, .mailspy-find-host, .mailspy-find-pop, .mailspy-find-hint, .mailspy-finder, .mailspy-try-host, style.mailspy-link-style").forEach(function (n) { n.remove(); });
      return;
    }
    scan();
    watchBodies();
    scanChips();
    scanFind();
  }, 1200);
  scan();
  watchBodies();
  scanChips();
  scanFind();
})();
