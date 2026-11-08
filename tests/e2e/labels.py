"""Gmail labels API against wrangler dev on a fresh database."""
import glob, http.client, json, os, sqlite3, sys, time, urllib.parse, re

import os as _os
HOST, PORT = "127.0.0.1", int(_os.environ.get("MAILSPY_TEST_PORT", "8787"))
DBFILE = [p for p in glob.glob(os.path.join(sys.argv[1], ".wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite"))
          if not p.endswith("metadata.sqlite")][0]
results = []
def check(name, cond, detail=""):
    results.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if not cond else ""))
def req(method, path, body=None, hdr=None):
    c = http.client.HTTPConnection(HOST, PORT, timeout=30); h = dict(hdr or {})
    if isinstance(body, dict): body = json.dumps(body); h.setdefault("Content-Type", "application/json")
    c.request(method, path, body=body, headers=h); r = c.getresponse()
    return r.status, {k.lower(): v for k, v in r.getheaders()}, r.read()
F = {"Content-Type": "application/x-www-form-urlencoded", "Origin": "null", "Sec-Fetch-Site": "same-origin"}
def form(path, data, ck): return req("POST", path, urllib.parse.urlencode(data), {**F, "Cookie": ck})
def db():
    c = sqlite3.connect(DBFILE, timeout=10); c.row_factory = sqlite3.Row; return c
CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36"

s, h, _ = form("/emailtrack", {"email": "owner@x.example", "password": "correct-horse-battery"}, "")
OWN = h["set-cookie"].split(";")[0]
KEY = json.loads(req("POST", "/api/login", {"email": "owner@x.example", "password": "correct-horse-battery"})[2])["api_key"]
OK = {"X-API-Key": KEY}
form("/settings", {"action": "prefs", "prefetch_seconds": "0", "notify_open": "on"}, OWN)

s, _, b = req("GET", "/api/labels")
check("labels API needs a key", s == 401, s)

ids = {}
for name in ["a", "b", "c"]:
    _, _, b = req("POST", "/api/prepare", {"to": f"{name}@x.example", "subject": f"Hello {name}",
              "html": '<a href="https://example.com/x">x</a>', "track_urls": ["https://example.com/x"]}, OK)
    ids[name] = json.loads(b)
_, _, b = req("POST", "/api/prepare", {"to": "later@x.example", "subject": "Later", "html": "<p>x</p>", "scheduled_at": time.time() + 86400}, OK)

_, _, b = req("GET", "/api/labels", hdr=OK)
p = json.loads(b)["pending"]
check("new emails are pending as unopened (scheduled one left out)", sorted(x["to"] for x in p) == ["a@x.example", "b@x.example", "c@x.example"]
      and all(x["want"] == "unopened" and x["had"] == "" and x["thread"] == "" for x in p), p)
by = {x["to"][0]: x for x in p}

_, _, b = req("POST", "/api/labels", {"done": [{"id": by[k]["id"], "thread": "T" + k, "state": "unopened"} for k in "abc"]}, OK)
check("acks saved", json.loads(b)["saved"] == 3, b)
_, _, b = req("GET", "/api/labels", hdr=OK)
check("nothing pending after ack", json.loads(b)["pending"] == [], b)

# b gets opened, c gets a click
req("GET", f"/img/{ids['b']['token']}.gif", hdr={"User-Agent": CHROME})
code = re.search(r'href="https?://[^/"]+/([A-Za-z0-9]{7})"', ids["c"]["html"]).group(1)
req("GET", "/c/" + code, hdr={"User-Agent": CHROME})
time.sleep(1.2)
_, _, b = req("GET", "/api/labels", hdr=OK)
p = {x["to"][0]: x for x in json.loads(b)["pending"]}
check("opened email now wants 'opened', with its thread", p.get("b", {}).get("want") == "opened" and p["b"]["thread"] == "Tb" and p["b"]["had"] == "unopened", p)
check("clicked email wants 'clicked'", p.get("c", {}).get("want") == "clicked", p)
check("untouched email not pending", "a" not in p, p)

req("POST", "/api/labels", {"done": [{"id": p["b"]["id"], "thread": "Tb", "state": "opened"},
                                     {"id": p["c"]["id"], "state": "clicked"},
                                     {"id": 999999, "state": "opened"}, {"id": p["b"]["id"], "state": "bogus"}]}, OK)
with db() as c:
    rows = {r["to_addr"][0]: dict(r) for r in c.execute("SELECT to_addr, gmail_thread, label_state FROM emails")}
check("states and threads stored; bogus ignored", rows["b"]["label_state"] == "opened" and rows["c"]["label_state"] == "clicked"
      and rows["c"]["gmail_thread"] == "Tc", rows)

# nomatch stops retries
with db() as c:
    c.execute("UPDATE emails SET label_state=NULL, gmail_thread=NULL WHERE to_addr='a@x.example'")
_, _, b = req("GET", "/api/labels", hdr=OK)
aid = [x for x in json.loads(b)["pending"] if x["to"] == "a@x.example"][0]["id"]
req("POST", "/api/labels", {"done": [{"id": aid, "state": "nomatch"}]}, OK)
_, _, b = req("GET", "/api/labels", hdr=OK)
check("'nomatch' emails are not retried", all(x["id"] != aid for x in json.loads(b)["pending"]), b)

# another user can't touch these
_, _, b = form("/admin/invite", {"note": "Lee"}, OWN)
inv = re.search(rb"/signup\?code=([A-Za-z0-9_-]+)", b).group(1).decode()
form(f"/signup?code={inv}", {"email": "lee@x.example", "name": "Lee", "password": "lee-password-1", "password2": "lee-password-1"}, "")
LK = {"X-API-Key": json.loads(req("POST", "/api/login", {"email": "lee@x.example", "password": "lee-password-1"})[2])["api_key"]}
_, _, b = req("GET", "/api/labels", hdr=LK)
check("other user sees none of them", json.loads(b)["pending"] == [], b)
req("POST", "/api/labels", {"done": [{"id": p["b"]["id"], "thread": "HACK", "state": "unopened"}]}, LK)
with db() as c:
    r = c.execute("SELECT gmail_thread, label_state FROM emails WHERE id=?", (p["b"]["id"],)).fetchone()
check("other user can't change them", r["gmail_thread"] == "Tb" and r["label_state"] == "opened", dict(r))

_, _, b = req("GET", "/settings", hdr={"Cookie": OWN})
check("settings shows the Gmail labels section with the script", b"Gmail labels" in b and b"function setup()" in b and KEY.encode() in b, "")
check("settings says connected after a check-in", b"Connected." in b, "")
print(f"\n{sum(results)}/{len(results)} passed")
import sys as _s
_s.exit(0 if all(results) else 1)
