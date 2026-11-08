"""Email finder page against wrangler dev (live DNS lookups; Hunter only with a fake key)."""
import http.client, json, re, urllib.parse, html as H

import os as _os
HOST, PORT = "127.0.0.1", int(_os.environ.get("MAILSPY_TEST_PORT", "8787"))
results = []
def check(name, cond, detail=""):
    results.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if not cond else ""))
def req(method, path, body=None, hdr=None):
    c = http.client.HTTPConnection(HOST, PORT, timeout=60); h = dict(hdr or {})
    if isinstance(body, dict): body = json.dumps(body); h.setdefault("Content-Type", "application/json")
    c.request(method, path, body=body, headers=h); r = c.getresponse()
    return r.status, {k.lower(): v for k, v in r.getheaders()}, r.read().decode("utf-8", "replace")
F = {"Content-Type": "application/x-www-form-urlencoded", "Origin": "null", "Sec-Fetch-Site": "same-origin"}
def form(path, data, ck): return req("POST", path, urllib.parse.urlencode(data), {**F, "Cookie": ck})
def find(ck, **q): return req("GET", "/find?" + urllib.parse.urlencode(q), hdr={"Cookie": ck})
def emails(page): return re.findall(r'<td class="mono">([^<\s]+)', page)

s, h, _ = form("/emailtrack", {"email": "owner@x.example", "password": "correct-horse-battery"}, "")
OWN = h["set-cookie"].split(";")[0]
KEY = json.loads(req("POST", "/api/login", {"email": "owner@x.example", "password": "correct-horse-battery"})[2])["api_key"]

s, _, b = req("GET", "/find")
check("signed out: no Find page", s in (302, 404), s)
s, _, b = req("GET", "/find", hdr={"Cookie": OWN})
check("Find page loads, in the nav, with a nudge to add a key", s == 200 and 'href="/find" class="on"' in b and "add a free search key" in b, s)

s, _, b = find(OWN, mode="person", name="Jane Doe", company="Stripe")
e = emails(b)
check("person by company name: domain from Wikidata, format learned", "jane@stripe.com" in e and "usually look like" in b and "Assumed the company" not in H.unescape(b), e[:3])
check("company's own format ranked first", e and e[0] == "jane@stripe.com" and "format used by" in b, e[:2])
check("Write opens a Gmail compose to that address", "mail.google.com/mail/?view=cm&amp;fs=1&amp;to=jane%40stripe.com" in b, "")

s, _, b = find(OWN, mode="person", name="Jane Doe", company="https://www.stripe.com/jobs")
check("website given: used as is, no 'assumed' note", "jane@stripe.com" in emails(b) and "Assumed the company" not in H.unescape(b), "")

s, _, b = find(OWN, mode="recruiters", company="Notion")
e = emails(b)
check("recruiters without a key: shared hiring inboxes", "careers@notion.so" in e or "careers@notion.com" in e or any(x.startswith("careers@") for x in e), e)

s, _, b = find(OWN, mode="person", name="Jane Doe", company="zzqxj nonexistent co")
check("unknown company: clear message", "Couldn&#39;t work out the company" in b or "Couldn't work out" in H.unescape(b), "")

s, _, b = find(OWN, mode="person", name="", company="Stripe")
check("missing name: asks for it", "Enter the person" in H.unescape(b), "")

s, _, b = find(OWN, mode="recruiters", company='<script>alert(1)</script>')
check("input is escaped", "<script>alert(1)</script>" not in b, "")

# Hunter key: saved, never sent to the extension, bad key reported nicely
s, _, b = form("/settings", {"action": "prefs", "prefetch_seconds": "12", "notify_open": "on", "hunter_key": "abcdef0123456789abcdef0123456789abcdef01"}, OWN)
s, _, b = req("GET", "/settings", hdr={"Cookie": OWN})
check("key saved and shown in a password field", 'name="hunter_key"' in b and "abcdef0123456789abcdef0123456789abcdef01" in b and 'type="password" id="hunter_key"' in b, "")
s, _, b = req("GET", "/api/me", hdr={"X-API-Key": KEY})
check("key not exposed to the extension", "abcdef0123" not in b, b)
s, _, b = find(OWN, mode="recruiters", company="stripe.com")
check("bad key: friendly message, still shows guesses", "Hunter API key wasn" in H.unescape(b) and "careers@stripe.com" in emails(b), H.unescape(b)[b.find("note"):b.find("note") + 300])
s, _, b = form("/settings", {"action": "prefs", "prefetch_seconds": "12", "notify_open": "on", "hunter_key": "not a key!"}, OWN)
s, _, b = req("GET", "/settings", hdr={"Cookie": OWN})
check("junk key rejected", 'value=""' in b[b.find('id="hunter_key"'):b.find('id="hunter_key"') + 300], "")


s, _, b = find(OWN, mode="person", name="Patrick Collison", company="Stripe")
check("Gravatar-confirmed address shown first", emails(b)[:1] == ["patrick@stripe.com"] and "confirmed: has a Gravatar" in b, emails(b)[:3])
s, _, b = req("GET", "/api/find?" + urllib.parse.urlencode({"mode": "person", "name": "Patrick Collison", "company": "stripe.com"}), hdr={"X-API-Key": KEY})
d = json.loads(b)
check("/api/find returns JSON for the pop-up", s == 200 and d["domain"] == "stripe.com" and d["guesses"][0]["email"] == "patrick@stripe.com" and d["guesses"][0]["confirmed"] and "pattern" in d, str(d)[:300])
s, _, b = req("GET", "/api/find?mode=recruiters&company=Figma", hdr={"X-API-Key": KEY})
d = json.loads(b)
check("/api/find recruiters: published addresses and LinkedIn links", d["domain"] == "figma.com" and d["published"] and any("linkedin.com" in l["href"] for l in d["links"]), str(d)[:300])
s, _, b = req("GET", "/api/find?mode=person&name=x&company=stripe.com")
check("/api/find needs a key", s == 401, s)
print(f"\n{sum(results)}/{len(results)} passed")
import sys as _s
_s.exit(0 if all(results) else 1)
