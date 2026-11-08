// Unit tests: fast, no network, no server. Runs every tests/unit/*.test.mjs
// with Node's built-in SQLite standing in for Cloudflare D1, and fake Google/Gmail.
//   npm test
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "unit");
let failed = 0;
for (const f of readdirSync(dir).filter(f => f.endsWith(".test.mjs")).sort()) {
  console.log(`\n=== ${f} ===`);
  const r = spawnSync(process.execPath, ["--experimental-sqlite", "--no-warnings", join(dir, f)], { stdio: "inherit" });
  if (r.status !== 0) { failed++; console.log(`>>> ${f} FAILED`); }
}
console.log(failed ? `\n${failed} unit test file(s) failed` : "\nall unit tests passed");
process.exit(failed ? 1 : 0);
