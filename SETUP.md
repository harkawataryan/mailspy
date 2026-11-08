# Setup: free on Cloudflare, tracking from Gmail

This runs MailSpy on Cloudflare's free plan and tracks the emails you send
from Gmail in Chrome. You end up with:

- Tracking at **https://mailspy.aryanh.dev**
- Your private dashboard at **https://mailspy.aryanh.dev/emailtrack**
- Desktop notifications when someone opens your email or clicks a link

**Cost: $0. No credit card.** Total time is about 30 minutes, plus some
waiting while your domain moves to Cloudflare.

You'll start on a free `workers.dev` address so you can test right away, then
move to mailspy.aryanh.dev.

Why not aryanh.dev/emailtrack: your portfolio is on GitHub Pages, which only
serves static files and can't record email opens. A subdomain runs on
Cloudflare and leaves your portfolio untouched. To anyone who isn't signed in,
every page except the login page shows a plain "Not Found".

All commands below are for **PowerShell**. Run them in the
`mailspy\cloudflare` folder. The `npm run` commands also work from the main
`mailspy` folder.

---

## 1. Create a free Cloudflare account (2 min)

Sign up at <https://dash.cloudflare.com/sign-up> and confirm your email.
No card is needed.

## 2. Install and sign in (3 min)

```powershell
cd "$HOME\Documents\Claude Projects\mailspy\cloudflare"
```

```powershell
npm install
```

```powershell
npx wrangler login
```

A browser tab opens. Click **Allow**.

## 3. Create the database (2 min)

```powershell
npx wrangler d1 create mailspy
```

It prints a `database_id`. Open `cloudflare\wrangler.toml` and replace
`PASTE_DATABASE_ID_HERE` with it. If Wrangler offers to add the database to
your config for you, that's fine too. Just make sure the file ends up with one
`[[d1_databases]]` block whose `binding` is `"DB"`.

Then create the tables. Answer **Y** if it asks:

```powershell
npm run db:init
```

## 4. Deploy (1 min)

```powershell
npm run deploy
```

The first time, it asks you to pick a `workers.dev` subdomain. It then prints
your address, something like `https://mailspy.yourname.workers.dev`. Keep it.

## 5. Set your password and API key (1 min)

```powershell
npm run setup
```

Pick a dashboard password of 10+ characters. Typing is hidden. When it
finishes it prints an **API key**. Copy it for step 7.

These are stored as encrypted Cloudflare secrets, never in your files.

## 6. Sign in

Open your address with `/emailtrack` on the end, for example
`https://mailspy.yourname.workers.dev/emailtrack`, and sign in.

## 7. Install the Chrome extension (3 min)

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick the `extension` folder inside `mailspy`.
3. Pin the MailSpy icon, click it, then click **Settings**:
   - **Server URL:** your workers.dev address from step 4
   - **API key:** the key from step 5
4. Click **Save** and reload your Gmail tabs.

The dashboard's gear icon shows both values again whenever you need them.

**Updates are automatic.** The extension runs straight from the `extension`
folder, so its files are always the latest. After each `npm run deploy` it
notices the new version within about 30 seconds, reloads itself, and
re-attaches to any Gmail tabs you have open. You never need to click reload
in `chrome://extensions` again.

## 8. Test it

1. In Gmail, send an email with a link in it to **another account you own**,
   like a phone mail app or a second address.
2. It appears on your dashboard as soon as you click Send.
3. Open it on the other account. Within about 30 seconds you get a desktop
   notification, and the dashboard shows the open. Click the link to see a
   click recorded too.

Two things are deliberately **not** counted:
- You opening your own sent message in Gmail. The extension recognizes it.
- Anything in the first 12 seconds after sending. That's your own compose
  window, Apple Mail fetching on delivery, and link scanners.

### Scheduled sends

Gmail's own **Schedule send** works with tracking. Click the small arrow next
to Send, choose **Schedule send**, and pick a time as usual. The extension adds
the tracking before Gmail stores the message, and the dashboard shows the email
as **Scheduled** with the send time until it goes out.

---

## 9. Move to mailspy.aryanh.dev (15 min of clicking, then waiting)

