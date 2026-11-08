# Chrome Web Store submission: copy and paste

Everything the Chrome Web Store Developer Dashboard asks for, in the order it
asks. The files referenced are in the `dist` folder.

---

## Package

Upload: `dist/mailspy-extension-<version>.zip` (make it with `npm run package`)

## Store listing tab

**Title** (comes from the extension): MailSpy: Email Tracking for Gmail

**Summary** (from the extension, 132 characters max):
> See when your Gmail emails are opened and links are clicked. Private, invite-only email tracking.

**Description:**

```
Know the moment your email is opened.

MailSpy tracks the emails you send from Gmail. See who opened them, when, how often, and which links they clicked.

• Desktop alerts the moment an email is opened
• Works with Gmail's Schedule send
• Follow-up reminders for unopened emails
• Tracked PDFs: see who opened an attachment and how long they spent on each page
• Tracked links you can share anywhere
• Only real opens count: your own views and security scanners are filtered out

Invite-only: you need an invite link to create an account, and each person sees only their own emails. MailSpy doesn't read your inbox or store your emails' text.

Privacy policy: https://mailspy.aryanh.dev/privacy
```

**Category:** Productivity → Workflow & Planning (or "Productivity" if that's the only option)

**Language:** English

**Store icon (128×128):** `brand/store-icon-128.png`

**Screenshots (1280×800), upload in this order:**
1. `dist/store/screenshot-1-dashboard.png`: "Know the moment they open it."
2. `dist/store/screenshot-2-timeline.png`: "Every open and click, in order."
3. `dist/store/screenshot-3-notifications.png`: "Get notified as it happens."
4. `dist/store/screenshot-4-scheduled.png`: "Schedule it. Still track it."
5. `dist/store/screenshot-5-real-opens.png`: "Only real opens count."

**Small promo tile (440×280):** `dist/store/promo-small-440x280.png`

**Official URL / Homepage URL:** `https://mailspy.aryanh.dev/privacy`

**Support URL:** leave blank, or your portfolio `https://aryanh.dev`

---

## Privacy practices tab

**Single purpose description:**
> Tracks when emails the user sends from Gmail are opened and when links in them are clicked, and shows that activity to the sender.

**Permission justifications:**

| Permission | Justification |
|---|---|
| storage | Stores the user's sign-in (an API key, email and name) and which notifications were already shown. |
| notifications | Shows a desktop notification when a recipient opens a tracked email or clicks a link in it. |
| alarms | Checks for new opens and clicks every 30 seconds so notifications arrive promptly. |
| scripting | After the extension updates, re-attaches its Gmail script to Gmail tabs that are already open, so tracking keeps working without the user reloading Gmail. |
| Host permission `https://mail.google.com/*` | Adds tracking to an email when the user clicks Send or Schedule send in Gmail, and recognizes the user's own views of their sent emails so they aren't counted as opens. |
| Host permission `https://mailspy.aryanh.dev/*` | The MailSpy service that records opens and clicks and returns the user's activity. |

**Are you using remote code?** No. All JavaScript is included in the package.

**Data usage.** Tick these:
- **Personally identifiable information**: the user's email address and name (for their account), and recipients' email addresses and names as entered in Gmail.
- **Authentication information**: the user's password is sent once over HTTPS to sign in; the extension stores only an API key.
- **Personal communications**: when the user clicks Send, the email's content is sent to MailSpy so its links can be rewritten. It isn't stored, but sending it off the device counts as collecting it.
- **Location**: approximate city/country of recipients, derived from IP address when an email is opened.
- **Website content**: the links in emails the user sends with tracking.

Leave unticked: health, financial, web history, user activity.

**Certify all three statements:**
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** `https://mailspy.aryanh.dev/privacy`

---

## Distribution tab

**Visibility:** **Unlisted** (only people with the link can find it)

**Regions:** All regions

**Pricing:** Free

---

## After it's approved

1. Copy the store link (looks like `https://chromewebstore.google.com/detail/…/<id>`).
2. Put it in `cloudflare/wrangler.toml` as `EXTENSION_URL = "…"` and run `npm run deploy`.
   Friends then see an **Add to Chrome** button on their dashboard.
3. Install the store version yourself, then **remove the unpacked copy** in
   `chrome://extensions`. If both are on, every email gets tracked twice.

## Publishing an update later

1. `npm run deploy` (server, and bumps the version if extension files changed)
2. `npm run package`
3. Developer Dashboard → your item → **Package** → **Upload new package** → submit for review.

Friends' Chrome picks up the update automatically once Google approves it,
usually within a day.
