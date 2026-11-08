"""Trustworthy opens against wrangler dev: Apple Mail fetches, 'via Gmail' locations,
and the 'Hide tracking from my own Sent copy' setting (Gmail itself isn't reachable here)."""
import glob, http.client, json, os, sqlite3, sys, time, urllib.parse, html as H

HOST, PORT = "127.0.0.1", int(os.environ.get("MAILSPY_TEST_PORT", "8787"))
DBFILE = [p for p in glob.glob(os.path.join(sys.argv[1], ".wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite"))
          if not p.endswith("metadata.sqlite")][0]
results = []
def check(name, cond, detail=""):
    results.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if not cond else ""))
def req(method, path, body=None, hdr=None):
    c = http.client.HTTPConnection(HOST, PORT, timeout=30); h = dict(hdr or {})
    if isinstance(body, dict): body = json.dumps(body); h.setdefault("Content-Type", "application/json")
    c.request(method, path, body=body, headers=h); r = c.getresponse()
    return r.status, {k.lower(): v for k, v in r.getheaders()}, r.read().decode("utf-8", "replace")
F = {"Content-Type": "application/x-www-form-urlencoded", "Origin": "null", "Sec-Fetch-Site": "same-origin"}
def form(path, data, ck=""): return req("POST", path, urllib.parse.urlencode(data), {**F, "Cookie": ck})
def db():
    c = sqlite3.connect(DBFILE, timeout=10); c.row_factory = sqlite3.Row; return c
def wait_for(fn, secs=5):
    end = time.time() + secs
    while time.time() < end:
        v = fn()
        if v: return v
        time.sleep(0.2)
    return fn()

APPLE = "Mozilla/5.0"
GMAIL = "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)"
CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36"

s, h, _ = form("/emailtrack", {"email": "owner@x.example", "password": "correct-horse-battery"})
OWN = h["set-cookie"].split(";")[0]
KEY = json.loads(req("POST", "/api/login", {"email": "owner@x.example", "password": "correct-horse-battery"})[2])["api_key"]
OK = {"X-API-Key": KEY}
form("/settings", {"action": "prefs", "prefetch_seconds": "0", "notify_open": "on", "notify_click": "on", "show_automated": "on", "hide_sent_pixel": "on"}, OWN)

_, _, b = req("POST", "/api/prepare", {"to": "jane@x.example", "to_name": "Jane", "subject": "Coffee?", "html": "<p>hi</p>"}, OK)
e1 = json.loads(b)
def events(eid):
    with db() as c: return [dict(r) for r in c.execute("SELECT * FROM events WHERE email_id=? ORDER BY id", (eid,))]
def alerts(eid):
    with db() as c: return [dict(r) for r in c.execute("SELECT * FROM alerts WHERE email_id=? ORDER BY id", (eid,))]
def email(eid):
    with db() as c: return dict(c.execute("SELECT * FROM emails WHERE id=?", (eid,)).fetchone())

# 1. Apple Mail Privacy Protection fetch: recorded, but not an open
req("GET", f"/img/{e1['token']}.gif", hdr={"User-Agent": APPLE})
ev = wait_for(lambda: events(e1["id"]))
check("Apple Mail fetch recorded as 'apple', not counted", ev and ev[0]["flagged"] == "apple" and ev[0]["is_bot"] == 1 and email(e1["id"])["opens"] == 0, ev)
check("...and no 'opened' notification", not [a for a in alerts(e1["id"]) if a["kind"] == "open"], alerts(e1["id"]))

# 2. then a Gmail open: counts, and says "via Gmail"
time.sleep(0.3)
req("GET", f"/img/{e1['token']}.gif", hdr={"User-Agent": GMAIL})
al = wait_for(lambda: [a for a in alerts(e1["id"]) if a["kind"] == "open"])
check("Gmail open counts, alert says 'via Gmail'", email(e1["id"])["opens"] == 1 and al and al[0]["message"] == 'Jane opened "Coffee?" via Gmail', al)
with db() as c:   # what Cloudflare would have stored for Google's proxy
    c.execute("UPDATE events SET geo='Mountain View, US' WHERE email_id=? AND user_agent=?", (e1["id"], GMAIL))
    c.execute("UPDATE events SET geo='Cupertino, US' WHERE email_id=? AND user_agent=?", (e1["id"], APPLE))

# 3. a direct open keeps its real place
_, _, b = req("POST", "/api/prepare", {"to": "bob@x.example", "subject": "Direct", "html": "<p>hi</p>"}, OK)
e2 = json.loads(b)
req("GET", f"/img/{e2['token']}.gif", hdr={"User-Agent": CHROME})
wait_for(lambda: events(e2["id"]))
with db() as c:
    c.execute("UPDATE events SET geo='Berlin, DE' WHERE email_id=?", (e2["id"],))

