"""Emails dashboard: server-side search, status/date filters in the URL, pages, and CSV downloads (escaping, per-user)."""
import csv, glob, http.client, io, json, os, re, sqlite3, sys, time, urllib.parse, html as H

HOST, PORT = "127.0.0.1", int(os.environ.get("MAILSPY_TEST_PORT", "8787"))
DBFILE = [p for p in glob.glob(os.path.join(sys.argv[1], ".wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite"))
          if not p.endswith("metadata.sqlite")][0]
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
results = []
def check(name, cond, detail=""):
    results.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if not cond else ""))
def req(method, path, body=None, hdr=None):
    c = http.client.HTTPConnection(HOST, PORT, timeout=60); h = dict(hdr or {})
    if isinstance(body, dict): body = json.dumps(body); h.setdefault("Content-Type", "application/json")
    c.request(method, path, body=body, headers=h); r = c.getresponse()
    return r.status, {k.lower(): v for k, v in r.getheaders()}, r.read()
F = {"Content-Type": "application/x-www-form-urlencoded", "Origin": "null", "Sec-Fetch-Site": "same-origin"}
def form(path, data, ck): return req("POST", path, urllib.parse.urlencode(data), {**F, "Cookie": ck})
def db():
    c = sqlite3.connect(DBFILE, timeout=10); c.row_factory = sqlite3.Row; return c
def page(path, ck):
    s, h, b = req("GET", path, hdr={"Cookie": ck}); return s, H.unescape(b.decode("utf-8", "replace"))
def subjects(b): return re.findall(r'<div class="t1">(.*?)</div>', b, re.S)
def get_csv(path, ck):
    s, h, b = req("GET", path, hdr={"Cookie": ck})
    rows = list(csv.reader(io.StringIO(b.decode("utf-8-sig"), newline=""))) if s == 200 else []
    return s, h, b, rows
CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36"
DAY = 86400

s, h, _ = form("/emailtrack", {"email": "owner@x.example", "password": "correct-horse-battery"}, "")
OWN = h["set-cookie"].split(";")[0]
K = {"X-API-Key": json.loads(req("POST", "/api/login", {"email": "owner@x.example", "password": "correct-horse-battery"})[2])["api_key"]}
form("/settings", {"action": "prefs", "prefetch_seconds": "0", "track_all_links": "on"}, OWN)

def prep(to, subject, name=None, **extra):
    _, _, b = req("POST", "/api/prepare", {"to": to, "to_name": name, "subject": subject, "html": '<a href="https://example.com/x">x</a>', **extra}, K)
    return json.loads(b)

# The interesting ones first, so 105 newer emails push them off the first page.
jane = prep("jane@stripe.com", "Intro call", "Jane Doe")
nasty = prep("evil@acme.example", '=HYPERLINK("http://bad.example","Click"), "quoted", and more\nsecond line', '+Mallory, "Esq"')
old = prep("bob@figma.com", "Old follow-up", "Bob")
later = prep("later@x.example", "Scheduled thing", "Later", scheduled_at=time.time() + DAY)
uni = prep("zoe@exämple.com", "Café ☕ résumé", "Zoë")
with db() as c:
    c.execute("UPDATE emails SET created_at=? WHERE id=?", (time.time() - 45 * DAY, old["id"]))
    c.execute("UPDATE emails SET created_at=? WHERE id=?", (time.time() - 10 * DAY, uni["id"]))
# real opens and a click on Jane's email
req("GET", f"/img/{jane['token']}.gif", hdr={"User-Agent": CHROME})
time.sleep(2.5)
req("GET", f"/img/{jane['token']}.gif", hdr={"User-Agent": CHROME + " x"})
link = db().execute("SELECT token FROM links WHERE email_id=?", (jane["id"],)).fetchone()["token"]
req("GET", f"/c/{link}", hdr={"User-Agent": CHROME})
time.sleep(1.5)   # recorded after the response
e = db().execute("SELECT opens, clicks FROM emails WHERE id=?", (jane["id"],)).fetchone()
check("seed: Jane's email has 2 opens and a click", (e["opens"], e["clicks"]) == (2, 1), dict(e))
with db() as c:
    uid = c.execute("SELECT id FROM users WHERE email='owner@x.example'").fetchone()["id"]
    for i in range(105):
        c.execute("INSERT INTO emails(token,to_addr,subject,created_at,user_id) VALUES(?,?,?,?,?)",
                  (f"bulk{i}", f"p{i}@bulk.example", f"Bulk {i}", time.time(), uid))

