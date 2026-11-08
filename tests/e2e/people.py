"""People and Companies pages, and replies shown around the dashboard, against wrangler dev on a fresh database."""
import glob, http.client, json, os, re, sqlite3, sys, time, urllib.parse, html as H

HOST, PORT = "127.0.0.1", int(os.environ.get("MAILSPY_TEST_PORT", "8787"))
DBFILE = [p for p in glob.glob(os.path.join(sys.argv[1], ".wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite"))
          if not p.endswith("metadata.sqlite")][0]
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
def db():
    c = sqlite3.connect(DBFILE, timeout=10); c.row_factory = sqlite3.Row; return c
def get(path, ck): return req("GET", path, hdr={"Cookie": ck})
CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36"

s, h, _ = form("/emailtrack", {"email": "owner@x.example", "password": "correct-horse-battery"}, "")
OWN = h["set-cookie"].split(";")[0]
K = {"X-API-Key": json.loads(req("POST", "/api/login", {"email": "owner@x.example", "password": "correct-horse-battery"})[2])["api_key"]}
form("/settings", {"action": "prefs", "prefetch_seconds": "0", "followup_hours": "48", "notify_open": "on", "notify_reply": "on"}, OWN)

s, _, b = get("/people", OWN)
check("People page works with nobody yet", s == 200 and "Nobody yet" in b and 'href="/people" class="on"' in b, s)

def send(to, subject):
    return json.loads(req("POST", "/api/prepare", {"to": to, "subject": subject, "html": "<p>Hi</p>"}, K)[2])
jane1 = send("jane@stripe.com", "Coffee chat?")
jane2 = send("Jane@Stripe.com", "Following up")
sam = send("sam@eu.stripe.com", "Hello from Aryan")
kim = send("kim@figma.com", "Design role")
pal = send("pal@gmail.com", "Catching up")
for e in (jane1, kim, pal):
    req("GET", f"/img/{e['token']}.gif", hdr={"User-Agent": CHROME})
time.sleep(1.5)
with db() as c:
    c.execute("UPDATE emails SET replied_at=?, replied_by='Jane Doe', replied_addr='jane@stripe.com' WHERE id=?", (time.time() - 3600, jane2["id"]))
    c.execute("UPDATE emails SET created_at=created_at-86400 WHERE id IN (?,?)", (jane1["id"], sam["id"]))

# ---- People ----
s, _, b = get("/people", OWN)
check("People in the top bar", 'href="/people" class="on">People</a>' in b, "")
rows = re.findall(r'data-href="/people/([^"]+)"', b)
check("one row per person (addresses case-insensitive)", sorted(urllib.parse.unquote(r) for r in rows) == ["jane@stripe.com", "kim@figma.com", "pal@gmail.com", "sam@eu.stripe.com"], rows)
jane_row = b[b.index('data-href="/people/jane%40stripe.com"'):].split("</tr>")[0]
nums = re.findall(r'class="r num" data-sort="(\d+)"', jane_row)
check("Jane: 2 emails, 1 opened, 0 clicked, 1 replied", nums == ["2", "1", "0", "1"], nums)
check("name from her reply, company named", "Jane Doe" in jane_row and "Stripe" in jane_row, jane_row[:300])
check("search box and sortable columns", 'id="q"' in b and 'class="sort r"' in b and "Usually opens" in b, "")
check("page script is plain browser code (nothing the bundler adds, like __name)", "function usualWindow" in b and "__name" not in b, "")
check("metrics: people, companies, replied", re.search(r'People</div>\s*<div class="v">4<', b) and re.search(r'Companies</div>\s*<div class="v">2<', b), "")

# ---- Person ----
s, _, b = get("/people/jane%40stripe.com", OWN)
check("person page: name, address, company link", s == 200 and "<h1>Jane Doe</h1>" in b and 'href="/companies/stripe.com"' in b, s)
check("person page: Write opens Gmail compose to them", 'href="https://mail.google.com/mail/?view=cm&amp;fs=1&amp;to=jane%40stripe.com"' in b and ">Write</a>" in b, "")
check("person page: all their emails with statuses", f'data-href="/email/{jane1["id"]}"' in b and f'data-href="/email/{jane2["id"]}"' in b
      and 'class="st reply"' in b and 'class="st open">Opened' in b, "")
check("person page: open-time chart", 'id="hours"' in b and re.search(r'id="hours" data-opens="\d+"', b), "")
s, _, b = get("/people/JANE%40stripe.com", OWN)
check("person address is case-insensitive", s == 200 and "Jane Doe" in b, s)
s, _, _ = get("/people/nobody%40x.example", OWN)
check("someone you never emailed: 404", s == 404, s)

