// Writes throwaway TEST secrets for local `wrangler dev` into the given folder.
const { randomBytes, pbkdf2Sync } = require("crypto");
const path = require("path");
const fs = require("fs");
const dir = process.argv[2];
const salt = randomBytes(16);
const hash = pbkdf2Sync("correct-horse-battery", salt, 5000, 32, "sha256");
const content =
  'API_KEY="test-api-key-123"\n' +
  'SESSION_SECRET="test-session-secret-abcdefghijklmnop"\n' +
  `PASSWORD_HASH="pbkdf2_sha256$5000$${salt.toString("base64")}$${hash.toString("base64")}"\n`;
fs.writeFileSync(path.join(dir, ".dev.vars"), content);
console.log("test .dev.vars written");