# ---- dashboard ----
s, b = page("/", OWN)
check("first page: 100 newest, older ones not on it", s == 200 and len(subjects(b)) == 100 and "Intro call" not in subjects(b), len(subjects(b)))
check("count and pager", 'Sent<span class="count">110</span>' in b and "1–100 of 110" in b and 'href="/?page=2"' in b and "Newer" not in b, re.findall(r"\d+–\d+ of \d+", b))
s, b = page("/?page=2", OWN)
check("page 2 has the rest", len(subjects(b)) == 10 and "Intro call" in subjects(b) and "Newer" in b and "Older" not in b, subjects(b))
s, b = page("/?q=stripe", OWN)
check("search finds an email that isn't on the first page (by company domain)", subjects(b) == ["Intro call"] and 'value="stripe"' in b, subjects(b))
check("search: no pager when it fits", 'class="pager"' not in b)
check("search by name, any case", subjects(page("/?q=jane+DOE", OWN)[1]) == ["Intro call"])
check("search by address", subjects(page("/?q=bob%40figma", OWN)[1]) == ["Old follow-up"])
check("search by subject", subjects(page("/?q=caf%C3%A9", OWN)[1]) == ["Café ☕ résumé"])
check("search: % is literal", subjects(page("/?q=%25", OWN)[1]) == [])
s, b = page("/?q=nothing-like-this", OWN)
check("no match: message and clear link", "No emails match." in b and "Clear filters" in b and "Download CSV" not in b, s)
s, b = page("/?q=bulk", OWN)
check("search paginates too", "1–100 of 105" in b and len(subjects(b)) == 100 and 'href="/?q=bulk&page=2"' in b, re.findall(r"\d+–\d+ of \d+", b))

check("status: opened", subjects(page("/?status=opened", OWN)[1]) == ["Intro call"])
check("status: clicked", subjects(page("/?status=clicked", OWN)[1]) == ["Intro call"])
check("status: scheduled", subjects(page("/?status=scheduled", OWN)[1]) == ["Scheduled thing"])
# (the bulk emails have no "o" in them)
s, b = page("/?status=unopened&q=o", OWN)
check("status: not opened", len(subjects(b)) == 3 and "Old follow-up" in subjects(b) and "Café ☕ résumé" in subjects(b) and "Intro call" not in subjects(b), subjects(b))
check("status: not opened leaves out scheduled", subjects(page("/?status=unopened&q=later", OWN)[1]) == [])
s, b = page("/?days=7&q=o", OWN)
check("last 7 days", len(subjects(b)) == 2 and "Intro call" in subjects(b), subjects(b))
s, b = page("/?days=30&q=o", OWN)
check("last 30 days", len(subjects(b)) == 3 and "Café ☕ résumé" in subjects(b) and "Old follow-up" not in subjects(b), subjects(b))
check("last 90 days", "Old follow-up" in subjects(page("/?days=90&q=bob", OWN)[1]))
s, b = page("/?status=opened&days=7&q=stripe", OWN)
check("filters combine and are kept in the links", subjects(b) == ["Intro call"]
      and 'href="/?q=stripe&status=clicked&days=7"' in b and 'href="/?q=stripe&days=7"' in b
      and 'href="/emails.csv?q=stripe&status=opened&days=7"' in b
      and '<option value="7" selected>' in b and 'name="status" value="opened"' in b, re.findall(r'href="/\?[^"]*"', b)[:6])
s, b = page("/?status=bogus&days=12&page=abc", OWN)
check("bad values ignored", s == 200 and len(subjects(b)) == 100, s)
s, b = page("/?q=bulk&page=2", OWN)
check("pager keeps the search", 'href="/?q=bulk"' in b and len(subjects(b)) == 5, subjects(b)[:3])

# ---- CSV: emails ----
s, h, raw, rows = get_csv("/emails.csv", OWN)
check("emails CSV: download headers", s == 200 and h.get("content-type") == "text/csv; charset=utf-8"
      and re.fullmatch(r'attachment; filename="mailspy-emails-\d{4}-\d\d-\d\d\.csv"', h.get("content-disposition", "")) and "no-store" in h.get("cache-control", ""), h)
