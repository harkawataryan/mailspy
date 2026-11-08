# MailSpy: email open and click tracking you own

A Mailsuite / Mailtrack style tracker. Every email you send gets an invisible
1x1 image and tracked links, so you can see **when** someone opened it, **how
many times**, **roughly where**, **on what client**, and **which links they
clicked**. It has a live "Latest Activity" feed, desktop notifications, and a
Gmail extension.

It runs on Cloudflare's free plan (Workers + D1), in `cloudflare/`. No credit
card, no server to keep running.

**Setting it up: follow [SETUP.md](SETUP.md).** To run your own copy on your
own domain, see [docs/run-your-own-copy.md](docs/run-your-own-copy.md): every
domain comes from one file, `mailspy.config.json`.

## What it does

**Tracking**
- Invisible open pixel + per-link click tracking, added as you click Send.
- **False-open prevention.** These are shown but **not counted**:
  - Anything in the first seconds after sending: your own compose window,
    Apple Mail fetching on delivery, link scanners.
  - Security scanners recognized by user agent, and any "clicks" on several
    links within 2 seconds, which is how scanners behave.
  - You viewing your own sent message or draft in Gmail. The extension reports it.
  - Hits from IPs you've told it to ignore.

  Gmail, Yahoo and Outlook.com load images through their own proxy servers
  when the recipient opens the message, so those **are** counted as opens.
- Per-recipient tracking: each recipient gets their own tracked copy, so you
  know exactly who opened.

**Dashboard (Mailsuite-style)**
- Live "Latest Activity" feed: "Jane opened your email · 2m ago · London".
- Real-time desktop/browser notifications, no refresh needed.
- Per-email timeline with every open/click, client, location and IP.
- **Alerts**: first open, reopen, **open spike** (many opens fast = hot lead),
  **email revival** (an old email reopened), and **follow-up reminders** (not
  opened within a set time).
- Accounts for friends (invite links; each person sees only their own).
- **Send later**: queue Gmail drafts to go out at a set time, and edit them
  before they do.

**Integration**
- JSON API (`/api/prepare`, `/api/activity`, `/api/alerts`), protected by the
  `X-API-Key` header.
- Chrome extension that hooks Gmail's Send button (see `extension/`).

The tracking address has to be reachable from the internet, because your
recipients' mail apps fetch the image and follow the links from there.

## The Chrome extension

Loads your tracking into Gmail's web UI.

1. Install it from the [Chrome Web Store](https://chromewebstore.google.com/detail/mailspy-email-tracking-fo/dofghebhjogkhipgjkhnomhmaiplgdgi).
   (For development: `chrome://extensions` → enable **Developer mode** →
   **Load unpacked** → select the `extension/` folder.)
2. Click the MailSpy icon and sign in with your MailSpy account. If you run
   your own copy, first open **Use a different MailSpy server** on the sign-in
   page and enter your server's address.
3. Compose in Gmail and hit Send. The extension registers the email with your
   server and injects the pixel + tracked links before it leaves. The popup
   shows your live activity feed; desktop notifications fire on each open.

Gmail's internal HTML is not a public API, so the content-script selectors are
best-effort and may need a tweak if Google changes their markup. If tracking
ever fails it falls back to sending the email untracked rather than blocking it.

## JSON API

All of these take the `X-API-Key` header (the key is on the dashboard's
Settings page).

```bash
KEY=your_api_key
BASE=https://mailspy.yourdomain.com

# Prepare tracked HTML without sending
curl -X POST $BASE/api/prepare -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"to":"a@b.com","subject":"Hi","text":"See https://example.com"}'

curl "$BASE/api/activity?key=$KEY"   # live feed
curl "$BASE/api/alerts?key=$KEY"     # alerts
```

## How it works

- **Open**: an `<img>` pointing at `BASE/img/<token>.gif` is appended to the
  body; the fetch is logged with time, IP, user agent and location. Caching
  headers force a fresh request so reopens are counted.
- **Click**: each tracked `<a href>` is rewritten to a short `BASE/<code>` link,
  logged, then redirected to the real URL. `mailto:`/`tel:` are left alone.
- Data lives in Cloudflare D1 (`cloudflare/schema.sql`).

## Known limits (true of Mailsuite too)

- **Images off = no open recorded.** Outlook desktop and many corporate clients
  block remote images by default. Clicks still work.
- **Gmail** fetches the pixel through its proxy, so the open's IP is Google's,
  not the recipient's. The event is still counted; the client shows as "Gmail".
- **Apple Mail Privacy Protection** can load images on delivery. Hits in the
  first seconds after sending are excluded, but a later automatic load can
  still look like an open. Treat a single Apple Mail open with some caution.

## A note on consent

Open/click tracking is standard in sales and marketing email, but recipients
generally can't see it. Some places (e.g. the EU/UK under GDPR/PECR) treat
tracking pixels as requiring a lawful basis or disclosure, and bulk sending must
follow anti-spam law (CAN-SPAM, CASL) — a real sender address, a working
unsubscribe for marketing mail, no deception. Use this for your own legitimate
correspondence and outreach, and check what applies where your recipients are.