Do this before using MailSpy for real outreach. Spam filters trust
`workers.dev` links less, because scammers use them a lot.

This moves aryanh.dev's **DNS** to Cloudflare. Your domain stays registered
at Porkbun, and DNS on Cloudflare is free.

### a. Add the domain to Cloudflare

Cloudflare dashboard → **Add a domain** → `aryanh.dev` → choose the **Free** plan.

### b. Check the imported records

Cloudflare copies your current records. Make sure these are there, and add
any that are missing:

| Type | Name | Content |
|---|---|---|
| A | `aryanh.dev` | `185.199.108.153` |
| A | `aryanh.dev` | `185.199.109.153` |
| A | `aryanh.dev` | `185.199.110.153` |
| A | `aryanh.dev` | `185.199.111.153` |
| CNAME | `www` | `harkawataryan.github.io` |

Click each of these and set **Proxy status** to **DNS only** (grey cloud).
That lets GitHub Pages keep handling your portfolio's HTTPS as it does today.
Keep any other records Cloudflare imported, such as MX or TXT.

### c. Switch nameservers at Porkbun

1. Porkbun → **Domain Management** → aryanh.dev.
2. If **DNSSEC** is on, turn it off first. Leaving it on can take the domain
   offline during the switch.
3. Under **Authoritative Nameservers**, replace Porkbun's nameservers with the
   two Cloudflare showed you, and save.

### d. Wait for "Active"

Cloudflare emails you when aryanh.dev is active. It's usually under an hour
but can take up to a day. Check that your portfolio still loads.

### e. Turn on mailspy.aryanh.dev

In `cloudflare\wrangler.toml`, remove the `#` at the start of this line:

```toml
# routes = [ { pattern = "mailspy.aryanh.dev", custom_domain = true } ]
```

Then deploy:

```powershell
npm run deploy
```

Cloudflare creates the `mailspy` DNS record and its HTTPS certificate for you.

### f. Switch the extension over

- Extension **Settings** → Server URL: `https://mailspy.aryanh.dev`
- Sign in again at **https://mailspy.aryanh.dev/emailtrack**. Sign-ins don't
  carry over between addresses.

Emails you already sent with the workers.dev address keep tracking, as long as
`workers_dev = true` stays in `wrangler.toml`.

---

## Sharing with friends

MailSpy supports accounts. Each person signs up with an invite link and sees
only their own emails.

**1. Claim your owner account (once).** Open
`https://mailspy.aryanh.dev/emailtrack`. Enter your email, a name, and the
password you set with `npm run setup`. This keeps everything you tracked
before. From then on you sign in with that email and the same password.

**2. Publish the extension to the Chrome Web Store as Unlisted.**
Everything to paste is in [STORE_LISTING.md](STORE_LISTING.md).

```powershell
npm run package
```

1. Go to the Chrome Web Store Developer Dashboard and pay the one-time $5 fee.
2. **New item** → upload `dist\mailspy-extension-<version>.zip`.
3. Fill in the listing, privacy and distribution tabs from STORE_LISTING.md.
   Set visibility to **Unlisted**, then submit for review. Approval usually
   takes a few days.
4. Once approved, put the store link in `cloudflare\wrangler.toml` as
   `EXTENSION_URL` and run `npm run deploy`. Friends then get an
   **Add to Chrome** button on their dashboard.
5. Install the store version yourself and **remove the unpacked copy** in
   `chrome://extensions`. With both on, emails are tracked twice.

**3. Invite someone.** Dashboard → **Friends** → **Create invite link**, and
send them the link. Each link works once. They create an account, install
the extension, click its icon, and sign in. That's it.

**Managing people.** The Friends page shows everyone, their invite status and
email counts. **Reset password** gives them a temporary password to send
privately. **Remove** deletes the account and all of their tracking data.

**Optional:** set `CONTACT_EMAIL` in `wrangler.toml` so the privacy policy
shows an address for questions. Without it, it tells people to contact
whoever invited them.

## Sign in with Google and Gmail checkmarks (one time, about 10 minutes)

With this, people can sign up and sign in with their Google account, and MailSpy
marks each tracked email in their Gmail Sent folder with **✔** (sent) and **✔✔**
(opened), the same labels Mailsuite uses. It needs a free Google Cloud "OAuth
client" that belongs to you. Until it's set up, the Google buttons stay hidden
and everything else works as before.