check("emails CSV: UTF-8 with BOM, CRLF", raw.startswith(b"\xef\xbb\xbf") and b"\r\n" in raw, raw[:10])
check("emails CSV: columns", rows and rows[0] == ["Sent (UTC)", "Recipient", "Name", "Subject", "Status", "Opens", "Clicks", "First open (UTC)", "Last open (UTC)"], rows[:1])
check("emails CSV: every email, not just one page", len(rows) == 111, len(rows))
r = {x[1]: x for x in rows[1:]}
j = r.get("jane@stripe.com", [])
check("emails CSV: Jane's row", j[2:7] == ["Jane Doe", "Intro call", "Opened", "2", "1"] and re.fullmatch(r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d", j[0]) and j[7] and j[8] and j[7] <= j[8], j)
n = r.get("evil@acme.example", [])
check("emails CSV: quotes, commas and newlines survive", n and n[3] == '\'=HYPERLINK("http://bad.example","Click"), "quoted", and more\nsecond line', n)
check("emails CSV: formula cells start with an apostrophe", n and n[2] == "'+Mallory, \"Esq\"" and n[3].startswith("'="), n[2:4])
check("emails CSV: raw bytes quoted properly", b'"\'=HYPERLINK(""http://bad.example"",""Click""), ""quoted"", and more\nsecond line"' in raw, raw[raw.find(b"evil"):][:120])
check("emails CSV: unicode", r.get("zoe@exämple.com", [None, None, None, None])[2:4] == ["Zoë", "Café ☕ résumé"], r.get("zoe@exämple.com"))
check("emails CSV: scheduled status", r.get("later@x.example", [""] * 5)[4] == "Scheduled")
s, h, raw, rows = get_csv("/emails.csv?q=stripe&status=opened&days=7", OWN)
check("emails CSV follows the current filters", [x[1] for x in rows[1:]] == ["jane@stripe.com"], rows)
check("emails CSV: empty view still has the header row", get_csv("/emails.csv?q=zzzz", OWN)[3] == [rows[0]])

# ---- CSV: one email ----
s, b = page(f"/email/{jane['id']}", OWN)
check("email page has a CSV link", f'href="/email/{jane["id"]}.csv"' in b, s)
s, h, raw, rows = get_csv(f"/email/{jane['id']}.csv", OWN)
check("email CSV: download", s == 200 and f'filename="mailspy-email-{jane["id"]}-' in h.get("content-disposition", "") and raw.startswith(b"\xef\xbb\xbf"), h)
kinds = sorted(x[1] for x in rows[1:])
check("email CSV: opens and the click", rows[0][:3] == ["Time (UTC)", "Event", "Counted"] and kinds == ["Click", "Open", "Open"]
      and all(x[2] == "Yes" for x in rows[1:]) and any(x[6] == "https://example.com/x" for x in rows[1:]) and all(x[4] == "Windows" for x in rows[1:]), rows)

# ---- CSV: documents and links ----
pdf = b"%PDF-1.4\n%test\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF"
d = json.loads(req("POST", "/api/docs", pdf, {**K, "Content-Type": "application/pdf", "X-Filename": "Offer, final.pdf"})[2])
form("/links", {"url": "https://example.com/cv", "label": "@risky, \"label\""}, OWN)
check("documents page has a CSV link", 'href="/docs.csv"' in page("/docs", OWN)[1])
check("links page has a CSV link", 'href="/links.csv"' in page("/links", OWN)[1])
s, h, raw, rows = get_csv("/docs.csv", OWN)
check("documents CSV", s == 200 and "mailspy-documents-" in h.get("content-disposition", "") and len(rows) == 2
      and rows[1][1] == "Offer, final.pdf" and rows[1][2] == str(len(pdf)) and rows[1][7].endswith("/" + d["token"]), rows)
s, h, raw, rows = get_csv("/links.csv", OWN)
check("links CSV (formula-guarded label)", s == 200 and "mailspy-links-" in h.get("content-disposition", "") and len(rows) == 2
      and rows[1][1] == "'@risky, \"label\"" and rows[1][2] == "https://example.com/cv" and rows[1][4] == "0", rows)

# ---- per-user ----
_, _, b = form("/admin/invite", {"note": "Lee"}, OWN)
inv = re.search(rb"/signup\?code=([A-Za-z0-9_-]+)", b).group(1).decode()
_, h, _ = form(f"/signup?code={inv}", {"email": "lee@x.example", "name": "Lee", "password": "lee-password-1", "password2": "lee-password-1"}, "")
LEE = h["set-cookie"].split(";")[0]
LK = {"X-API-Key": json.loads(req("POST", "/api/login", {"email": "lee@x.example", "password": "lee-password-1"})[2])["api_key"]}
_, _, b = req("POST", "/api/prepare", {"to": "sam@stripe.com", "subject": "Lee's own email", "html": "<p>x</p>"}, LK)
s, b = page("/?q=stripe", LEE)
check("other user: search only sees their own", subjects(b) == ["Lee's own email"], subjects(b))
s, b = page("/?status=opened", LEE)
check("other user: filters only see their own", subjects(b) == [] and "No emails match." in b, subjects(b))
s, h, raw, rows = get_csv("/emails.csv", LEE)
check("other user: emails CSV has only their row", [x[3] for x in rows[1:]] == ["Lee's own email"], rows)
check("other user: can't download my email's CSV", req("GET", f"/email/{jane['id']}.csv", hdr={"Cookie": LEE})[0] == 404)
check("other user: documents and links CSV empty", len(get_csv("/docs.csv", LEE)[3]) == 1 and len(get_csv("/links.csv", LEE)[3]) == 1)
s, h, raw, rows = get_csv("/emails.csv", OWN)
check("and I don't get theirs", "Lee's own email" not in [x[3] for x in rows[1:]] and len(rows) == 111, len(rows))

# ---- signed-in session only ----
for p in ["/emails.csv", f"/email/{jane['id']}.csv", "/docs.csv", "/links.csv"]:
    s1 = req("GET", p)[0]
    s2 = req("GET", p, hdr=K)[0]
    s3 = req("GET", p, hdr={"Cookie": "ms_session=forged"})[0]
    check(f"{p}: needs a session (no API key, no forged cookie)", s1 == 404 and s2 == 404 and s3 == 404, (s1, s2, s3))

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
