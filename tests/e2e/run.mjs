// End-to-end tests: each Python file runs against a fresh local Worker
// (`wrangler dev`, local D1, throwaway test secrets), one at a time.
//
//   npm run test:e2e              all of them
//   npm run test:e2e -- labels    just tests/e2e/labels.py
//
// Needs Python 3 on PATH. find.py makes real lookups (Wikidata, GitHub,
// Gravatar), so it needs internet and can be slow or flaky.

import { spawn, spawnSync } from "node:child_process";
import { readdirSync, rmSync, appendFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cf = join(here, "..", "..", "cloudflare");
const only = process.argv.slice(2);
const files = readdirSync(here).filter(f => f.endsWith(".py") && (!only.length || only.some(o => f.startsWith(o)))).sort();
const isWin = process.platform === "win32";
const npx = isWin ? "npx.cmd" : "npx";
const py = isWin ? "python" : "python3";
// Separate sessions can run these at the same time on different ports: MAILSPY_TEST_PORT=8790
const PORT = process.env.MAILSPY_TEST_PORT || "8787";

function cleanup() {
  rmSync(join(cf, ".wrangler"), { recursive: true, force: true });
  rmSync(join(cf, ".dev.vars"), { force: true });
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (isWin) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}

async function startWorker() {
  const child = spawn(npx, ["wrangler", "dev", "--local", "--port", PORT, "--test-scheduled", "--ip", "127.0.0.1"],
    { cwd: cf, shell: isWin, detached: !isWin, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("wrangler dev didn't start:\n" + log.slice(-2000))), 90000);
    const on = d => { log += d; if (/Ready on/.test(log)) { clearTimeout(timer); resolve(); } };
    child.stdout.on("data", on); child.stderr.on("data", on);
    child.on("exit", () => { clearTimeout(timer); reject(new Error("wrangler dev exited:\n" + log.slice(-2000))); });
  });
  return child;
}

let failed = 0;
for (const f of files) {
  cleanup();
  const init = spawnSync(npx, ["wrangler", "d1", "execute", "mailspy", "--local", "--file=schema.sql"], { cwd: cf, shell: isWin, encoding: "utf8" });
  if (init.status !== 0) { console.error(init.stdout, init.stderr); process.exit(1); }
  spawnSync(process.execPath, [join(here, "make_dev_vars.cjs"), cf], { stdio: "ignore" });
  // Google sign-in is "configured" with fake values so its pages can be tested.
  appendFileSync(join(cf, ".dev.vars"), 'GOOGLE_CLIENT_ID="cid.apps.googleusercontent.com"\nGOOGLE_CLIENT_SECRET="csecret"\n');
  let worker;
  try {
    worker = await startWorker();
    console.log(`\n=== ${f} ===`);
    const r = spawnSync(py, [join(here, f), cf], { stdio: "inherit", env: { ...process.env, MAILSPY_TEST_PORT: PORT } });
    if (r.status !== 0) { failed++; console.log(`>>> ${f} FAILED`); }
  } catch (e) {
    failed++; console.error(e.message);
  } finally {
    killTree(worker);
    await new Promise(r => setTimeout(r, 1500));
    cleanup();
  }
}
console.log(failed ? `\n${failed} e2e file(s) failed` : "\nall e2e files passed");
process.exit(failed ? 1 : 0);