1. Go to <https://console.cloud.google.com/projectcreate>, name the project
   **MailSpy**, and create it. Make sure it's selected in the top bar.
2. Turn on the Gmail API:
   <https://console.cloud.google.com/apis/library/gmail.googleapis.com> → **Enable**.
3. Open **Google Auth Platform** (<https://console.cloud.google.com/auth/overview>) → **Get started**:
   - App name **MailSpy**, user support email: yours.
   - Audience: **External**.
   - Contact email: yours. Agree and **Create**.
4. **Branding**: app home page `https://mailspy.aryanh.dev`, privacy policy
   `https://mailspy.aryanh.dev/privacy`, authorized domain `aryanh.dev`. Save.
5. **Data access** → **Add or remove scopes**: tick `.../auth/userinfo.email`,
   `.../auth/userinfo.profile`, `openid`, and paste
   `https://www.googleapis.com/auth/gmail.modify` under "Manually add scopes".
   Update, then Save.
6. **Audience** → **Publish app** → Confirm. (Left in "Testing", Google signs
   everyone out of Gmail access every 7 days.) The app stays *unverified*:
   people see "Google hasn't verified this app" and continue with
   **Advanced → Go to MailSpy**. That's fine for up to 100 people.
7. **Clients** → **Create client** → type **Web application**, name MailSpy,
   **Authorized redirect URIs** → add `https://mailspy.aryanh.dev/auth/google/callback`
   → Create. Copy the **Client ID** and **Client secret**.
8. In the `cloudflare` folder:

   ```
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```

   (paste each when asked). The Google buttons appear right away.

Then, signed in to MailSpy, open **Settings → Gmail checkmarks → Connect Gmail**
(or just sign in with Google). Emails you send from then on get the checkmarks.

## Free plan limits

Cloudflare's free plan allows about **100,000 requests a day** and caps
daily database reads and writes. Each open or click is one request. A browser
with the extension checks for alerts twice a minute, which is about 2,900
requests a day. Personal email volume won't come close.

If a daily cap is ever hit, tracking pauses until midnight UTC. Nothing is
charged, because the free plan has no billing attached.

## Troubleshooting

- **`npm run setup` fails.** Run `npx wrangler login`, then `npm run deploy`,
  then try again. The Worker has to exist before it can hold secrets.
- **Login page says sign-in is turned off.** Run `npm run setup`.
- **Every page says "Not Found".** You aren't signed in. Go to `/emailtrack`.
- **Email never appears on the dashboard after Send.** Check the extension's
  Server URL and API key. In Gmail, press F12 and look in the Console for lines
  starting with `MailSpy:`. Gmail changes its page markup now and then. If the
  Send hook stops working, your email still goes out, just untracked.
- **Email appears but opens never register.** Check the pixel answers:

  ```powershell
  curl.exe -I https://mailspy.aryanh.dev/t/test.gif
  ```

  You should see `200` and `image/gif`.
- **Some recipients never show opens.** Their mail app blocks images, which is
  common in Outlook desktop and company mail. Link clicks still register.
- **Locked out after typos.** Ten wrong passwords from one network blocks it
  for 15 minutes.
- **Forgot your password.** Run `npm run set-password`. This signs out every
  session but keeps your API key.

## Day-to-day

Watch live logs:

```powershell
npm run logs
```

Change a setting: edit the `[vars]` section of `wrangler.toml`, then run
`npm run deploy`.

Back up your data:

```powershell
npx wrangler d1 export mailspy --remote --output=mailspy-backup.sql
```

Running `npm run setup` again makes a **new API key**. You'd then have to paste
it into the extension again. To change only the password, use
`npm run set-password`.

## Not in the free version

MailSpy tracks; it doesn't compose or send email itself. There's no sending
from the dashboard, no mail-merge campaigns and no email alerts. You send
from Gmail, so you don't need them. To send later, use Gmail's own Schedule
send or MailSpy's Send later (it sends your Gmail drafts at the time you pick). The dashboard's **Tracked HTML** page can still make tracked HTML to
paste into other mail apps.
