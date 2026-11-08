# Your own tracking domain, on someone else's MailSpy

People with an account on a MailSpy server can use their own domain in their
emails (for example `go.theirdomain.com`) instead of the server's tracking
address. They set it in **Settings → Your tracking domain**, add one DNS record,
and that's it: no Cloudflare account, no server of their own.

Behind the scenes MailSpy registers their domain with the server owner's
Cloudflare account ("custom hostnames", part of Cloudflare for SaaS), gets it a
certificate, and routes it to the Worker. The code is in
`cloudflare/src/domains.js`.

## Using it (anyone with an account)

1. In MailSpy, open **Settings → Your tracking domain**.
2. Enter a subdomain you own, for example `go.yourdomain.com`, and click **Use
   this domain**.
3. Where you manage your domain's DNS, add the record MailSpy shows:
   - **Type:** CNAME
   - **Name:** `go` (or the full `go.yourdomain.com`, depending on the DNS site)
   - **Target:** shown on the Settings page, for example `saas.aryanh.dev`

   If your DNS is on Cloudflare, set the record to **DNS only** (grey cloud).
4. Wait a few minutes. MailSpy checks every 10 minutes, or click **Check now**.
   When it says **Working**, new emails, PDFs and short links use your domain.

Until then, your emails keep using the server's tracking address. Links in
emails you already sent keep working either way. If you remove your domain
later, links that used it stop working.

## Switching it on (once, by the server owner)

These steps are in your Cloudflare dashboard, in the zone that holds your
tracking domain (for MailSpy's own server, `aryanh.dev`).

1. **Enable Cloudflare for SaaS:** **SSL/TLS → Custom Hostnames → Enable**.
   The first 100 hostnames are free. Cloudflare may ask you to add a payment
   method first.
2. **Make the target record:** in **DNS → Records**, add:
   - **Type:** AAAA
   - **Name:** `saas`
   - **IPv6 address:** `100::`
   - **Proxy status:** Proxied (orange cloud)

   This is the address people point their CNAME at. It must match `saasTarget`
   in `mailspy.config.json` (`saas.aryanh.dev` here).
3. **Set it as the fallback origin:** back in **SSL/TLS → Custom Hostnames**,
   enter `saas.aryanh.dev` as the **Fallback Origin** and click **Add**. Wait
   until it shows **Active**.
4. **Make an API token:** **My Profile → API Tokens → Create Token → Custom
   token**, with these permissions:
   - Zone → **SSL and Certificates** → Edit
   - Zone → **Workers Routes** → Edit
   - Zone → **Zone** → Read

   Under **Zone Resources**, include only that zone. Create it and copy the
   token.
5. **Give it to MailSpy:** in `cloudflare/`, run this and paste the token when
   it asks:

   ```
   npx wrangler secret put CF_API_TOKEN
   ```

The **Your tracking domain** section then appears in everyone's Settings.

Without `saasTarget` or `CF_API_TOKEN`, the feature stays off and nothing else
changes.
