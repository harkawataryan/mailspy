# Running your own copy of MailSpy

Your own MailSpy on your own domain, with your own Cloudflare account, database
and Google sign-in. Nothing is shared with the original: not the data, not the
accounts. You don't need to build or publish an extension either. Install the
published MailSpy extension and point it at your server (step 9).

Everything that names a domain comes from one file, `mailspy.config.json` at the
top of the repo. `npm run configure` (in `cloudflare/`) applies it to the
extension (`extension/site.js` and `manifest.json`) and to
`cloudflare/wrangler.toml`. Deploying and packaging run it for you.

## You need

- **Node.js 22 or newer.**
- **A free Cloudflare account,** with a domain you own added to it. Its DNS has
  to be on Cloudflare (see SETUP.md step 9 for how). You'll use two subdomains:
  one for the dashboard, for example `mailspy.example.com`, and one that appears
  in emails, for example `go.example.com`.
- **A Google account,** for Sign in with Google and the Gmail features
  (optional, but most of the good parts use it).

## Steps

1. **Fork the repo** on GitHub and clone your fork.
2. **Sign in to Cloudflare** from the `cloudflare` folder:

   ```
   npm install
   npx wrangler login
   ```

3. **Create your database and storage:**

   ```
   npx wrangler d1 create mailspy
   npx wrangler kv namespace create DOCS
   ```

   The first prints a `database_id`, the second an `id`.
4. **Edit `mailspy.config.json`** at the top of the repo:

   ```json
   {
     "name": "MailSpy",
     "app": "https://mailspy.example.com",
     "track": "https://go.example.com",
     "home": "https://example.com",
     "extensionStoreUrl": "",
     "cloudflare": { "databaseId": "<database_id>", "kvId": "<kv id>" }
   }
   ```

   - `name`: what the extension is called in Chrome.
   - `app`: the dashboard, sign-in and API.
   - `track`: what your recipients see in links and the tracking image. Keep it
     plain, since it shows up in emails.
   - `home`: where the tracking address's front page links to.
   - `extensionStoreUrl`: leave empty until you publish your own Chrome Web
     Store listing.

   Then run `npm run configure` in `cloudflare/`.
5. **Create the tables:** `npm run db:init`
6. **Deploy:** `npm run deploy`. It applies your config, runs the tests, and
   deploys to your two subdomains.
7. **Set your password and secrets:** `npm run setup`, then sign in at
   `<app>/emailtrack`. That's `LOGIN_PATH` in `wrangler.toml`, which you can
   change.
8. **Sign in with Google and the Gmail features:** follow "Sign in with Google
   and Gmail checkmarks" in [SETUP.md](../SETUP.md), using your own `app`
   address wherever it says `mailspy.aryanh.dev`:
   - the redirect URI is `<app>/auth/google/callback`;
   - the privacy policy is `<app>/privacy`.
9. **Install the extension and point it at your server:**
   1. Install MailSpy from the
      [Chrome Web Store](https://chromewebstore.google.com/detail/mailspy-email-tracking-fo/dofghebhjogkhipgjkhnomhmaiplgdgi).
   2. On its sign-in page, open **Use a different MailSpy server** and enter
      your `app` address, for example `https://mailspy.example.com`.
   3. Sign in with your password, or with Google. With Google, Chrome first asks
      to let MailSpy read your site, so it can pick up the sign-in.

   The extension then talks only to your server, and the setting stays per
   browser. Your friends do the same with your address.

   **If you're changing the extension itself,** load your fork's `extension`
   folder instead. See [Developing the extension](#developing-the-extension).

To share yours with friends:
- Create invites at `<app>/admin`.
- Add their Gmail as test users on your Google consent screen.
- Have them install MailSpy from the Web Store and enter your `app` address as
  their server.

If you change the extension and want those changes in everyone's hands, publish
your own Web Store listing ([chrome-web-store.md](chrome-web-store.md), with
your own extension ID and secrets), or send your changes back as a pull request.

**Only want your own domain in your emails?** You may not need any of this. If
the MailSpy server you use has it switched on, set **Settings → Your tracking
domain** and add one DNS record. See [own-tracking-domain.md](own-tracking-domain.md).

## Getting updates from the original

```
git remote add upstream https://github.com/harkawataryan/mailspy.git
git pull upstream main
npm --prefix cloudflare run configure
```

If the merge conflicts in `mailspy.config.json`, keep yours. Conflicts in
`extension/manifest.json`, `extension/site.js` or `cloudflare/wrangler.toml`
come only from the domain lines: take either side, then run `configure`, which
rewrites them from your config.

## Adding features

The Worker is in `cloudflare/src/` (one file per feature, `index.js` routes
requests), the extension is in `extension/`, and the tests are in
`tests/unit/` (`npm test` in `cloudflare/`). Deploys refuse to go out if a test
fails. See [DEVELOPING.md](../DEVELOPING.md) for how the pieces fit together.

## Developing the extension

Load the extension straight from your clone, and it updates itself every time
you deploy.

**Set up once**
1. Set up your server (steps 1 to 8 above). Your `mailspy.config.json` makes
   the extension in your clone point at your server by default.
2. Go to `chrome://extensions`, turn on **Developer mode**, click **Load
   unpacked** and pick the `extension` folder inside your clone. Use the
   folder, not a zip.
3. Click the MailSpy icon and sign in.

**Each change**
1. Edit files in `extension/` (or the server in `cloudflare/src/`).
2. Run `npm run deploy` in `cloudflare/`.

The deploy does the rest:
- It runs the tests and stops if one fails.
- If the extension changed, it raises the version in your folder.
- It deploys the server, which then reports that new version.

Every 30 seconds the extension asks its server which version is current
(`/api/version`). When the server reports a newer one than the extension that's
running, it reloads itself from your folder. The deploy has already put the new
files there, so you get the new code without doing anything. Open Gmail tabs
get the new scripts too, without a refresh.

**Things to watch for**
- **Edits without a deploy don't reload anything.** While trying things out,
  click the reload icon on the MailSpy card in `chrome://extensions`, then
  refresh Gmail.
- **Sign in to your own server.** The extension compares its version with the
  server it's signed in to. Pointed at someone else's server, it won't reload
  when you deploy.
- **Deploy from the folder Chrome loads.** If you deploy from another computer,
  this folder doesn't get the new files. The extension reloads once, sees it's
  still out of date, and shows a red **NEW** badge instead. Run `git pull` in
  the folder to catch up.
- **Leave the folder where it is.** Chrome loads it from that exact path, so
  moving or deleting the clone breaks the extension.

**Updating your friends too:** for people using your server to get your
extension changes automatically, publish your own Chrome Web Store listing
and set up the publish workflow ([chrome-web-store.md](chrome-web-store.md),
with your own extension ID and secrets). After that, each push to your fork's
`main` that changes `extension/` uploads a new version for Google to review.
