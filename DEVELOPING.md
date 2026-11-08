# Developing MailSpy

## Layout
- `cloudflare/` – the Worker: dashboard, tracking, Gmail labels/auto-try (Google API), finder, templates.
  - `src/index.js` routes, `src/views.js` all HTML, `src/tracking.js` opens/clicks/alerts,
    `src/google.js` Google sign-in + Gmail checkmarks, `src/retry.js` auto-try,
    `src/finder.js` email finder, `src/templates.js`, `src/prefs.js` per-user settings.
- `extension/` – the Chrome extension (content scripts run in Gmail).
- `tests/` – `npm test` (unit, fast, no network) and `npm run test:e2e` (local Worker + Python).

## Rules of the road
- **Work on a branch.** `main` is what's deployed. Merge into `main`, then deploy.
- **Only deploy from `main`**, with `npm run deploy` in `cloudflare/` (or the repo root).
  It runs the unit tests first and refuses to deploy if any fail, then bumps the
  extension version if extension files changed. Your installed extension updates itself within ~30s.
- **Database changes never need a manual step.** Add columns/tables lazily in code
  (see `ensureGoogleSchema` in `src/google.js` and `ensureTable` in `src/templates.js`),
  and mirror them in `schema.sql` (+ a `migrations/NNNN_*.sql` file for the record).
- **Tests:** add unit tests in `tests/unit/*.test.mjs` (they get a SQLite stand-in for D1,
  see existing files) and end-to-end tests in `tests/e2e/*.py`.
  Running e2e from more than one place at once? Give each its own port:
  `MAILSPY_TEST_PORT=8790 npm run test:e2e`.
- **Secrets** live in Cloudflare (`npx wrangler secret put …`), never in the repo.
  Local tests write throwaway ones to `cloudflare/.dev.vars` (git-ignored).
- **Never replace `SESSION_SECRET` on a running MailSpy.** It signs sign-ins *and* encrypts every
  user's Gmail access (`src/google.js`); a new one signs everyone out and silently disconnects
  everyone's Gmail checkmarks and auto-try. `npm run set-password` leaves it alone; a full
  `npm run setup` warns first.
- **Backups:** `npm run backup` downloads the live database to `backups/` (git-ignored, private).
  Cloudflare D1 also has point-in-time restore ("Time Travel"):
  `npx wrangler d1 time-travel info mailspy`, then `... restore mailspy --timestamp=<unix>`
  (overwrites the database: back up first).
- **Privacy policy** (`privacyPage` in `src/views.js`) must say what MailSpy does with Gmail
  access. Update it whenever Gmail usage changes (Google requires it).
