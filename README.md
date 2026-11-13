# MailSpy

MailSpy is an email open and click tracker you run yourself, in the same spirit as Mailsuite or Mailtrack. Every email you send gets an invisible 1x1 image and tracked links, so you can see when someone opened it, how many times, roughly where they were, what mail app they used, and which links they clicked. Activity shows up in a live feed and as desktop notifications, and a Chrome extension adds all of it to Gmail.

It runs on Cloudflare's free plan with Workers and D1 (the code is in `cloudflare/`), so there's no credit card and no server to keep running.

To set it up, follow [SETUP.md](SETUP.md). To run your own copy on your own domain, see [docs/run-your-own-copy.md](docs/run-your-own-copy.md). Every domain it uses comes from one file, `mailspy.config.json`.

## Tracking

The open pixel and tracked links are added at the moment you click Send, and each recipient gets their own tracked copy, so you know exactly who opened it.

Most of the work is in not counting opens that weren't really opens. These hits still show up, but they don't count:

- anything in the first few seconds after sending, which catches your own compose window, Apple Mail fetching the message on delivery, and link scanners
- security scanners recognized by their user agent, and "clicks" on several links within 2 seconds, which is how scanners behave
- you looking at your own sent message or draft in Gmail, which the extension reports
- hits from IP addresses you've told it to ignore

Gmail, Yahoo and Outlook.com load images through their own proxy servers when the recipient opens the message, so those do count as opens.

## The dashboard

The home page is a live feed of activity ("Jane opened your email · 2m ago · London") with desktop and browser notifications that arrive without refreshing. Each email has a timeline of every open and click with the mail app, location and IP address.

Alerts fire on the first open, on reopens, on a burst of opens in a short time (often the sign of an interested reader), when an old email gets opened again, and when something you sent hasn't been opened within a time you choose, as a reminder to follow up.

You can also queue Gmail drafts to send at a set time and edit them before they go out, and invite friends with a link so they can have their own accounts, where each person only sees their own email.

## The Chrome extension

The extension adds tracking to Gmail on the web.

1. Install it from the [Chrome Web Store](https://chromewebstore.google.com/detail/mailspy-email-tracking-fo/dofghebhjogkhipgjkhnomhmaiplgdgi). For development, go to `chrome://extensions`, turn on Developer mode, click Load unpacked and select the `extension/` folder.
2. Click the MailSpy icon and sign in with your MailSpy account. If you run your own copy, first open "Use a different MailSpy server" on the sign-in page and enter your server's address.
3. Write an email in Gmail and hit Send. The extension registers the email with your server and adds the pixel and tracked links before it goes out. The popup shows your live activity, and desktop notifications fire on each open.

Gmail's HTML isn't a public API, so the extension's selectors are best effort and may need a small fix when Google changes its markup. If tracking ever fails, the extension sends the email untracked rather than blocking it.

## JSON API

There's also a JSON API for sending tracked email from your own scripts. Every call takes an `X-API-Key` header, and your key is on the dashboard's Settings page.

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

An open is recorded when the recipient's mail app loads an `<img>` pointing at `BASE/img/<token>.gif`, which is added to the end of the email. Each load is logged with the time, IP address, user agent and location, and caching headers force a fresh request every time so reopens are counted. A click is recorded by rewriting each link to a short `BASE/<code>` address that logs the click and then redirects to the real URL. `mailto:` and `tel:` links are left alone. Everything is stored in Cloudflare D1, with the schema in `cloudflare/schema.sql`.

That's also why the tracking address has to be reachable from the internet, since your recipients' mail apps fetch the image and follow the links from there.

## Limits

These are true of every tracker like this, Mailsuite included.

If a recipient has images turned off, no open gets recorded. Outlook desktop and many corporate mail setups block remote images by default, though clicks still work.

Gmail fetches the pixel through its own proxy, so the IP address on an open is Google's rather than the recipient's. The open still counts, and the mail app shows as Gmail.

Apple Mail Privacy Protection can load images as soon as a message arrives. Hits in the first few seconds after sending are already excluded, but a later automatic load can still look like an open, so treat a single Apple Mail open with some caution.

## Consent

Open and click tracking is standard in sales and marketing email, but recipients usually can't tell it's there. Some places, like the EU and UK under GDPR and PECR, treat tracking pixels as needing a lawful basis or a disclosure. Bulk email also has to follow anti-spam laws like CAN-SPAM and CASL, which means a real sender address, a working unsubscribe link for marketing mail, and nothing deceptive. Use this for your own legitimate email and outreach, and check what rules apply where your recipients are.
