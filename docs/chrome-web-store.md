# Publishing the extension to the Chrome Web Store

Once this is set up, every push to `main` that ships a new extension version is
uploaded and published automatically (`.github/workflows/publish-extension.yml`),
and Chrome updates everyone's copy on its own. Until then, friends use the
download in MailSpy Settings.

The flow after setup: change the extension, `npm run deploy` (bumps the version),
commit, push. The workflow uploads it; it goes live after Google's review, which
is usually under a day for updates.

## 1. One-time: publish it by hand (done)

Already published: <https://chromewebstore.google.com/detail/mailspy-email-tracking-fo/dofghebhjogkhipgjkhnomhmaiplgdgi>
(ID `dofghebhjogkhipgjkhnomhmaiplgdgi`, already saved as the `CWS_EXTENSION_ID` secret). Kept for reference:

1. Make a developer account at <https://chrome.google.com/webstore/devconsole>
   (one-time $5 fee).
2. Build the zip: `npm --prefix cloudflare run package`, which writes
   `dist/mailspy-extension-<version>.zip`.
3. In the dashboard: **New item**, then upload that zip.
4. Fill in the listing:
   - Description, category (Productivity), and the images in `dist/store/`
     (icon, small promo tile, screenshots).
   - **Privacy**: privacy policy URL `https://mailspy.aryanh.dev/privacy`.
     Single purpose: "Track opens and clicks of emails the user sends from Gmail."
     Explain each permission:
     - storage: the sign-in and settings
     - notifications: open alerts
     - alarms: checking for new activity
     - scripting: re-adding the Gmail helpers after an update
     - mail.google.com: works inside Gmail
     - mailspy.aryanh.dev: talks to your MailSpy server

     No remote code. Data is sent to MailSpy only.
   - **Distribution → Visibility: Unlisted**, so only people with the link can
     install it.
5. **Submit for review.** The first review can take a few days.
6. Once it's live, copy its store URL into `EXTENSION_URL` in
   `cloudflare/wrangler.toml` and deploy. Settings then shows an
   **Add to Chrome** button instead of the zip download.

Switching an existing install from the unpacked copy to the store copy: remove
MailSpy in `chrome://extensions`, then install from the store link and sign in
again (it's a different extension ID, so its storage starts empty). You can keep
your own unpacked copy for development instead; it still reloads on every deploy.

## 2. One-time: let GitHub publish updates

1. In the Google Cloud console (any project, the MailSpy one is fine):
   **APIs & Services → Library → Chrome Web Store API → Enable**.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID →
   Desktop app**. Note the client ID and secret.
3. Get a refresh token with that client:
   - Open <https://developers.google.com/oauthplayground>, click the gear icon,
     tick **Use your own OAuth credentials**, and paste the client ID and secret.
   - In step 1, enter the scope `https://www.googleapis.com/auth/chromewebstore`,
     click **Authorize APIs**, and sign in with the account that owns the
     extension.
   - Step 2: **Exchange authorization code for tokens**, then copy the
     **refresh token**.
4. Add the repository secrets (GitHub → repo → Settings → Secrets and variables →
   Actions), or from a terminal in the repo:

   ```bash
   gh secret set CWS_CLIENT_ID
   gh secret set CWS_CLIENT_SECRET
   gh secret set CWS_REFRESH_TOKEN
   ```

5. Test it: GitHub → **Actions → Publish extension → Run workflow**. If the
   store already has the current version, it says so and stops; otherwise it
   uploads and submits it.

Until the four secrets exist, the workflow runs and does nothing.
