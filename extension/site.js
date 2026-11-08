// Generated from mailspy.config.json by cloudflare/scripts/apply-config.mjs. Don't edit.
// Loaded first by every extension script: where this copy of MailSpy lives.
var MAILSPY_NAME = "MailSpy";
var MAILSPY_APP = "https://mailspy.aryanh.dev";                 // dashboard, sign-in and API
var MAILSPY_TRACK = "https://go.aryanh.dev";             // the address used inside emails
var MAILSPY_TRACK_HOST = "go.aryanh.dev";

// Someone running their own MailSpy can point this extension at it instead
// (Sign in page: "Use a different MailSpy server"). That choice is saved in
// chrome.storage; every script waits for MAILSPY_READY before using the address.
var MAILSPY_DEFAULT_APP = MAILSPY_APP;
var MAILSPY_DEFAULT_TRACK_HOST = MAILSPY_TRACK_HOST;
var MAILSPY_READY = (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local)
  ? chrome.storage.local.get(["server", "trackHost"]).then(function (v) {
      if (v.server && /^https:\/\/[^/]+$/.test(v.server)) {
        MAILSPY_APP = v.server;
        if (v.trackHost) { MAILSPY_TRACK_HOST = v.trackHost; MAILSPY_TRACK = "https://" + v.trackHost; }
      }
    }).catch(function () {})
  : Promise.resolve();
