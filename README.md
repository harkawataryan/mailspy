# MailSpy: email open and click tracking you own

A Mailsuite / Mailtrack style tracker. Every email you send gets an invisible
1x1 image and tracked links, so you can see **when** someone opened it, **how
many times**, **roughly where**, **on what client**, and **which links they
clicked**. It has a live "Latest Activity" feed, desktop notifications, and a
Gmail extension.

## Two ways to run it

| | Cloudflare version (recommended) | Self-hosted Python server |
|---|---|---|
| Folder | `cloudflare/` | `tracker.py`, `deploy/` |
| Cost | Free, no credit card | Needs an always-on server |
| Gmail extension, private dashboard, open/click tracking, alerts, reports | Yes | Yes |
| Accounts for friends (invite links, each person sees only their own) | Yes | No |
| Scheduled sends, tracked | Yes, through Gmail's Schedule send | Yes, from the dashboard |
| Send from the dashboard, mail-merge campaigns, email alerts | No | Yes |

**Setting up the free Cloudflare version: follow [SETUP.md](SETUP.md).**

To try the Python server on your own machine:

```bash
python tracker.py set-password
python tracker.py
```

Sign in at <http://localhost:8025/emailtrack>. Anyone who isn't signed in gets a
plain "Not Found" on every page except that login path and the tracking URLs.

## What it does

**Tracking**
- Invisible open pixel + per-link click tracking, injected automatically.
- **False-open prevention.** These are shown but **not counted**:
  - Anything in the first `prefetch_window` seconds after sending: your own
    compose window, Apple Mail fetching on delivery, link scanners.
  - Security scanners recognized by user agent, and any "clicks" on several
    links within 2 seconds, which is how scanners behave.
  - You viewing your own sent message in Gmail. The extension reports it.
  - Hits from IPs in `ignore_ips`.

  Gmail, Yahoo and Outlook.com load images through their own proxy servers
  when the recipient opens the message, so those **are** counted as opens.
- Per-recipient tracking: group sends and campaigns get one tracked copy each,
  so you know exactly who opened.
- Optional GeoIP (country/city) per event.

**Dashboard (Mailsuite-style)**
- Live "Latest Activity" feed: "Jane opened your email · 2m ago · London".
- Real-time desktop/browser notifications via a Server-Sent Events stream — no
  refresh needed.
- Per-email timeline with every open/click, client, location and IP.
- **Alerts**: first open, reopen, **open spike** (many opens fast = hot lead),
  **email revival** (an old email reopened), and **follow-up reminders** (not
  opened within `followup_hours`).
- Weekly activity report with open rate and most-opened emails.

**Sending**
- Compose and send through any SMTP server (Gmail App Password works).
- **Schedule** a send for later (`+2h` or `2026-11-08 09:00`).
- **Campaigns / mail merge**: paste CSV with an `email` column, use
  `{{name}}`, `{{company}}` placeholders, send one tracked copy per recipient.
- Or "Generate tracked HTML only" to paste into another client.

**Integration**
- JSON API (`/api/prepare`, `/api/send`, `/api/activity`, `/api/alerts`),
  protected by the `X-API-Key` header.
- Chrome extension that hooks Gmail's Send button (see `extension/`).

## Which deployment?

The tracking address has to be reachable from the internet, because your
recipients' mail apps fetch the image and follow the links from there. A
`localhost` address only works for testing.

- **Cloudflare (free):** see [SETUP.md](SETUP.md). Runs on Cloudflare's free
  plan at a subdomain of your own domain.
- **Your own copy on your own domain:** see [docs/run-your-own-copy.md](docs/run-your-own-copy.md).
  Every domain comes from one file, `mailspy.config.json`.
- **Your own server (Python):** `sudo bash deploy/install.sh track.yourdomain.com`
  on a fresh Ubuntu server installs MailSpy behind Caddy with automatic HTTPS.
  Then run `set-password` as the installer tells you.

Either way, the **Chrome extension** is what tracks mail you send from Gmail
in the browser. It adds the tracking as you click Send.

## The Chrome extension

Loads your tracking into Gmail's web UI.

1. Install it from the [Chrome Web Store](https://chromewebstore.google.com/detail/mailspy-email-tracking-fo/dofghebhjogkhipgjkhnomhmaiplgdgi).
   (For development: `chrome://extensions` → enable **Developer mode** →
   **Load unpacked** → select the `extension/` folder.)
2. Click the MailSpy icon → **Settings** → paste your **server URL** and the
   **API key**. Both are shown on the dashboard's Settings page.
3. Compose in Gmail and hit Send. The extension registers the email with your
   server and injects the pixel + tracked links before it leaves. The popup
   shows your live activity feed; desktop notifications fire on each open.

Gmail's internal HTML is not a public API, so the content-script selectors are
best-effort and may need a tweak if Google changes their markup. If tracking
ever fails it falls back to sending the email untracked rather than blocking it.

## Configure the Python server (`config.json`)

The Cloudflare version is configured in `cloudflare/wrangler.toml` instead.
See [SETUP.md](SETUP.md).

```json
{
  "port": 8025,
  "base_url": "https://img.yourdomain.com",
  "smtp_host": "smtp.gmail.com",
  "smtp_port": 587,
  "smtp_user": "you@gmail.com",
  "smtp_pass": "xxxx xxxx xxxx xxxx",
  "from_name": "Your Name",
  "from_email": "you@gmail.com",
  "ignore_ips": "",
  "prefetch_window": 12,
  "spike_count": 3,
  "spike_window": 600,
  "revival_days": 7,
  "followup_hours": 48,
  "email_alerts": "",
  "api_key": "",
  "geoip": false
}
```

Every key can also be set with an env var, e.g. `MAILSPY_BASE_URL=...`.

- **Gmail**: enable 2-step verification, create an
  [App Password](https://myaccount.google.com/apppasswords), use it as
  `smtp_pass`. Your normal password will not work.
- **`email_alerts`**: an address to also receive each open/click/spike by email.
- **`geoip`**: when `true`, looks up city/country per event via a free service
  (needs outbound internet from the server).

## JSON API

Both versions accept these with the `X-API-Key` header. `/api/send` exists only
on the Python server, since the Cloudflare version doesn't send email.

```bash
KEY=your_api_key   # printed on startup / stored in config.json

# Prepare tracked HTML without sending
curl -X POST localhost:8025/api/prepare -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"to":"a@b.com","subject":"Hi","text":"See https://example.com"}'

# Send through SMTP
curl -X POST localhost:8025/api/send -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"to":"a@b.com","subject":"Hi","html":"<p>See <a href=\"https://example.com\">this</a></p>"}'

curl localhost:8025/api/activity?key=$KEY   # live feed
curl localhost:8025/api/alerts?key=$KEY     # alerts
```

## How it works

- **Open**: `<img src="BASE/t/<token>.gif">` appended to the body; the fetch is
  logged with time, IP, user agent and (optionally) location. Caching headers
  force a fresh request so reopens are counted.
- **Click**: each `<a href>` is rewritten to `BASE/c/<token>`, logged, then
  302-redirected to the real URL. `mailto:`/`tel:` are left alone.
- Data lives in `tracker.db` (SQLite) next to the script.

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

## Running the Python server long-term

Run under a process manager (NSSM on Windows, systemd on Linux) behind an HTTPS
reverse proxy. The server reads `X-Forwarded-For` / `CF-Connecting-IP` for the
real client IP. Scheduled sends and follow-up reminders run on a background
thread, so keep the process up.
