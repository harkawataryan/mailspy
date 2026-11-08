"""Attachment-style PDF tiles: thumbnails, email tagging, viewer, settings."""
import http.client, json, re, urllib.parse, struct, zlib

import os as _os
HOST, PORT = "127.0.0.1", int(_os.environ.get("MAILSPY_TEST_PORT", "8787"))
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

def png(w=4, h=3):
    raw = b"".join(b"\x00" + b"\xff\x00\x00" * w for _ in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")

s, h, _ = form("/emailtrack", {"email": "owner@x.example", "password": "correct-horse-battery"}, "")
OWN = h["set-cookie"].split(";")[0]
KEY = json.loads(req("POST", "/api/login", {"email": "owner@x.example", "password": "correct-horse-battery"})[2])["api_key"]
K = {"X-API-Key": KEY}

s, _, b = req("GET", "/api/me", hdr=K)
check("track_pdfs on by default, sent to the extension", json.loads(b).get("track_pdfs") is True, b)

pdf = b"%PDF-1.4\n%test\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF"
s, _, b = req("POST", "/api/docs", pdf, {**K, "Content-Type": "application/pdf", "X-Filename": "Chapter%203I%20(1).pdf"})
d = json.loads(b)
check("upload returns id, token and short URL", s == 200 and d["id"] and d["token"] and d["url"].endswith("/" + d["token"]), d)

s, _, b = req("GET", f"/d/{d['token']}/p.png")
check("no thumbnail yet: 404", s == 404, s)
s, _, b = req("POST", f"/api/docs/{d['id']}/thumb", png(), {**K, "Content-Type": "image/png"})
check("thumbnail upload", s == 200 and json.loads(b)["ok"], b)
s, h, b = req("GET", f"/d/{d['token']}/p.png")
check("thumbnail served as an image, cacheable", s == 200 and h.get("content-type") == "image/png" and b[:4] == b"\x89PNG" and "max-age" in h.get("cache-control", ""), (s, h.get("content-type")))
s, _, b = req("POST", f"/api/docs/{d['id']}/thumb", b"<svg onload=alert(1)>", {**K, "Content-Type": "image/png"})
check("non-image thumbnail refused", s == 400, b)
s, _, b = req("POST", f"/api/docs/{d['id']}/thumb", b"\xff\xd8\xff" + b"x" * (310 * 1024), {**K, "Content-Type": "image/jpeg"})
check("oversized thumbnail refused", s in (400, 413), s)
s, _, b = req("POST", f"/api/docs/{d['id']}/thumb", png())
check("thumbnail needs a key", s == 401, s)

# another user can't set it
_, _, b = form("/admin/invite", {"note": "Lee"}, OWN)
inv = re.search(rb"/signup\?code=([A-Za-z0-9_-]+)", b).group(1).decode()
form(f"/signup?code={inv}", {"email": "lee@x.example", "name": "Lee", "password": "lee-password-1", "password2": "lee-password-1"}, "")
LK = {"X-API-Key": json.loads(req("POST", "/api/login", {"email": "lee@x.example", "password": "lee-password-1"})[2])["api_key"]}
s, _, b = req("POST", f"/api/docs/{d['id']}/thumb", png(), {**LK, "Content-Type": "image/png"})
check("other user can't replace the thumbnail", s == 400, b)

# the tile, as the extension builds it, goes through Send
base = d["url"].rsplit("/", 1)[0]
tile = (f'<div class="mailspy-attachments"><table><tr><td><a href="{d["url"]}" target="_blank"><img src="{base}/d/{d["token"]}/p.png" width="180" height="120"></a></td></tr>'
        f'<tr><td><a href="{d["url"]}" target="_blank"><span>PDF</span>Chapter 3I (1).pdf</a></td></tr></table></div>')
s, _, b = req("POST", "/api/prepare", {"to": "prof@uni.example", "subject": "Chapter", "html": "<div>See attached</div>" + tile}, K)
p = json.loads(b)
links = re.findall(r'href="([^"]+)"', p["html"])
check("both tile links tagged with the recipient", links.count(f'{d["url"]}?r={p["token"]}') == 2, links)
check("thumbnail image left alone", f'src="{base}/d/{d["token"]}/p.png"' in p["html"], "")

# viewer looks like Gmail's preview, no branding
s, _, b = req("GET", f"/d/{d['token']}?r={p['token']}")
check("viewer: dark Gmail-style page, file name, no MailSpy", s == 200 and b"#3c3c3c" in b and b"Chapter 3I (1).pdf" in b and b"MailSpy" not in b and b'class="ic">PDF' in b, s)

# setting off
form("/settings", {"action": "prefs", "prefetch_seconds": "12", "notify_open": "on"}, OWN)
s, _, b = req("GET", "/api/me", hdr=K)
check("turning the setting off reaches the extension", json.loads(b).get("track_pdfs") is False, b)
s, _, b = req("GET", "/settings", hdr={"Cookie": OWN})
check("settings shows the switch", b'name="track_pdfs"' in b and b"Track PDFs I attach in Gmail" in b, "")

# deleting the doc removes the thumbnail
form(f"/docs/{d['id']}/delete", {}, OWN)
s, _, b = req("GET", f"/d/{d['token']}/p.png")
check("deleted doc: thumbnail gone", s == 404 or b"no longer available" in b, s)
print(f"\n{sum(results)}/{len(results)} passed")
import sys as _s
_s.exit(0 if all(results) else 1)
