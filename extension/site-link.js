// Runs only on <your MailSpy>/extension-link: after you sign in
// with Google from the extension, that page carries your MailSpy key. Save it
// (the same way the email + password sign-in does) and tell the page.
(function () {
  var box = document.getElementById("mailspy-ext-link");
  if (!box || location.origin !== MAILSPY_APP) return;
  var key = box.getAttribute("data-key") || "";
  if (!/^[A-Za-z0-9_-]{20,}$/.test(key)) return;
  chrome.storage.local.set({
    apiKey: key,
    email: box.getAttribute("data-email") || "",
    name: box.getAttribute("data-name") || "",
  }).then(function () { box.setAttribute("data-connected", "1"); });
})();