# ---- Companies ----
s, _, b = get("/companies", OWN)
check("Companies page under People", s == 200 and 'href="/people" class="on"' in b and 'href="/companies" class="on">Companies' in b, s)
check("grouped by domain, subdomains together", 'data-href="/companies/stripe.com"' in b and "eu.stripe.com" not in re.sub(r'data-q="[^"]*"', "", b), "")
check("webmail grouped as Personal addresses, last", 'data-href="/companies/personal"' in b and b.index("/companies/personal") > b.index("/companies/figma.com") > 0, "")
s, _, b = get("/companies/stripe.com", OWN)
check("company page lists its people", s == 200 and "<h1>Stripe</h1>" in b and 'data-href="/people/jane%40stripe.com"' in b and 'data-href="/people/sam%40eu.stripe.com"' in b and "kim%40figma.com" not in b, s)
s, _, b = get("/companies/personal", OWN)
check("personal addresses page", s == 200 and "Personal addresses" in b and "pal%40gmail.com" in b and "stripe" not in b.split("<main>")[1].split("<script>")[0].lower(), s)
s, _, _ = get("/companies/nowhere.example", OWN)
check("unknown company: 404", s == 404, s)

# ---- privacy between accounts ----
_, _, b = form("/admin/invite", {"note": "Lee"}, OWN)
inv = re.search(r"/signup\?code=([A-Za-z0-9_-]+)", b).group(1)
form(f"/signup?code={inv}", {"email": "lee@x.example", "name": "Lee", "password": "lee-password-1", "password2": "lee-password-1"}, "")
s, h, _ = form("/emailtrack", {"email": "lee@x.example", "password": "lee-password-1"}, "")
LEE = h["set-cookie"].split(";")[0]
s, _, b = get("/people", LEE)
check("another user sees nobody", "Nobody yet" in b and "jane" not in b, "")
s, _, _ = get("/people/jane%40stripe.com", LEE)
check("another user can't open your person page", s == 404, s)
s, _, _ = get("/companies/stripe.com", LEE)
check("...or your company page", s == 404, s)
s, _, _ = req("GET", "/people")
check("signed out: not found", s == 404, s)

# ---- replies around the dashboard ----
s, _, b = get("/", OWN)
check("dashboard: Replied status and filter", 'class="st reply"' in b and 'data-f="replied"' in b and 'data-status="replied"' in b, "")
s, _, b = get(f"/email/{jane2['id']}", OWN)
check("email page: who replied and when, recipient links to their page", "Jane Doe replied" in b and 'href="/people/jane%40stripe.com"' in b and ">Replied</span>" in b, "")
s, _, b = get("/report", OWN)
check("report: replies and reply rate", re.search(r'Replied</div>\s*<div class="v">1<', b) and "reply rate" in b and "Coffee chat?" not in b.split("Replies")[-1] and "Following up" in b, "")
s, _, b = get("/settings", OWN)
check("settings: reply notifications", 'name="notify_reply" checked' in b, "")
s, _, b = req("GET", "/api/me", hdr=K)
check("extension gets the reply notification choice", json.loads(b)["notify"].get("reply") is True, b)
s, _, b = req("GET", "/privacy")
t = H.unescape(b)
check("privacy policy: only From and Date headers, never bodies", "From and Date headers" in t and "never their subject, body or attachments" in t, "")

# ---- follow-up reminders skip replied emails (scheduled job) ----
with db() as c:
    c.execute("UPDATE emails SET created_at=?, opens=0 WHERE id IN (?,?,?)", (time.time() - 50 * 3600, jane2["id"], sam["id"], kim["id"]))
    c.execute("DELETE FROM events")
    # Gmail "connected" (token can't be used here, so no reply checks can run): kim's email waits for one
    c.execute("UPDATE users SET gmail_token='sealed' WHERE email='owner@x.example'")
    c.execute("UPDATE emails SET gmail_msg='m-kim', gmail_label='sent' WHERE id=?", (kim["id"],))
req("GET", "/__scheduled?cron=*/5+*+*+*+*")
time.sleep(2.5)
with db() as c:
    fu = {r["email_id"] for r in c.execute("SELECT email_id FROM alerts WHERE kind='followup'")}
check("no follow-up reminder for the replied email", jane2["id"] not in fu, fu)
check("reminder as usual where replies can't be checked", sam["id"] in fu, fu)
check("reminder waits while a reply check is pending", kim["id"] not in fu, fu)

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