s, _, b = req("GET", "/api/activity", hdr=OK)
act = json.loads(b)
g = [v for v in act if v.get("email_id") == e1["id"] and not v["is_bot"]]
check("/api/activity: 'via Gmail' for the proxy open, no user agent sent", g and g[0]["geo"] == "via Gmail" and "user_agent" not in g[0], g)
check("/api/activity: Apple fetch 'via Apple Mail', direct open keeps Berlin",
      any(v.get("flagged") == "apple" and v["geo"] == "via Apple Mail" for v in act) and any(v.get("email_id") == e2["id"] and v["geo"] == "Berlin, DE" for v in act), act)
s, _, b = req("GET", f"/api/emails/{e1['id']}", hdr=OK)
check("/api/emails/<id>: events' geo 'via Gmail'", all(v["geo"] in ("via Gmail", "via Apple Mail") for v in json.loads(b)["events"]), b[:300])

s, _, b = req("GET", f"/email/{e1['id']}", hdr={"Cookie": OWN})
b = H.unescape(b)
check("email page: 'via Gmail', 'Apple Mail, may be automatic', no proxy cities", "via Gmail" in b and "Apple Mail, may be automatic" in b and "Mountain View" not in b and "Cupertino" not in b, "")
s, _, b = req("GET", "/", hdr={"Cookie": OWN})
check("dashboard activity: 'via Gmail', Berlin kept, no Mountain View", "via Gmail" in b and "Berlin, DE" in b and "Mountain View" not in b, "")

# 4. a click after an Apple-only email still counts
_, _, b = req("POST", "/api/prepare", {"to": "amy@x.example", "subject": "Link", "html": '<a href="https://example.com/x">x</a>', "track_urls": ["https://example.com/x"]}, OK)
e3 = json.loads(b)
req("GET", f"/img/{e3['token']}.gif", hdr={"User-Agent": APPLE})
wait_for(lambda: events(e3["id"]))
import re
code = re.search(r'href="https?://[^/"]+/([A-Za-z0-9]{7})"', e3["html"]).group(1)
req("GET", "/c/" + code, hdr={"User-Agent": CHROME})
wait_for(lambda: email(e3["id"])["clicks"])
check("click after an Apple fetch: counted and notified", email(e3["id"])["clicks"] == 1 and any(a["kind"] == "click" for a in alerts(e3["id"])), alerts(e3["id"]))

# 5. the setting
with db() as c:
    c.execute("UPDATE users SET gmail_token='sealed', gmail_email='owner@gmail.example' WHERE email='owner@x.example'")
s, _, b = req("GET", "/settings", hdr={"Cookie": OWN})
check("settings: 'Hide tracking from my own Sent copy' under Gmail checkmarks, on by default",
      'name="hide_sent_pixel" form="prefsForm" checked' in b and b.index("Hide tracking from my own Sent copy") > b.index("Gmail checkmarks"), "")
def prefs():
    with db() as c: return json.loads(c.execute("SELECT prefs FROM users WHERE email='owner@x.example'").fetchone()["prefs"])
form("/settings", {"action": "prefs", "prefetch_seconds": "0"}, OWN)
check("unticking turns it off", prefs()["hide_sent_pixel"] is False, prefs())
form("/settings", {"action": "prefs", "prefetch_seconds": "0", "hide_sent_pixel": "on"}, OWN)
check("ticking turns it on", prefs()["hide_sent_pixel"] is True, prefs())
with db() as c:
    c.execute("UPDATE users SET gmail_token=NULL WHERE email='owner@x.example'")
s, _, b = req("GET", "/settings", hdr={"Cookie": OWN})
check("without Gmail connected: carried in a hidden field so saving keeps it", '<input type="hidden" name="hide_sent_pixel" value="on">' in b, "")

# 6. the scheduled sweep runs on D1 without errors (Gmail unreachable: the email is left as it was)
with db() as c:
    c.execute("UPDATE users SET gmail_token='sealed' WHERE email='owner@x.example'")
    c.execute("UPDATE emails SET gmail_msg='m-fake' WHERE id=?", (e2["id"],))
s, _, b = req("GET", "/__scheduled?cron=*%2F5+*+*+*+*")
time.sleep(1.5)
check("scheduled run OK; nothing changed without Gmail", s == 200 and email(e2["id"])["gmail_msg"] == "m-fake" and email(e2["id"])["sent_clean"] is None, (s, email(e2["id"])))

s, _, b = req("GET", "/privacy")
check("privacy policy describes the Sent-copy swap", "Hide tracking from my own Sent copy" in b and "moves the original to Trash" in b, "")

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
