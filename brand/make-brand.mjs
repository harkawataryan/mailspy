// Generates every MailSpy logo asset from one definition.
//
//   node brand/make-brand.mjs
//
// Writes:
//   brand/mailspy-mark.svg            the app mark (rounded tile)
//   brand/mailspy-logo.svg            mark + wordmark, for light backgrounds
//   brand/mailspy-logo-dark.svg       mark + wordmark, for dark backgrounds
//   brand/store-icon-128.png          Chrome Web Store icon (96px art, 16px transparent margin)
//   brand/mailspy-mark-512.png        large PNG for anywhere else
//   extension/icon16.png, icon48.png, icon128.png
//
// Needs Google Chrome installed (used headless to rasterize).

import { writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

import { markSVG } from "./mark.js";
export { markSVG };

function inner(svg) { return svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, ""); }

function lockupSVG(dark) {
  const text = dark ? "#f8fafc" : "#0f172a";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 96" width="420" height="96">
  <g>${inner(markSVG(dark ? "lkd" : "lkl"))}</g>
  <text x="116" y="64" font-family="Inter, 'Segoe UI', 'SF Pro Display', Roboto, Helvetica, Arial, sans-serif"
        font-size="46" font-weight="800" letter-spacing="-1.4" fill="${text}">Mail<tspan fill="#10b981">Spy</tspan></text>
</svg>`;
}

writeFileSync(join(here, "mailspy-mark.svg"), markSVG() + "\n");
writeFileSync(join(here, "mailspy-logo.svg"), lockupSVG(false) + "\n");
writeFileSync(join(here, "mailspy-logo-dark.svg"), lockupSVG(true) + "\n");

// ---- rasterize ----
const chrome = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"].find(existsSync);
if (!chrome) { console.error("Install Google Chrome to export PNGs."); process.exit(1); }

const profile = mkdtempSync(join(tmpdir(), "mailspy-brand-"));
function png(out, canvas, art) {
  const pad = (canvas - art) / 2;
  const page = join(profile, "p.html");
  writeFileSync(page, `<!doctype html><html><head><style>html,body{margin:0;background:transparent}
    div{position:absolute;left:${pad}px;top:${pad}px;width:${art}px;height:${art}px}svg{display:block;width:100%;height:100%}</style></head>
    <body><div>${markSVG()}</div></body></html>`);
  spawnSync(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${join(profile, "u")}`,
    "--force-device-scale-factor=1", `--window-size=${canvas},${canvas}`, "--default-background-color=00000000",
    `--screenshot=${out}`, pathToFileURL(page).href], { timeout: 60000 });
  console.log((existsSync(out) ? "wrote " : "FAILED ") + out);
}
try {
  png(join(here, "store-icon-128.png"), 128, 96);          // Web Store: 96px art + 16px margin
  png(join(here, "mailspy-mark-512.png"), 512, 512);
  png(join(root, "extension", "icon128.png"), 128, 96);    // install dialog / extensions page
  png(join(root, "extension", "icon48.png"), 48, 44);
  png(join(root, "extension", "icon16.png"), 16, 16);      // toolbar: full size for legibility
} finally {
  rmSync(profile, { recursive: true, force: true });
}
