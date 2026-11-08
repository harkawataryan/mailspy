// Download a full copy of the live database to <repo>/backups/mailspy-YYYY-MM-DD.sql
//   npm run backup
// Read-only: it exports and never changes anything. The backups folder is
// git-ignored because it holds everyone's tracking data; keep it private.
//
// Cloudflare also keeps point-in-time restore for D1 ("Time Travel"):
//   npx wrangler d1 time-travel info mailspy
//   npx wrangler d1 time-travel restore mailspy --timestamp=<unix time>
// A restore overwrites the database in place, so take a backup first.
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const cfDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(cfDir, "..", "backups");
mkdirSync(dir, { recursive: true });
const out = join(dir, `mailspy-${new Date().toISOString().slice(0, 10)}.sql`);
const r = spawnSync(`npx wrangler d1 export mailspy --remote --output "${out}"`, { stdio: "inherit", shell: true, cwd: cfDir });
if (r.status !== 0) { console.error("Backup failed."); process.exit(1); }
console.log(`\nSaved ${out}`);
