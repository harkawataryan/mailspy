// Running your own copy (cloudflare/scripts/apply-config.mjs): one config file
// sets the domains in the extension and the Worker. Also does a full dry run on
// a copy of the repo with someone else's domains and checks nothing still
// points at the original ones.
import { readFileSync, writeFileSync, mkdtempSync, cpSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const ROOT = new URL("../../", import.meta.url);
const C = await import(new URL("cloudflare/scripts/apply-config.mjs", ROOT).href);

let results = [];
const check = (n, c, d) => { results.push(!!c); console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  [" + JSON.stringify(d) + "]")); };

const friend = { name: "PingBack", app: "https://track.example.org/", track: "https://t.example.org", home: "https://example.org",
  extensionStoreUrl: "", cloudflare: { databaseId: "11111111-2222-3333-4444-555555555555", kvId: "abcdefabcdefabcdefabcdefabcdefab" } };

const cfg = C.readConfig(JSON.stringify(friend));
check("addresses normalised to origins", cfg.app === "https://track.example.org" && cfg.track === "https://t.example.org", cfg);
let err = "";
try { C.readConfig(JSON.stringify({ ...friend, app: "http://x.org" })); } catch (e) { err = e.message; }
check("http:// refused", /https/.test(err), err);
try { err = ""; C.readConfig(JSON.stringify({ ...friend, track: friend.app })); } catch (e) { err = e.message; }
check("app and track must differ", /different/.test(err), err);

const js = C.siteJs(cfg);
check("site.js defines the shared values", /var MAILSPY_APP = "https:\/\/track\.example\.org";/.test(js) && /var MAILSPY_TRACK_HOST = "t\.example\.org";/.test(js), js);

// ---- full dry run on a copy of the repo
const dir = mkdtempSync(join(tmpdir(), "mailspy-config-"));
cpSync(new URL("extension", ROOT), join(dir, "extension"), { recursive: true });
cpSync(new URL("cloudflare/wrangler.toml", ROOT), join(dir, "cloudflare", "wrangler.toml"), { recursive: true });
writeFileSync(join(dir, "mailspy.config.json"), JSON.stringify(friend));
execFileSync(process.execPath, [fileURLToPath(new URL("cloudflare/scripts/apply-config.mjs", ROOT)), dir]);

const files = [];
const walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? (f !== "lib" && walk(p)) : files.push(p); } };
walk(dir);
const leftovers = files.filter(f => readFileSync(f, "utf8").includes("aryanh.dev")).map(f => f.slice(dir.length));
check("nothing in the extension or wrangler.toml still points at aryanh.dev", leftovers.length === 0, leftovers);

const m = JSON.parse(readFileSync(join(dir, "extension", "manifest.json"), "utf8"));
check("manifest: name, homepage and permission use the new app address", m.name === "PingBack: Email Tracking for Gmail"
  && m.homepage_url === "https://track.example.org/privacy" && m.host_permissions.includes("https://track.example.org/*"), m);
check("manifest: sign-in page matcher moved, site.js loads first everywhere", m.content_scripts.every(cs => cs.js[0] === "site.js")
  && m.content_scripts.some(cs => cs.matches[0] === "https://track.example.org/extension-link*"), m.content_scripts);
const t = readFileSync(join(dir, "cloudflare", "wrangler.toml"), "utf8");
check("wrangler.toml: routes, TRACK_URL, ids", t.includes('{ pattern = "track.example.org", custom_domain = true }') && t.includes('{ pattern = "t.example.org", custom_domain = true }')
  && /TRACK_URL = "https:\/\/t\.example\.org"/.test(t) && t.includes(friend.cloudflare.databaseId) && t.includes(friend.cloudflare.kvId) && /EXTENSION_URL = ""/.test(t), t.slice(0, 600));
check("every extension script reads the address from site.js", ["config.js", "content.js", "finder-ui.js", "gmail-button.js", "gmail-checks.js", "gmail-compose.js", "site-link.js"]
  .every(f => /MAILSPY_APP|MAILSPY_TRACK/.test(readFileSync(join(dir, "extension", f), "utf8"))), "");
const twice = C.applyToml(t, cfg);
check("applying again changes nothing", twice === t, "");
rmSync(dir, { recursive: true, force: true });

// ---- the repo's own config reproduces the committed files exactly
const own = C.readConfig(readFileSync(new URL("mailspy.config.json", ROOT), "utf8"));
const tomlNow = readFileSync(new URL("cloudflare/wrangler.toml", ROOT), "utf8");
check("your config reproduces your wrangler.toml", C.applyToml(tomlNow, own) === tomlNow, "");
check("your config reproduces your site.js", C.siteJs(own) === readFileSync(new URL("extension/site.js", ROOT), "utf8"), "");

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
if (results.some(r => !r)) process.exit(1);
