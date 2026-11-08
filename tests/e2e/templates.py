"""Templates: API for the Gmail pop-up and the dashboard pages, on a database without the templates table."""
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

s, h, _ = form("/emailtrack", {"email": "owner@x.example", "password": "correct-horse-battery"}, "")
OWN = h["set-cookie"].split(";")[0]
KEY = json.loads(req("POST", "/api/login", {"email": "owner@x.example", "password": "correct-horse-battery"})[2])["api_key"]
K = {"X-API-Key": KEY}

s, _, b = req("GET", "/api/templates?to=jane.doe@stripe.com", hdr=K)
d = json.loads(b)
check("works before the table exists (created on first use)", s == 200 and d["templates"] == [], b)
check("company worked out from the domain", d["company"] == "Stripe" and d["domain"] == "stripe.com", d)
s, _, b = req("GET", "/api/templates?to=bob@gmail.com", hdr=K)
check("webmail has no company", json.loads(b)["company"] == "" and json.loads(b)["domain"] == "", b)

def make(**t):
    s, _, b = req("POST", "/api/templates", t, K); return s, json.loads(b)
s, a = make(name="General hello", subject="Hi {first_name}", body="<div>Hi {first_name}, love what {company} does.</div>")
check("create a general template", s == 200 and a["scope_type"] == "any", a)
s, c = make(name="Stripe ask", body="<div>Stripe-specific</div>", scope_type="company", scope_value="https://www.Stripe.com/jobs")
check("company template: domain cleaned up", c.get("scope_type") == "company" and c.get("scope_value") == "stripe.com", c)
s, p = make(name="For Jane", body="<div>Jane only</div>", scope_type="person", scope_value="Jane.Doe@stripe.com")
check("person template", p.get("scope_type") == "person" and p.get("scope_value") == "jane.doe@stripe.com", p)
s, o = make(name="Figma ask", body="<div>Figma</div>", scope_type="company", scope_value="figma.com")
s, bad = make(name="", body="<div>x</div>")
check("name required", s == 400 and "name" in bad["error"], bad)
s, bad = make(name="Empty", body="   ")
check("empty template refused", s == 400, bad)
s, x = make(name="Nasty", body='<div onclick="alert(1)">a<script>alert(2)</script><a href="javascript:alert(3)">l</a><iframe src="x"></iframe><img src=x onerror=alert(4)><b data-mailspy-track="1">ok</b></div>')
check("dangerous HTML stripped", all(t not in x["body"] for t in ["onclick", "<script", "javascript:", "<iframe", "onerror", "data-mailspy"]) and "<b>ok</b>" in x["body"], x["body"])
req("POST", f"/api/templates/{x['id']}/delete", {}, K)

s, _, b = req("GET", "/api/templates?to=jane.doe@stripe.com", hdr=K)
d = json.loads(b)
order = [(t["name"], t["match"]) for t in d["templates"]]
check("ranked: person, then company, then general, then others", order == [("For Jane", "person"), ("Stripe ask", "company"), ("General hello", ""), ("Figma ask", "other")], order)
s, _, b = req("GET", "/api/templates?to=sam@stripe.com", hdr=K)
order = [(t["name"], t["match"]) for t in json.loads(b)["templates"]]
check("someone else at Stripe: company first, Jane's is 'other'", order[0] == ("Stripe ask", "company") and ("For Jane", "other") in order, order)
s, _, b = req("GET", "/api/templates?to=sam@eu.stripe.com", hdr=K)
check("subdomain counts as the company", json.loads(b)["templates"][0]["name"] == "Stripe ask", b[:200])

req("POST", f"/api/templates/{a['id']}/used", {}, K)
req("POST", f"/api/templates/{a['id']}/used", {}, K)
s, _, b = req("GET", "/api/templates?to=zed@acme.example", hdr=K)
check("most recently used general template comes first", json.loads(b)["templates"][0]["name"] == "General hello", b[:200])

# another user can't see or touch them
_, _, b = form("/admin/invite", {"note": "Lee"}, OWN)
inv = re.search(r"/signup\?code=([A-Za-z0-9_-]+)", b).group(1)
form(f"/signup?code={inv}", {"email": "lee@x.example", "name": "Lee", "password": "lee-password-1", "password2": "lee-password-1"}, "")
LK = {"X-API-Key": json.loads(req("POST", "/api/login", {"email": "lee@x.example", "password": "lee-password-1"})[2])["api_key"]}
s, _, b = req("GET", "/api/templates", hdr=LK)
check("other user sees none", json.loads(b)["templates"] == [], b)
s, _, b = req("POST", f"/api/templates/{a['id']}/delete", {}, LK)
check("other user can't delete", json.loads(b)["ok"] is False, b)

# dashboard
s, _, b = req("GET", "/templates", hdr={"Cookie": OWN})
check("Templates page lists them, in the nav", s == 200 and 'href="/templates" class="on"' in b and "Stripe ask" in b and "stripe.com" in b, s)
s, _, b = req("GET", f"/templates/{a['id']}", hdr={"Cookie": OWN})
check("edit page shows body in the editor", s == 200 and "love what {company} does" in b and 'id="ed"' in b, s)
s, h, b = form(f"/templates/{a['id']}", {"name": "General hello v2", "scope_type": "company", "scope_value": "acme.example", "subject": "Hey {first_name}", "body": "<div>Edited</div>"}, OWN)
check("edit saves and redirects", s == 302 and "/templates?saved=1" in h.get("location", ""), s)
s, _, b = req("GET", "/api/templates?to=x@acme.example", hdr=K)
t0 = json.loads(b)["templates"][0]
check("edit took effect", t0["name"] == "General hello v2" and t0["match"] == "company" and t0["body"] == "<div>Edited</div>", t0)
s, h, b = form("/templates/new", {"name": "", "scope_type": "any", "body": "<div>x</div>"}, OWN)
check("new: error keeps the form", s == 200 and "Give the template a name" in H.unescape(b) and "<div>x</div>" in b, s)
s, h, b = form("/templates/new", {"name": "From dashboard", "scope_type": "person", "scope_value": "kim@figma.com", "body": "<div>Hi</div>"}, OWN)
check("new from dashboard", s == 302, s)
s, h, b = form(f"/templates/{o['id']}/delete", {}, OWN)
loc = h.get("location", "")
s, _, b = req("GET", "/templates?deleted=1", hdr={"Cookie": OWN})
check("delete from dashboard", "deleted=1" in loc and "Figma ask" not in b and "Template deleted" in b, loc)
s, _, b = req("GET", "/templates/999999", hdr={"Cookie": OWN})
check("missing template: 404", s == 404, s)
print(f"\n{sum(results)}/{len(results)} passed")
import sys as _s
_s.exit(0 if all(results) else 1)
