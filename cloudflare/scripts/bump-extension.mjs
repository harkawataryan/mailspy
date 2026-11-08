// Runs before every deploy. If any file in ../extension changed since the last
// deploy, bumps the patch version in extension/manifest.json. The Worker serves
// that version at /api/version, and the extension reloads itself when it sees
// a newer one, so the copy loaded in Chrome always matches the files on disk.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extDir = join(here, "..", "..", "extension");
const manifestPath = join(extDir, "manifest.json");
const stampPath = join(here, "..", ".extension-hash");

// Every file in the extension folder, including subfolders (like lib/), as "a/b.js" paths.
function listFiles(dir, prefix = "") {
  return readdirSync(join(dir, prefix), { withFileTypes: true })
    .filter(d => !d.name.startsWith("."))
    .flatMap(d => d.isDirectory() ? listFiles(dir, prefix + d.name + "/") : [prefix + d.name])
    .sort();
}

const files = listFiles(extDir);
const h = createHash("sha256");
for (const f of files) {
  if (f === "manifest.json") {
    // hash the manifest without its version, so bumping doesn't change the hash
    const m = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete m.version;
    h.update(JSON.stringify(m));
  } else {
    h.update(f);
    h.update(readFileSync(join(extDir, f)));
  }
}
const hash = h.digest("hex");
const last = existsSync(stampPath) ? readFileSync(stampPath, "utf8").trim() : "";

if (hash === last) {
  console.log("extension unchanged; version stays", JSON.parse(readFileSync(manifestPath, "utf8")).version);
} else {
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  const parts = m.version.split(".").map(n => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  parts[2] += 1;
  m.version = parts.join(".");
  writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
  writeFileSync(stampPath, hash + "\n");
  console.log("extension changed; version bumped to", m.version, "(Chrome will reload it within 30s of deploy)");
}
