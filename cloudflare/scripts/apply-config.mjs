// Applies mailspy.config.json (repo root) to the extension and the Worker, so
// running your own copy of MailSpy is one file to edit:
//   name               shown in Chrome ("<name>: Email Tracking for Gmail")
//   app                where the dashboard, sign-in and API live
//   track              the address used inside emails (pixel, tracked links, PDFs)
//   home               linked from the tracking address's front page
//   extensionStoreUrl  your Chrome Web Store listing ("" until you have one)
//   cloudflare         your D1 database id and KV namespace id
//
// Writes extension/site.js and updates extension/manifest.json and
// cloudflare/wrangler.toml in place. Runs before every deploy and package;
// run it by hand with `npm run configure` (in cloudflare/).

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const origin = (v, what) => {
  let u;
  try { u = new URL(String(v || "")); } catch { throw new Error(`${what} must be a full https:// address`); }
  if (u.protocol !== "https:") throw new Error(`${what} must start with https://`);
  return u.origin;
};

export function readConfig(text) {
  const c = JSON.parse(text);
  const out = {
    name: String(c.name || "MailSpy").trim(),
    app: origin(c.app, "app"),
    track: origin(c.track, "track"),
    home: c.home ? origin(c.home, "home") : "",
    extensionStoreUrl: String(c.extensionStoreUrl || "").trim(),
    databaseId: String((c.cloudflare || {}).databaseId || "").trim(),
    kvId: String((c.cloudflare || {}).kvId || "").trim(),
  };
  if (!out.name || /["\\]/.test(out.name)) throw new Error("name can't be empty or contain quotes");
  if (new URL(out.app).host === new URL(out.track).host) throw new Error("app and track must be different addresses");
  return out;
}

export function siteJs(c) {
  return `// Generated from mailspy.config.json by cloudflare/scripts/apply-config.mjs. Don't edit.
// Loaded first by every extension script: where this copy of MailSpy lives.
var MAILSPY_NAME = ${JSON.stringify(c.name)};
var MAILSPY_APP = ${JSON.stringify(c.app)};                 // dashboard, sign-in and API
var MAILSPY_TRACK = ${JSON.stringify(c.track)};             // the address used inside emails
var MAILSPY_TRACK_HOST = ${JSON.stringify(new URL(c.track).host)};
`;
}

export function applyManifest(m, c) {
  const app = c.app;
  m.name = `${c.name}: Email Tracking for Gmail`;
  m.homepage_url = `${app}/privacy`;
  m.host_permissions = ["https://mail.google.com/*", `${app}/*`];
  if (m.action) m.action.default_title = c.name;
  for (const cs of m.content_scripts || []) {
    if ((cs.js || []).includes("site-link.js")) cs.matches = [`${app}/extension-link*`];
    if (cs.js && !cs.js.includes("site.js")) cs.js = ["site.js", ...cs.js];
  }
  return m;
}

export function applyToml(toml, c) {
  const host = u => new URL(u).host;
  let t = toml.replace(/routes = \[[\s\S]*?\]/, `routes = [\n  { pattern = "${host(c.app)}", custom_domain = true },\n  { pattern = "${host(c.track)}", custom_domain = true },\n]`);
  const setVar = (name, value) => {
    const re = new RegExp(`^(${name}\\s*=\\s*)"[^"]*"`, "m");
    if (!re.test(t)) throw new Error(`wrangler.toml has no ${name}`);
    t = t.replace(re, `$1${JSON.stringify(value)}`);
  };
  setVar("TRACK_URL", c.track);
  setVar("TRACK_HOME", c.home);
  setVar("EXTENSION_URL", c.extensionStoreUrl);
  if (c.databaseId) t = t.replace(/^(database_id\s*=\s*)"[^"]*"/m, `$1"${c.databaseId}"`);
  if (c.kvId) t = t.replace(/(\[\[kv_namespaces\]\][^\[]*?\nid\s*=\s*)"[^"]*"/, `$1"${c.kvId}"`);
  return t;
}

// ---- run
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const c = readConfig(readFileSync(join(root, "mailspy.config.json"), "utf8"));
  const ext = join(root, "extension"), cf = join(root, "cloudflare");
  writeFileSync(join(ext, "site.js"), siteJs(c));
  const mPath = join(ext, "manifest.json");
  const m = applyManifest(JSON.parse(readFileSync(mPath, "utf8")), c);
  writeFileSync(mPath, JSON.stringify(m, null, 2) + "\n");
  const tPath = join(cf, "wrangler.toml");
  writeFileSync(tPath, applyToml(readFileSync(tPath, "utf8"), c));
  console.log(`configured for ${c.app} (emails use ${c.track})`);
}
