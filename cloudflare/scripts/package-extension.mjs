// Builds the Chrome Web Store upload: dist/mailspy-extension-<version>.zip
// containing the extension folder's files at the top level of the zip.
//
//   npm run package

import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, crc32 } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const extDir = join(here, "..", "..", "extension");
const distDir = join(here, "..", "..", "dist");
const manifest = JSON.parse(readFileSync(join(extDir, "manifest.json"), "utf8"));

// Store-only sanity checks, so the upload isn't rejected for something silly.
const problems = [];
for (const h of manifest.host_permissions || []) {
  if (/localhost|127\.0\.0\.1|^https?:\/\/\*\//.test(h)) problems.push(`host permission too broad for the store: ${h}`);
}
for (const size of ["16", "48", "128"]) {
  if (!manifest.icons?.[size]) problems.push(`missing ${size}px icon`);
}
if (problems.length) {
  console.error("Not packaging:\n  " + problems.join("\n  "));
  process.exit(1);
}

// Every file in the extension folder, including subfolders (like lib/), as "a/b.js" paths.
function listFiles(dir, prefix = "") {
  return readdirSync(join(dir, prefix), { withFileTypes: true })
    .filter(d => !d.name.startsWith("."))
    .flatMap(d => d.isDirectory() ? listFiles(dir, prefix + d.name + "/") : [prefix + d.name])
    .sort();
}

const files = listFiles(extDir);

// Minimal ZIP writer (deflate). Paths use forward slashes, as zip requires.
const local = [], central = [];
let offset = 0;
const dosTime = 0, dosDate = (2026 - 1980) << 9 | 1 << 5 | 1; // fixed date: reproducible zips
for (const name of files) {
  const data = readFileSync(join(extDir, name));
  const comp = deflateRawSync(data, { level: 9 });
  const crc = crc32(data) >>> 0;
  const nameBuf = Buffer.from(name, "utf8");
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(8, 8);
  lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
  local.push(lh, nameBuf, comp);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(8, 10);
  ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20);
  ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
  central.push(ch, nameBuf);
  offset += lh.length + nameBuf.length + comp.length;
}
const cd = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);

mkdirSync(distDir, { recursive: true });
const out = join(distDir, `mailspy-extension-${manifest.version}.zip`);
writeFileSync(out, Buffer.concat([...local, cd, end]));
console.log(`Packaged ${files.length} files (version ${manifest.version}):\n  ${out}`);
