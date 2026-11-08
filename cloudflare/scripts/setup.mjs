// Uploads the Worker's secrets to Cloudflare: your dashboard password, a
// session-signing secret and (first time) the API key for the Chrome extension.
//
//   npm run setup          new API key + password  (first time)
//   npm run set-password   change only the password (signs out every session)
//
// Secrets go straight to Cloudflare's encrypted secret store. The temporary
// file used for the upload is deleted immediately.

import { randomBytes, pbkdf2Sync } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import readline from "node:readline";

// Kept modest so a sign-in fits inside the free plan's per-request CPU budget.
const ITERATIONS = 5000;
const passwordOnly = process.argv.includes("--password-only");

function askHidden(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = s => { if (!muted) rl.output.write(s); };
    rl.question(question, answer => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    muted = true;
  });
}

const pw = await askHidden("Dashboard password (10+ characters, typing is hidden): ");
if (pw.length < 10) {
  console.error("Use at least 10 characters.");
  process.exit(1);
}
if ((await askHidden("Repeat it: ")) !== pw) {
  console.error("Passwords did not match.");
  process.exit(1);
}

// SESSION_SECRET signs everyone's sign-in AND is the key that encrypts each
// user's Gmail access (src/google.js). Replacing it signs everyone out and
// silently disconnects Gmail checkmarks / auto-try for everyone, so it is only
// created by a full setup (after a warning), never by --password-only.
if (!passwordOnly) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ok = await new Promise(r => rl.question(
    "\nThis also creates a NEW session secret and API key. On a MailSpy that's already running, that signs\n" +
    "everyone out and disconnects everyone's Gmail (they'd have to reconnect). To change only your\n" +
    "password, run `npm run set-password` instead.\nContinue? (y/N) ",
    a => { rl.close(); r(/^y(es)?$/i.test(a.trim())); }));
  if (!ok) { console.log("Nothing changed."); process.exit(0); }
}

const salt = randomBytes(16);
const hash = pbkdf2Sync(pw, salt, ITERATIONS, 32, "sha256");
const secrets = {
  PASSWORD_HASH: `pbkdf2_sha256$${ITERATIONS}$${salt.toString("base64")}$${hash.toString("base64")}`,
};
let apiKey = "";
if (!passwordOnly) {
  secrets.SESSION_SECRET = randomBytes(32).toString("base64url");
  apiKey = randomBytes(24).toString("base64url");
  secrets.API_KEY = apiKey;
}

const file = join(tmpdir(), `mailspy-secrets-${process.pid}.json`);
writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
let status = 1;
try {
  status = spawnSync(`npx wrangler secret bulk "${file}"`, { stdio: "inherit", shell: true }).status;
} finally {
  unlinkSync(file);
}
if (status !== 0) {
  console.error("\nUploading secrets failed. Run `npx wrangler login` and `npm run deploy` first, then try again.");
  process.exit(1);
}

console.log("\nSecrets saved to Cloudflare.");
if (apiKey) {
  console.log(`\nAPI key for the Chrome extension:\n\n  ${apiKey}\n`);
  console.log("You can also copy it later from the Settings page of your dashboard.");
}
