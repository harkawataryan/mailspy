// Zips the extension folder for friends to download from MailSpy (/extension.zip).
// Called by bump-extension.mjs before every deploy; the Worker bundles the file
// (wrangler.toml [[rules]] Data) and serves it to signed-in users.
// Files go inside a "mailspy-extension/" folder, so unzipping gives one folder
// to pick in chrome://extensions -> Load unpacked.

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync, crc32 } from "node:zlib";

function listFiles(dir, prefix = "") {
  return readdirSync(join(dir, prefix), { withFileTypes: true })
    .filter(d => !d.name.startsWith("."))
    .flatMap(d => d.isDirectory() ? listFiles(dir, prefix + d.name + "/") : [prefix + d.name])
    .sort();
}

export function zipFolder(dir, top = "") {
  const files = listFiles(dir);
  const local = [], central = [];
  let offset = 0;
  const dosTime = 0, dosDate = (2026 - 1980) << 9 | 1 << 5 | 1;   // fixed date: same files, same zip
  for (const name of files) {
    const data = readFileSync(join(dir, name));
    const comp = deflateRawSync(data, { level: 9 });
    const crc = crc32(data) >>> 0;
    const nameBuf = Buffer.from(top + name, "utf8");
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
  return { zip: Buffer.concat([...local, cd, end]), files: files.length };
}

export function writeExtensionZip(extDir, buildDir) {
  mkdirSync(buildDir, { recursive: true });
  const { zip, files } = zipFolder(extDir, "mailspy-extension/");
  writeFileSync(join(buildDir, "extension.zip"), zip);
  return { bytes: zip.length, files };
}
