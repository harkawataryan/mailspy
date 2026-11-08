"""Google sign-in pages and routes against wrangler dev (Google itself isn't reachable here)."""
import glob, http.client, json, os, re, sqlite3, sys, urllib.parse, html as H

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
    return r.status, {k.lower(): v for k, v in r.getheaders()}, r.read().decode("utf-8", "replace")
F = {"Content-Type": "application/x-www-form-urlencoded", "Origin": "null", "Sec-Fetch-Site": "same-origin"}
def form(path, data, ck=""): return req("POST", path, urllib.parse.urlencode(data), {**F, "Cookie": ck})
def db():
    c = sqlite3.connect(DBFILE, timeout=10); c.row_factory = sqlite3.Row; return c

s, h, _ = form("/emailtrack", {"email": "owner@x.example", "password": "correct-horse-battery"})
OWN = h["set-cookie"].split(";")[0]

s, _, b = req("GET", "/api/version")
check("/api/version says Google sign-in is available", json.loads(b).get("google") is True, b)
s, _, b = req("GET", "/emailtrack")
check("sign-in page: Continue with Google, plus password", "Continue with Google" in b and 'href="/auth/google?mode=signin"' in b and 'name="password"' in b, "")

s, h, _ = req("GET", "/auth/google?mode=signin")
loc = h.get("location", "")
q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(loc).query))
check("/auth/google sends you to Google with Gmail permission", s == 302 and loc.startswith("https://accounts.google.com/o/oauth2/v2/auth")
      and "gmail.modify" in q.get("scope", "") and q.get("redirect_uri", "").endswith("/auth/google/callback")
      and q.get("access_type") == "offline" and q.get("prompt") == "select_account" and q.get("state"), loc[:160])
s, h, _ = req("GET", "/auth/google?mode=connect")
check("connect without being signed in -> sign-in page", s == 302 and h.get("location") == "/emailtrack", h.get("location"))
s, h, _ = req("GET", "/auth/google?mode=connect", hdr={"Cookie": OWN})
q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(h.get("location", "")).query))
check("connect while signed in asks for consent", q.get("prompt") == "consent", q.get("prompt"))

s, _, b = req("GET", "/auth/google/callback?state=forged.sig&code=x")
check("forged state refused with a friendly message", s == 400 and "took too long" in H.unescape(b), s)
s, h, _ = req("GET", "/auth/google?mode=signin")
state = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(h["location"]).query))["state"]
s, _, b = req("GET", "/auth/google/callback?" + urllib.parse.urlencode({"state": state, "error": "access_denied"}))
check("cancelled at Google -> 'cancelled' message", s == 400 and "cancelled" in b, s)

# invite signup page
_, _, b = form("/admin/invite", {"note": "Kim"}, OWN)
code = re.search(r"/signup\?code=([A-Za-z0-9_-]+)", b).group(1)
s, _, b = req("GET", f"/signup?code={code}")
check("invite page: Sign up with Google carries the invite", "Sign up with Google" in b and f"/auth/google?mode=signup&amp;code={code}" in b, "")

# Settings for a password account
s, _, b = req("GET", "/settings", hdr={"Cookie": OWN})
check("settings: Gmail checkmarks section with Connect Gmail", "Gmail checkmarks" in b and 'href="/auth/google?mode=connect"' in b and "Apps Script" not in b, "")

# a Google-only account (as the callback would create it), with Gmail connected
with db() as c:
    c.execute("INSERT INTO users(email,name,password_hash,api_key,is_admin,created_at) VALUES('kim@g.com','Kim','!google','kimkey1234567890abcdefghij',0,1)")
    c.execute("UPDATE users SET gmail_token='sealed', gmail_email='kim@g.com' WHERE email='kim@g.com'")
s, _, b = req("POST", "/api/login", {"email": "kim@g.com", "password": "anything"})
check("extension password sign-in for a Google account explains why", s == 401 and "signs in with Google" in json.loads(b)["error"], b)
s, _, b = form("/emailtrack", {"email": "kim@g.com", "password": "!google"})
check("can't sign in with the marker as a password", s == 401, s)

# sign Kim in by forging nothing: use the owner's admin? Instead make a session via password after adding one through settings is impossible without a session,
# so check the Google-only settings page by giving Kim a session cookie through the normal password route: set a real password directly.
import base64, hashlib, os as _os
salt = _os.urandom(16); hsh = hashlib.pbkdf2_hmac("sha256", b"kim-password-1", salt, 5000)
with db() as c:
    c.execute("UPDATE users SET password_hash=? WHERE email='kim@g.com'", (f"pbkdf2_sha256$5000${base64.b64encode(salt).decode()}${base64.b64encode(hsh).decode()}",))
s, h, _ = form("/emailtrack", {"email": "kim@g.com", "password": "kim-password-1"})
KIM = h["set-cookie"].split(";")[0]
with db() as c:
    c.execute("UPDATE users SET password_hash='!google' WHERE email='kim@g.com'")
s, _, b = req("GET", "/settings", hdr={"Cookie": KIM})
check("Google-only account: 'Add password' without current password", "Add password" in b and 'name="current_password"' not in b, "")
check("connected Gmail shown with Disconnect", "Connected" in b and "kim@g.com" in b and "Disconnect Gmail" in b, "")
s, _, b = form("/settings", {"new_password": "brand-new-pass-1", "new_password2": "brand-new-pass-1"}, KIM)
check("adding a password works", "Password changed" in b, "")
s, _, b = req("POST", "/api/login", {"email": "kim@g.com", "password": "brand-new-pass-1"})
check("then the extension can use it too", s == 200 and json.loads(b)["api_key"], b)
s, _, b = form("/settings", {"action": "gmail_disconnect"}, KIM)
with db() as c:
    r = c.execute("SELECT gmail_token FROM users WHERE email='kim@g.com'").fetchone()
check("Disconnect Gmail clears the token", r["gmail_token"] is None and "Gmail disconnected" in b, dict(r))

# extension hand-off page
s, h, _ = req("GET", "/extension-link")
check("extension-link signed out -> Google sign-in for the extension", s == 302 and h.get("location") == "/auth/google?mode=ext", h.get("location"))
s, h, b = req("GET", "/extension-link", hdr={"Cookie": KIM})
check("extension-link signed in: key for the extension, can't be framed", s == 200 and 'data-key="kimkey1234567890abcdefghij"' in b and h.get("x-frame-options") == "DENY", s)
print(f"\n{sum(results)}/{len(results)} passed")
import sys as _s
_s.exit(0 if all(results) else 1)
