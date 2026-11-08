#!/usr/bin/env python3
"""
MailSpy - a self-hosted, Mailsuite-style email tracker.

Zero dependencies (Python 3.10+ standard library only).

What it does
  * Injects an invisible 1x1 tracking pixel into every email you send.
  * Rewrites every link so clicks are logged before redirecting.
  * Logs opens/clicks (time, IP, user agent, which link) in SQLite.
  * Serves a dashboard at /  and a compose/send page at /compose.
  * Can send through any SMTP server (Gmail with an App Password works).

Run:   python tracker.py
Then:  open http://localhost:8025
"""

import base64
import csv
import getpass
import hashlib
import hmac
import html
import io
import json
import os
import re
import secrets
import smtplib
import sqlite3
import sys
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime
from email.message import EmailMessage
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# --------------------------------------------------------------------------
# Configuration (config.json in the data dir, overridden by MAILSPY_* env vars)
# --------------------------------------------------------------------------
HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("MAILSPY_DATA_DIR") or HERE
os.makedirs(DATA_DIR, exist_ok=True)
CONFIG_PATH = os.path.join(DATA_DIR, "config.json")
DB_PATH = os.path.join(DATA_DIR, "tracker.db")

DEFAULTS = {
    "port": 8025,
    # Address to listen on. Use 127.0.0.1 behind a reverse proxy (Caddy/nginx)
    # so the app is only reachable through HTTPS.
    "bind": "0.0.0.0",
    # Public URL recipients can reach. Must be reachable from the internet
    # for tracking to work. No trailing slash.
    "base_url": "http://localhost:8025",
    # Secret-ish path where the dashboard login lives. Every other non-tracking
    # URL returns a plain 404 to anyone who is not signed in.
    "login_path": "/emailtrack",
    "smtp_host": "smtp.gmail.com",
    "smtp_port": 587,
    "smtp_user": "",
    "smtp_pass": "",
    "from_name": "",
    "from_email": "",
    # IPs whose opens/clicks are ignored (e.g. your own) - comma separated
    "ignore_ips": "",
    # --- accuracy (false-open prevention) ---
    # Opens/clicks that arrive within this many seconds of sending are treated
    # as automated (your own compose window, Apple Mail Privacy Protection
    # fetching at delivery, link scanners) and are not counted.
    "prefetch_window": 12,
    # --- alerts ---
    "spike_count": 3,        # >= this many opens within spike_window -> "spike"
    "spike_window": 600,     # seconds
    "revival_days": 7,       # reopen after this many quiet days -> "revived"
    "followup_hours": 48,    # not opened within this many hours -> reminder
    "email_alerts": "",      # address to email on each open; blank = off
    # --- integration ---
    # API key the Chrome extension / scripts send as X-API-Key. Auto-generated.
    "api_key": "",
    # Look up country/city for each event via a free GeoIP service (needs
    # outbound internet from the server). Off by default for privacy/speed.
    "geoip": False,
    # --- auth (managed by `python tracker.py set-password`; don't edit) ---
    "password_hash": "",
    "session_secret": "",
}

SECRET_KEYS = ("smtp_pass", "password_hash", "session_secret")


def load_config():
    cfg = dict(DEFAULTS)
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, encoding="utf-8") as f:
            cfg.update(json.load(f))
    for k in DEFAULTS:
        env = os.environ.get("MAILSPY_" + k.upper())
        if env is not None:
            cfg[k] = env
    cfg["port"] = int(cfg["port"])
    cfg["smtp_port"] = int(cfg["smtp_port"])
    for k in ("prefetch_window", "spike_count", "spike_window", "revival_days", "followup_hours"):
        cfg[k] = int(cfg[k])
    if not isinstance(cfg["geoip"], bool):
        cfg["geoip"] = str(cfg["geoip"]).lower() in ("1", "true", "yes", "on")
    cfg["base_url"] = str(cfg["base_url"]).rstrip("/")
    lp = "/" + str(cfg["login_path"] or "/emailtrack").strip("/")
    cfg["login_path"] = lp if lp != "/" else "/emailtrack"
    return cfg


CFG = load_config()


def save_config(updates):
    """Persist selected keys to config.json without touching the others."""
    data = {}
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            data = {}
    data = {**DEFAULTS, **data, **updates}
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    CFG.update(updates)


def ensure_secrets():
    """Generate the API key and session secret on first run."""
    updates = {}
    if not CFG.get("api_key"):
        updates["api_key"] = secrets.token_urlsafe(24)
    if not CFG.get("session_secret"):
        updates["session_secret"] = secrets.token_urlsafe(32)
    if updates:
        save_config(updates)


# --------------------------------------------------------------------------
# Password + session helpers
# --------------------------------------------------------------------------
PBKDF2_ITERATIONS = 310_000
SESSION_COOKIE = "sid"
SESSION_DAYS = 30


def hash_password(pw):
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return "pbkdf2_sha256${}${}${}".format(
        PBKDF2_ITERATIONS, base64.b64encode(salt).decode(), base64.b64encode(dk).decode())


def check_password(pw, stored):
    try:
        algo, iters, salt_b64, hash_b64 = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"),
                                 base64.b64decode(salt_b64), int(iters))
        return hmac.compare_digest(dk, base64.b64decode(hash_b64))
    except Exception:
        return False


def _sign(msg):
    return hmac.new(CFG["session_secret"].encode(), msg.encode(), hashlib.sha256).hexdigest()


def make_session():
    msg = f"{int(time.time()) + SESSION_DAYS * 86400}.{secrets.token_urlsafe(8)}"
    return f"{msg}.{_sign(msg)}"


def valid_session(value):
    try:
        exp, nonce, sig = value.split(".")
        return int(exp) > time.time() and hmac.compare_digest(sig, _sign(f"{exp}.{nonce}"))
    except Exception:
        return False


# Simple in-memory login throttle: 10 failures per IP per 15 minutes.
LOGIN_FAILS = {}
LOGIN_LOCK = threading.Lock()


def login_blocked(ip):
    with LOGIN_LOCK:
        recent = [t for t in LOGIN_FAILS.get(ip, []) if t > time.time() - 900]
        LOGIN_FAILS[ip] = recent
        return len(recent) >= 10


def note_login_failure(ip):
    with LOGIN_LOCK:
        LOGIN_FAILS.setdefault(ip, []).append(time.time())


def cli_set_password():
    pw = getpass.getpass("New dashboard password: ")
    if len(pw) < 10:
        sys.exit("Use at least 10 characters.")
    if getpass.getpass("Repeat it: ") != pw:
        sys.exit("Passwords did not match.")
    # Rotating the session secret signs out every existing session.
    save_config({"password_hash": hash_password(pw),
                 "session_secret": secrets.token_urlsafe(32)})
    print(f"Password saved to {CONFIG_PATH}. Restart the server for it to take effect.")

# --------------------------------------------------------------------------
# Database
# --------------------------------------------------------------------------
DB_LOCK = threading.Lock()


def db():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS emails (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                token TEXT UNIQUE NOT NULL,
                to_addr TEXT NOT NULL,
                subject TEXT NOT NULL,
                created_at REAL NOT NULL,
                sent INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS links (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email_id INTEGER NOT NULL,
                token TEXT UNIQUE NOT NULL,
                url TEXT NOT NULL,
                FOREIGN KEY(email_id) REFERENCES emails(id)
            );
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email_id INTEGER NOT NULL,
                kind TEXT NOT NULL,          -- 'open' or 'click'
                link_id INTEGER,
                ip TEXT,
                user_agent TEXT,
                ts REAL NOT NULL,
                FOREIGN KEY(email_id) REFERENCES emails(id)
            );
            CREATE INDEX IF NOT EXISTS idx_events_email ON events(email_id);
            CREATE TABLE IF NOT EXISTS templates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                subject TEXT NOT NULL,
                body TEXT NOT NULL,
                fmt TEXT NOT NULL DEFAULT 'text',
                created_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS campaigns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                created_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS alerts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email_id INTEGER,
                kind TEXT NOT NULL,          -- open, click, spike, revived, followup
                message TEXT NOT NULL,
                ts REAL NOT NULL,
                seen INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS self_views (
                email_id INTEGER NOT NULL,
                ts REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS outbox (
                email_id INTEGER PRIMARY KEY,
                to_addr TEXT NOT NULL,
                subject TEXT NOT NULL,
                html TEXT NOT NULL,
                text TEXT NOT NULL
            );
            """
        )
        # --- lightweight migrations (add columns if upgrading an old db) ---
        def addcol(table, col, decl):
            cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
            if col not in cols:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")
        addcol("emails", "to_name", "TEXT")
        addcol("emails", "campaign_id", "INTEGER")
        addcol("emails", "scheduled_at", "REAL")
        addcol("emails", "sent_at", "REAL")
        addcol("events", "geo", "TEXT")
        addcol("events", "is_bot", "INTEGER NOT NULL DEFAULT 0")
        addcol("events", "flagged", "TEXT")   # 'prefetch' / 'scanner' / NULL


# --------------------------------------------------------------------------
# Tracking helpers
# --------------------------------------------------------------------------
PIXEL_GIF = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")
HREF_RE = re.compile(r"""(<a\b[^>]*?\bhref\s*=\s*)(["'])(.*?)\2""", re.I | re.S)
URL_RE = re.compile(r"(?<![\"'=>])\b(https?://[^\s<>\"']+)")


def new_token(n=12):
    return secrets.token_urlsafe(n)


def classify_agent(ua):
    ua = (ua or "").lower()
    if "googleimageproxy" in ua:
        return "Gmail"
    if "yahoomailproxy" in ua or "yahoo" in ua:
        return "Yahoo"
    if "outlook" in ua or "microsoft office" in ua or "msie" in ua:
        return "Outlook"
    if "iphone" in ua or "ipad" in ua:
        return "iPhone/iPad"
    if "mac os x" in ua or "macintosh" in ua:
        return "Mac"
    if "android" in ua:
        return "Android"
    if "windows" in ua:
        return "Windows"
    if "linux" in ua:
        return "Linux"
    if not ua:
        return "Unknown"
    return "Other"


# User agents that belong to automated fetchers, not a person reading the mail.
# These are mail-security scanners and link pre-fetchers; counting them as human
# opens is the #1 cause of false positives in naive trackers.
SCANNER_HINTS = (
    "safelinks", "barracuda", "proofpoint", "mimecast", "microsoft-webdriver",
    "bitdefender", "googlebot", "bingbot", "slackbot", "whatsapp", "telegrambot",
    "facebookexternalhit", "twitterbot", "linkedinbot", "discordbot", "skypeuripreview",
    "curl", "wget", "python-requests", "httpclient", "go-http-client", "okhttp",
    "headlesschrome", "phantomjs", "amazonses", "sendgrid", "mailchimp",
)


def is_scanner(ua):
    ua = (ua or "").lower()
    return any(h in ua for h in SCANNER_HINTS)


# Gmail, Yahoo and Outlook.com load images through their own proxies when the
# recipient actually opens the message, so a proxy fetch IS a real open and is
# counted. Automated fetches are caught by timing instead: anything within
# prefetch_window of sending, clicks on several links within 2 seconds, and
# moments when you are viewing the message yourself (reported by the extension).
SELF_WINDOW = 20  # seconds after a self-view during which opens are yours
SELF_LOOKBACK = 10  # seconds before a self-view to re-flag as yours


def mark_self_view(token):
    """Called by the extension when YOU view a tracked message in Gmail.
    Flags opens just before/after as self-opens and drops their alerts."""
    now = time.time()
    with DB_LOCK, db() as conn:
        e = conn.execute("SELECT id FROM emails WHERE token=?", (token,)).fetchone()
        if not e:
            return False
        conn.execute("INSERT INTO self_views(email_id,ts) VALUES(?,?)", (e["id"], now))
        conn.execute("UPDATE events SET is_bot=1, flagged='self' "
                     "WHERE email_id=? AND kind='open' AND is_bot=0 AND ts>?",
                     (e["id"], now - SELF_LOOKBACK))
        conn.execute("DELETE FROM alerts WHERE email_id=? AND kind IN ('open','spike','revived') AND ts>?",
                     (e["id"], now - SELF_LOOKBACK))
    return True


def geo_lookup(ip):
    """Best-effort country/city for an IP. Returns '' on any failure.
    Skips private ranges. Only called when geoip is enabled."""
    if not CFG.get("geoip") or not ip:
        return ""
    if ip.startswith(("10.", "192.168.", "127.", "172.16.", "::1", "fc", "fd")):
        return "Local"
    try:
        req = urllib.request.Request(
            f"http://ip-api.com/json/{urllib.parse.quote(ip)}?fields=status,country,city",
            headers={"User-Agent": "MailSpy"})
        with urllib.request.urlopen(req, timeout=3) as r:
            d = json.load(r)
        if d.get("status") == "success":
            return ", ".join(x for x in (d.get("city"), d.get("country")) if x)
    except Exception:
        pass
    return ""


def create_tracked_email(to_addr, subject, body_html, plain_text=False,
                         to_name=None, campaign_id=None):
    """Store the email, inject pixel + tracked links. Returns (email_id, token, tracked_html)."""
    token = new_token()
    with DB_LOCK, db() as conn:
        cur = conn.execute(
            "INSERT INTO emails(token,to_addr,to_name,subject,created_at,campaign_id) "
            "VALUES(?,?,?,?,?,?)",
            (token, to_addr, to_name, subject, time.time(), campaign_id),
        )
        email_id = cur.lastrowid

        if plain_text:
            # Turn plain text into simple HTML with clickable links
            escaped = html.escape(body_html)
            escaped = URL_RE.sub(lambda m: f'<a href="{m.group(1)}">{m.group(1)}</a>', escaped)
            body_html = "<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:14px;white-space:pre-wrap\">" + escaped + "</div>"

        def rewrite(m):
            url = html.unescape(m.group(3).strip())  # Gmail encodes & as &amp;
            if not url.lower().startswith(("http://", "https://")):
                return m.group(0)  # mailto:, tel:, anchors untouched
            ltoken = new_token(9)
            conn.execute("INSERT INTO links(email_id,token,url) VALUES(?,?,?)", (email_id, ltoken, url))
            return f"{m.group(1)}{m.group(2)}{CFG['base_url']}/c/{ltoken}{m.group(2)}"

        tracked = HREF_RE.sub(rewrite, body_html)
        pixel = (
            f'<img src="{CFG["base_url"]}/t/{token}.gif" width="1" height="1" '
            f'alt="" style="display:block;width:1px;height:1px;border:0;opacity:0" />'
        )
        if re.search(r"</body>", tracked, re.I):
            tracked = re.sub(r"</body>", pixel + "</body>", tracked, count=1, flags=re.I)
        else:
            tracked += pixel
    return email_id, token, tracked


# --------------------------------------------------------------------------
# Real-time notification hub (Server-Sent Events) + alert queue
# --------------------------------------------------------------------------
class Hub:
    def __init__(self):
        self.clients = []
        self.lock = threading.Lock()

    def subscribe(self):
        q = []
        cv = threading.Condition()
        sub = (q, cv)
        with self.lock:
            self.clients.append(sub)
        return sub

    def unsubscribe(self, sub):
        with self.lock:
            if sub in self.clients:
                self.clients.remove(sub)

    def publish(self, event):
        payload = json.dumps(event)
        with self.lock:
            subs = list(self.clients)
        for q, cv in subs:
            with cv:
                q.append(payload)
                cv.notify()


HUB = Hub()


def add_alert(email_id, kind, message):
    with DB_LOCK, db() as conn:
        conn.execute("INSERT INTO alerts(email_id,kind,message,ts) VALUES(?,?,?,?)",
                     (email_id, kind, message, time.time()))
    HUB.publish({"type": "alert", "kind": kind, "email_id": email_id,
                 "message": message, "ts": time.time()})
    if CFG.get("email_alerts") and kind in ("open", "click", "spike", "revived"):
        threading.Thread(target=_email_alert, args=(message,), daemon=True).start()


def _email_alert(message):
    try:
        send_email(CFG["email_alerts"], "MailSpy alert", f"<p>{html.escape(message)}</p>", message)
    except Exception:
        pass


def record_event(email_id, kind, ip, ua, link_id=None):
    ignored = {s.strip() for s in str(CFG["ignore_ips"]).split(",") if s.strip()}
    if ip in ignored:
        return  # your own IP: self-open, never counted

    now = time.time()
    flagged = None
    is_bot = 0
    if is_scanner(ua):
        flagged, is_bot = "scanner", 1

    with DB_LOCK, db() as conn:
        e = conn.execute("SELECT to_addr,to_name,subject,created_at,sent_at FROM emails WHERE id=?",
                         (email_id,)).fetchone()
        if not e:
            return
        # Opens that land within the prefetch window after sending are almost
        # always the mail provider warming the image cache, not a human.
        sent_ref = e["sent_at"] or e["created_at"]
        if not is_bot and (now - sent_ref) < CFG["prefetch_window"]:
            # Right after sending: your own compose window, Apple Mail Privacy
            # Protection fetching on delivery, or a link scanner at delivery.
            flagged, is_bot = ("prefetch", 1) if kind == "open" else ("scanner", 1)
        if not is_bot and kind == "open":
            # You are looking at this message yourself right now (extension ping).
            if conn.execute("SELECT 1 FROM self_views WHERE email_id=? AND ts>?",
                            (email_id, now - SELF_WINDOW)).fetchone():
                flagged, is_bot = "self", 1
        if not is_bot and kind == "click":
            # Security scanners "click" every link in a message within a second
            # or two. A burst across different links = scanner, not a person.
            burst = conn.execute(
                "SELECT id FROM events WHERE email_id=? AND kind='click' AND link_id!=? AND ts>?",
                (email_id, link_id, now - 2)).fetchall()
            if burst:
                flagged, is_bot = "scanner", 1
                conn.execute(f"UPDATE events SET is_bot=1, flagged='scanner' WHERE id IN "
                             f"({','.join(str(r['id']) for r in burst)})")
                conn.execute("DELETE FROM alerts WHERE email_id=? AND kind='click' AND ts>?",
                             (email_id, now - 3))
        # De-duplicate truly identical opens fired within 2s (a client re-requesting
        # the same image). Match IP *and* user agent so a real recipient open is
        # never collapsed into a proxy/scanner hit that happens to share an IP.
        if kind == "open":
            dup = conn.execute(
                "SELECT 1 FROM events WHERE email_id=? AND kind='open' AND ip=? AND user_agent=? AND ts>?",
                (email_id, ip, ua, now - 2)).fetchone()
            if dup:
                return
        geo = geo_lookup(ip)
        conn.execute(
            "INSERT INTO events(email_id,kind,link_id,ip,user_agent,ts,geo,is_bot,flagged) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            (email_id, kind, link_id, ip, ua, now, geo, is_bot, flagged))
        # counts for alert logic (genuine human events only)
        genuine_opens = conn.execute(
            "SELECT COUNT(*) c, MIN(ts) first, MAX(ts) last FROM events "
            "WHERE email_id=? AND kind='open' AND is_bot=0", (email_id,)).fetchone()

    who = e["to_name"] or e["to_addr"]
    # Live feed event (always, so the dashboard shows prefetch too, labelled)
    HUB.publish({"type": "event", "kind": kind, "email_id": email_id, "to": e["to_addr"],
                 "subject": e["subject"], "geo": geo, "bot": bool(is_bot),
                 "flagged": flagged, "ts": now})
    if is_bot:
        return  # don't fire human-facing alerts for bots/prefetch

    if kind == "click":
        add_alert(email_id, "click", f'{who} clicked a link in "{e["subject"]}"')
        return

    # Genuine open alerts + spike / revival detection
    if genuine_opens["c"] == 1:
        add_alert(email_id, "open", f'{who} opened "{e["subject"]}"'
                  + (f" from {geo}" if geo else ""))
    else:
        add_alert(email_id, "open", f'{who} reopened "{e["subject"]}" ({genuine_opens["c"]} opens)')
    # revival: a quiet gap then a reopen
    prev = genuine_opens["last"]  # == now; check the one before
    with db() as conn:
        before = conn.execute(
            "SELECT ts FROM events WHERE email_id=? AND kind='open' AND is_bot=0 AND ts<? "
            "ORDER BY ts DESC LIMIT 1", (email_id, now)).fetchone()
    if before and (now - before["ts"]) > CFG["revival_days"] * 86400:
        add_alert(email_id, "revived",
                  f'Revived: {who} reopened "{e["subject"]}" after {int((now-before["ts"])//86400)} days')
    # spike: many opens in a short window
    with db() as conn:
        recent = conn.execute(
            "SELECT COUNT(*) c FROM events WHERE email_id=? AND kind='open' AND is_bot=0 AND ts>?",
            (email_id, now - CFG["spike_window"])).fetchone()["c"]
    if recent == CFG["spike_count"]:
        add_alert(email_id, "spike",
                  f'Open spike: {who} opened "{e["subject"]}" {recent}x in {CFG["spike_window"]//60} min')


def send_email(to_addr, subject, tracked_html, text_fallback):
    if not CFG["smtp_user"] or not CFG["smtp_pass"]:
        raise RuntimeError("SMTP not configured: set smtp_user / smtp_pass in config.json")
    msg = EmailMessage()
    from_email = CFG["from_email"] or CFG["smtp_user"]
    msg["From"] = f'{CFG["from_name"]} <{from_email}>' if CFG["from_name"] else from_email
    msg["To"] = to_addr
    msg["Subject"] = subject
    msg.set_content(text_fallback or "This email is best viewed in an HTML-capable client.")
    msg.add_alternative(tracked_html, subtype="html")
    if CFG["smtp_port"] == 465:
        with smtplib.SMTP_SSL(CFG["smtp_host"], CFG["smtp_port"], timeout=30) as s:
            s.login(CFG["smtp_user"], CFG["smtp_pass"])
            s.send_message(msg)
    else:
        with smtplib.SMTP(CFG["smtp_host"], CFG["smtp_port"], timeout=30) as s:
            s.ehlo()
            s.starttls()
            s.login(CFG["smtp_user"], CFG["smtp_pass"])
            s.send_message(msg)


def mark_sent(email_id):
    with DB_LOCK, db() as conn:
        conn.execute("UPDATE emails SET sent=1, sent_at=? WHERE id=?", (time.time(), email_id))


def merge_fields(text, row):
    """Replace {{name}} / {{company}} etc. with CSV row values (mail merge)."""
    def sub(m):
        return str(row.get(m.group(1).strip(), m.group(0)))
    return re.sub(r"\{\{\s*([\w ]+?)\s*\}\}", sub, text or "")


def send_campaign(name, rows, subject_tpl, body_tpl, fmt):
    """One tracked, personalised copy per recipient. rows: list of dicts with
    at least an 'email' key. Returns (campaign_id, sent, errors)."""
    with DB_LOCK, db() as conn:
        cid = conn.execute("INSERT INTO campaigns(name,created_at) VALUES(?,?)",
                           (name, time.time())).lastrowid
    sent, errors = 0, []
    for row in rows:
        addr = (row.get("email") or row.get("to") or "").strip()
        if not addr:
            continue
        subj = merge_fields(subject_tpl, row)
        body = merge_fields(body_tpl, row)
        eid, _, tracked = create_tracked_email(
            addr, subj, body, plain_text=(fmt == "text"),
            to_name=row.get("name"), campaign_id=cid)
        try:
            send_email(addr, subj, tracked, body if fmt == "text" else re.sub("<[^>]+>", "", body))
            mark_sent(eid)
            sent += 1
        except Exception as ex:  # noqa
            errors.append(f"{addr}: {ex}")
            with DB_LOCK, db() as conn:
                conn.execute("DELETE FROM links WHERE email_id=?", (eid,))
                conn.execute("DELETE FROM emails WHERE id=?", (eid,))
    return cid, sent, errors


# --------------------------------------------------------------------------
# Queries for the dashboard
# --------------------------------------------------------------------------
def list_emails():
    with db() as conn:
        return conn.execute(
            """
            SELECT e.*,
              (SELECT COUNT(*) FROM events v WHERE v.email_id=e.id AND v.kind='open'  AND v.is_bot=0) AS opens,
              (SELECT COUNT(*) FROM events v WHERE v.email_id=e.id AND v.kind='click' AND v.is_bot=0) AS clicks,
              (SELECT MAX(ts)  FROM events v WHERE v.email_id=e.id AND v.kind='open'  AND v.is_bot=0) AS last_open,
              (SELECT MIN(ts)  FROM events v WHERE v.email_id=e.id AND v.kind='open'  AND v.is_bot=0) AS first_open
            FROM emails e ORDER BY e.created_at DESC
            """
        ).fetchall()


def get_email(email_id):
    with db() as conn:
        e = conn.execute("SELECT * FROM emails WHERE id=?", (email_id,)).fetchone()
        if not e:
            return None, [], []
        links = conn.execute(
            """SELECT l.*, (SELECT COUNT(*) FROM events v WHERE v.link_id=l.id) AS clicks
               FROM links l WHERE l.email_id=? ORDER BY l.id""",
            (email_id,),
        ).fetchall()
        events = conn.execute(
            """SELECT v.*, l.url FROM events v LEFT JOIN links l ON l.id=v.link_id
               WHERE v.email_id=? ORDER BY v.ts DESC""",
            (email_id,),
        ).fetchall()
        return e, links, events


def list_activity(limit=50, include_bots=True):
    """Most recent opens/clicks across all emails (for the Latest Activity feed)."""
    where = "" if include_bots else "WHERE v.is_bot=0"
    with db() as conn:
        return conn.execute(
            f"""SELECT v.id, v.kind, v.ts, v.user_agent, v.geo, v.is_bot, v.flagged,
                   e.id AS email_id, e.to_addr, e.to_name, e.subject, l.url
               FROM events v JOIN emails e ON e.id=v.email_id LEFT JOIN links l ON l.id=v.link_id
               {where}
               ORDER BY v.ts DESC LIMIT ?""",
            (limit,),
        ).fetchall()


def list_alerts(limit=50):
    with db() as conn:
        return conn.execute("SELECT * FROM alerts ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()


def due_followups():
    """Emails sent > followup_hours ago with zero genuine opens and no reminder yet."""
    cutoff = time.time() - CFG["followup_hours"] * 3600
    with db() as conn:
        rows = conn.execute(
            """SELECT e.id, e.to_addr, e.to_name, e.subject FROM emails e
               WHERE e.sent=1 AND COALESCE(e.sent_at,e.created_at) < ?
                 AND NOT EXISTS (SELECT 1 FROM events v WHERE v.email_id=e.id AND v.kind='open' AND v.is_bot=0)
                 AND NOT EXISTS (SELECT 1 FROM alerts a WHERE a.email_id=e.id AND a.kind='followup')""",
            (cutoff,)).fetchall()
    return rows


def followup_worker():
    """Background loop: emit follow-up reminders and process scheduled sends."""
    while True:
        try:
            for e in due_followups():
                who = e["to_name"] or e["to_addr"]
                add_alert(e["id"], "followup",
                          f'No open yet: "{e["subject"]}" to {who} after {CFG["followup_hours"]}h — time to follow up')
            # scheduled sends whose time has arrived
            now = time.time()
            with db() as conn:
                due = conn.execute(
                    "SELECT id FROM emails WHERE sent=0 AND scheduled_at IS NOT NULL AND scheduled_at<=?",
                    (now,)).fetchall()
            for r in due:
                _send_scheduled(r["id"])
        except Exception as ex:  # noqa
            sys.stderr.write(f"followup_worker: {ex}\n")
        time.sleep(60)


def _send_scheduled(email_id):
    with db() as conn:
        o = conn.execute("SELECT * FROM outbox WHERE email_id=?", (email_id,)).fetchone()
    if not o:
        return
    try:
        send_email(o["to_addr"], o["subject"], o["html"], o["text"])
        mark_sent(email_id)
        with DB_LOCK, db() as conn:
            conn.execute("DELETE FROM outbox WHERE email_id=?", (email_id,))
        add_alert(email_id, "sent", f'Scheduled email "{o["subject"]}" sent to {o["to_addr"]}')
    except Exception as ex:  # noqa
        sys.stderr.write(f"scheduled send {email_id} failed: {ex}\n")


def schedule_tracked(to_addr, subject, tracked_html, text, when_ts, email_id):
    with DB_LOCK, db() as conn:
        conn.execute("UPDATE emails SET scheduled_at=? WHERE id=?", (when_ts, email_id))
        conn.execute("INSERT OR REPLACE INTO outbox(email_id,to_addr,subject,html,text) "
                     "VALUES(?,?,?,?,?)", (email_id, to_addr, subject, tracked_html, text))


# --------------------------------------------------------------------------
# HTML rendering
# --------------------------------------------------------------------------
def fmt_ts(ts):
    if not ts:
        return "—"
    return datetime.fromtimestamp(ts).strftime("%b %d, %Y %H:%M:%S")


def ago(ts):
    if not ts:
        return "never"
    d = int(time.time() - ts)
    if d < 60:
        return f"{d}s ago"
    if d < 3600:
        return f"{d // 60}m ago"
    if d < 86400:
        return f"{d // 3600}h ago"
    return f"{d // 86400}d ago"


def esc(s):
    return html.escape(str(s if s is not None else ""))


STYLE = """
<style>
  :root { --bg:#f6f7f9; --card:#ffffff; --line:#e6e8ec; --fg:#1f2937; --muted:#6b7280;
          --accent:#0b7a4b; --mint:#3ddc97; --mint-bg:#e9fbf2; --ok:#0b7a4b; --warn:#b45309; --bad:#b91c1c; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; }
  header { display:flex; align-items:center; gap:22px; padding:12px 24px;
           border-bottom:1px solid var(--line); background:var(--card); }
  header .logo { display:flex; align-items:center; gap:6px; font-size:19px; font-weight:800; letter-spacing:-.3px; color:#111; text-decoration:none; }
  header .logo .chk { color:var(--mint); font-weight:900; letter-spacing:-3px; }
  header nav a { color:var(--muted); text-decoration:none; font-weight:600; margin-right:16px; }
  header nav a.active, header nav a:hover { color:#111; }
  header .btn { margin-left:auto; }
  .gear { color:var(--muted); font-size:18px; text-decoration:none; }
  main { max-width:1100px; margin:0 auto; padding:24px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px 20px; margin-bottom:18px; }
  h2, h3 { margin:0 0 10px; font-weight:700; }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:10px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.5px; }
  tr:last-child td { border-bottom:0; }
  a { color:var(--accent); }
  .pill { display:inline-block; padding:2px 9px; border-radius:999px; font-size:12px; font-weight:700; }
  .pill.ok { background:var(--mint-bg); color:var(--ok); }
  .pill.muted { background:#eef0f3; color:var(--muted); }
  .pill.warn { background:#fff4e5; color:var(--warn); }
  .pill.dark { background:#111; color:#fff; }
  .muted { color:var(--muted); }
  .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin-bottom:18px; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .stat .n { font-size:26px; font-weight:800; color:#111; }
  .stat .l { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.5px; }
  label { display:block; color:var(--muted); font-size:12px; margin:12px 0 4px; text-transform:uppercase; letter-spacing:.5px; }
  input[type=text], input[type=email], textarea, select {
    width:100%; background:#fff; color:var(--fg); border:1px solid #d1d5db;
    border-radius:8px; padding:10px 12px; font:inherit; }
  input:focus, textarea:focus, select:focus { outline:2px solid var(--mint); border-color:var(--mint); }
  textarea { min-height:220px; resize:vertical; font-family:inherit; }
  button, .btn { background:var(--accent); color:#fff; border:0; border-radius:8px; padding:10px 18px;
    font:inherit; font-weight:700; cursor:pointer; text-decoration:none; display:inline-block; }
  button.secondary, .btn.secondary { background:var(--mint); color:#0b3d27; }
  .row { display:flex; gap:14px; }
  .row > * { flex:1; }
  .notice { padding:12px 14px; border-radius:8px; margin-bottom:16px; }
  .notice.ok { background:var(--mint-bg); color:var(--ok); border:1px solid #b9f0d6; }
  .notice.bad { background:#fdecec; color:var(--bad); border:1px solid #f5c2c2; }
  .notice.warn { background:#fff4e5; color:var(--warn); border:1px solid #fcd9a8; }
  code { background:#f0f2f5; padding:2px 6px; border-radius:5px; font-size:12.5px; }
  pre { background:#f0f2f5; padding:12px; border-radius:8px; overflow:auto; font-size:12.5px; }
  .small { font-size:12px; }
  /* Mailsuite-style activity feed */
  .feed { list-style:none; margin:0; padding:0; }
  .feed li { display:flex; gap:12px; padding:12px 4px; border-bottom:1px solid var(--line); align-items:flex-start; }
  .feed li:last-child { border-bottom:0; }
  .feed .ico { width:18px; height:18px; flex:none; margin-top:2px; color:var(--muted); }
  .feed .ico.click { color:var(--accent); }
  .feed .who { font-weight:700; color:#111; }
  .feed .what { color:#111; }
  .feed .sub { color:var(--muted); font-size:13px; margin-top:2px; }
  .feed .sub a { color:var(--muted); text-decoration:none; }
  .feed .sub a:hover { text-decoration:underline; }
  .feed-head { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
  .feed-head h2 { margin:0; font-size:18px; }
  .bell { color:var(--muted); }
  .plan { display:flex; align-items:center; justify-content:space-between; }
  .plan .l { color:var(--muted); font-size:12.5px; margin-top:4px; }
  .two { display:grid; grid-template-columns:420px 1fr; gap:18px; align-items:start; }
  @media (max-width:900px) { .two { grid-template-columns:1fr; } .stats { grid-template-columns:repeat(2,1fr); } }
</style>
"""

EYE_SVG = ('<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
           'stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/>'
           '<circle cx="12" cy="12" r="3"/></svg>')
CLICK_SVG = ('<svg class="ico click" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
             'stroke-linecap="round" stroke-linejoin="round"><path d="M9 11.5 4 3l8.5 5-3.4 1.1L9 11.5z" '
             'transform="translate(3 3) scale(1.3)"/><path d="M14 14l5 5"/></svg>')
BELL_SVG = ('<svg class="bell" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
            'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>'
            '<path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>')


def render_feed(items):
    """Mailsuite-style 'Latest Activity' list."""
    if not items:
        return '<p class="muted">No activity yet. Opens and clicks will show up here.</p>'
    out = '<ul class="feed" id="feed">'
    for v in items:
        out += feed_item_html(v)
    return out + "</ul>"


def feed_item_html(v):
    who = v["to_name"] or v["to_addr"] if hasattr(v, "keys") else v.get("to")
    subject = v["subject"]
    email_id = v["email_id"]
    kind = v["kind"]
    flagged = v["flagged"] if hasattr(v, "keys") and "flagged" in v.keys() else v.get("flagged")
    geo = (v["geo"] if hasattr(v, "keys") and "geo" in v.keys() else v.get("geo")) or ""
    if kind == "open":
        ico, what = EYE_SVG, "opened your email"
    else:
        ico, what = CLICK_SVG, "clicked a link in your email"
    tag = ""
    if flagged == "prefetch":
        what = "— loaded right after sending"
        tag = ' <span class="pill muted" style="font-size:10px">not counted</span>'
    elif flagged == "scanner":
        what = "— fetched by a security scanner"
        tag = ' <span class="pill muted" style="font-size:10px">bot</span>'
    elif flagged == "self":
        what = "— viewed by you"
        tag = ' <span class="pill muted" style="font-size:10px">not counted</span>'
    extra = " · ".join(x for x in (ago(v["ts"]), geo) if x)
    return (f'<li>{ico}<div><div><span class="who">{esc(who)}</span> '
            f'<span class="what">{what}</span>{tag}</div>'
            f'<div class="sub"><a href="/email/{email_id}">{esc(subject)}</a> · {esc(extra)}</div></div></li>')


def page(title, body, active=""):
    nav = ""
    for href, name in (("/", "Dashboard"), ("/compose", "Compose"),
                       ("/campaign", "Campaigns"), ("/report", "Report")):
        cls = ' class="active"' if active == name else ""
        nav += f'<a href="{href}"{cls}>{name}</a>'
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>{esc(title)} · MailSpy</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
{STYLE}</head><body>
<header><a class="logo" href="/"><span class="chk">&#10003;&#10003;</span>MailSpy</a><nav>{nav}</nav>
<a class="btn secondary" href="/compose">&#9998;&nbsp; New tracked email</a>
<a class="gear" href="/settings" title="Settings">&#9881;</a>
<a class="gear" style="font-size:13px" href="/logout">Log out</a></header>
<main>{body}</main></body></html>"""


def render_login(error=""):
    if not CFG.get("password_hash"):
        inner = ('<p>No password is set yet, so sign-in is disabled.</p>'
                 '<p class="muted">On the server, run:</p>'
                 '<pre>python3 tracker.py set-password</pre>'
                 '<p class="muted">then restart the service.</p>')
    else:
        err = f'<div class="notice bad">{esc(error)}</div>' if error else ""
        inner = f"""{err}<form method="post" action="{esc(CFG['login_path'])}">
          <label>Password</label>
          <input type="password" name="password" autofocus required autocomplete="current-password"
                 style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font:inherit">
          <div style="margin-top:14px"><button type="submit">Sign in</button></div></form>"""
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>Sign in</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
{STYLE}</head><body><main style="max-width:380px;margin-top:10vh">
<div class="card"><div style="font-size:19px;font-weight:800;margin-bottom:12px">
<span style="color:#3ddc97;letter-spacing:-3px">&#10003;&#10003;</span> Sign in</div>{inner}</div>
</main></body></html>"""


def render_settings():
    rows = ""
    for k in DEFAULTS:
        v = CFG[k]
        if k in SECRET_KEYS and v:
            v = "•" * 12
        rows += f"<tr><td><code>{esc(k)}</code></td><td>{esc(v) or '<span class=muted>(not set)</span>'}</td></tr>"
    body = f"""<div class="card"><h2>Settings</h2>
    <p class="muted">Edit <code>{esc(CONFIG_PATH)}</code> (or set <code>MAILSPY_*</code> env vars) and restart the server.</p>
    <table><tr><th>Key</th><th>Value</th></tr>{rows}</table></div>"""
    return page("Settings", body)


def render_dashboard(msg=None):
    emails = list_emails()
    total = len(emails)
    opened = sum(1 for e in emails if e["opens"])
    total_opens = sum(e["opens"] for e in emails)
    total_clicks = sum(e["clicks"] for e in emails)
    warn = ""
    if "localhost" in CFG["base_url"] or "127.0.0.1" in CFG["base_url"]:
        warn = ('<div class="notice warn"><b>Heads up:</b> base_url is <code>' + esc(CFG["base_url"]) +
                '</code>. Recipients can\'t reach that, so opens won\'t register. Expose this server publicly '
                '(ngrok / cloudflared / a VPS) and set <code>base_url</code> in config.json.</div>')
    rows = ""
    for e in emails:
        status = ('<span class="pill ok">Opened</span>' if e["opens"]
                  else '<span class="pill muted">Not opened</span>')
        rows += f"""<tr>
          <td><a href="/email/{e['id']}"><b>{esc(e['subject'])}</b></a><br><span class="muted small">to {esc(e['to_addr'])}</span></td>
          <td>{status}</td>
          <td><b>{e['opens']}</b></td>
          <td><b>{e['clicks']}</b></td>
          <td class="small">{esc(ago(e['last_open']))}<br><span class="muted">{esc(fmt_ts(e['last_open']))}</span></td>
        </tr>"""
    if not rows:
        rows = '<tr><td colspan="5" class="muted">No tracked emails yet. <a href="/compose">Compose one</a>.</td></tr>'
    feed = render_feed(list_activity(30))
    body = f"""{warn}{msg or ''}
    <div class="two">
      <div>
        <div class="card plan">
          <div><span class="pill dark">SELF-HOSTED</span><div class="l">Unlimited tracking, no plan limits</div></div>
          <div style="text-align:right"><a class="btn" href="/compose">Compose</a></div>
        </div>
        <div class="card">
          <div class="feed-head">{BELL_SVG}<h2>Latest Activity</h2></div>
          {feed}
        </div>
      </div>
      <div>
        <div class="stats">
          <div class="stat"><div class="n">{total}</div><div class="l">Emails sent</div></div>
          <div class="stat"><div class="n">{opened}<span class="muted" style="font-size:14px"> / {total}</span></div><div class="l">Opened</div></div>
          <div class="stat"><div class="n">{total_opens}</div><div class="l">Total opens</div></div>
          <div class="stat"><div class="n">{total_clicks}</div><div class="l">Link clicks</div></div>
        </div>
        <div class="card"><h3>Sent emails</h3><table>
          <tr><th>Email</th><th>Status</th><th>Opens</th><th>Clicks</th><th>Last open</th></tr>
          {rows}</table></div>
      </div>
    </div>
    <div id="toast" style="position:fixed;right:18px;bottom:18px;display:flex;flex-direction:column;gap:8px;z-index:50"></div>
    <script>
    // Ask once for desktop notification permission
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
    function toast(msg) {{
      var box = document.getElementById("toast");
      var el = document.createElement("div");
      el.textContent = msg;
      el.style.cssText = "background:#111;color:#fff;padding:10px 14px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.25);font-size:13px;max-width:320px";
      box.appendChild(el);
      setTimeout(function(){{ el.style.opacity=0; el.style.transition="opacity .4s"; }}, 6000);
      setTimeout(function(){{ el.remove(); }}, 6600);
    }}
    try {{
      var es = new EventSource("/events");
      es.onmessage = function(e) {{
        var d = JSON.parse(e.data);
        if (d.type === "alert") {{
          toast(d.message);
          if ("Notification" in window && Notification.permission === "granted")
            new Notification("MailSpy", {{ body: d.message }});
        }}
        if (d.type === "event" && !d.bot) {{
          // refresh counts without a full reload flash
          clearTimeout(window.__r); window.__r = setTimeout(function(){{ location.reload(); }}, 1500);
        }}
      }};
    }} catch (err) {{ setTimeout(function(){{ location.reload(); }}, 15000); }}
    </script>"""
    return page("Dashboard", body, "Dashboard")


def render_email(email_id):
    e, links, events = get_email(email_id)
    if not e:
        return page("Not found", "<div class='card'>Email not found.</div>")
    opens = [v for v in events if v["kind"] == "open" and not v["is_bot"]]
    clicks = [v for v in events if v["kind"] == "click" and not v["is_bot"]]
    bot_hits = [v for v in events if v["is_bot"]]
    link_rows = "".join(
        f"<tr><td><a href='{esc(l['url'])}' target='_blank'>{esc(l['url'])}</a></td><td><b>{l['clicks']}</b></td>"
        f"<td class='small muted'><code>{esc(CFG['base_url'])}/c/{esc(l['token'])}</code></td></tr>"
        for l in links
    ) or "<tr><td colspan='3' class='muted'>No links in this email.</td></tr>"
    ev_rows = ""
    for v in events:
        if v["kind"] == "open":
            kind = '<span class="pill ok">Open</span>'
        else:
            kind = '<span class="pill warn">Click</span>'
        if v["flagged"] == "prefetch":
            kind = '<span class="pill muted">Prefetch</span>'
        elif v["flagged"] == "scanner":
            kind = '<span class="pill muted">Scanner</span>'
        elif v["flagged"] == "self":
            kind = '<span class="pill muted">You</span>'
        target = f"<br><span class='small'><a href='{esc(v['url'])}' target='_blank'>{esc(v['url'])}</a></span>" if v["url"] else ""
        ev_rows += (f"<tr><td class='small'>{esc(fmt_ts(v['ts']))}<br><span class='muted'>{esc(ago(v['ts']))}</span></td>"
                    f"<td>{kind}{target}</td><td>{esc(classify_agent(v['user_agent']))}</td>"
                    f"<td class='small'>{esc(v['geo'] or '—')}</td>"
                    f"<td class='small'><code>{esc(v['ip'])}</code></td></tr>")
    if not ev_rows:
        ev_rows = "<tr><td colspan='5' class='muted'>No activity yet.</td></tr>"
    bot_note = (f'<p class="muted small">{len(bot_hits)} automated hit(s) '
                f'(your own views, delivery-time fetches, security scanners) were detected and excluded from the counts above.</p>'
                if bot_hits else "")
    sent_ref = e["sent_at"] or e["created_at"]
    body = f"""
    <p><a href="/">&larr; Back</a></p>
    <div class="card">
      <h2 style="margin:0 0 4px">{esc(e['subject'])}</h2>
      <div class="muted">To {esc((e['to_name'] + ' <' + e['to_addr'] + '>') if e['to_name'] else e['to_addr'])} · sent {esc(fmt_ts(sent_ref))}</div>
    </div>
    <div class="stats">
      <div class="stat"><div class="n">{len(opens)}</div><div class="l">Genuine opens</div></div>
      <div class="stat"><div class="n">{len(clicks)}</div><div class="l">Clicks</div></div>
      <div class="stat"><div class="n small" style="font-size:15px">{esc(fmt_ts(opens[-1]['ts']) if opens else '—')}</div><div class="l">First open</div></div>
      <div class="stat"><div class="n small" style="font-size:15px">{esc(fmt_ts(opens[0]['ts']) if opens else '—')}</div><div class="l">Last open</div></div>
    </div>
    <div class="card"><h3 style="margin-top:0">Links</h3>
      <table><tr><th>Destination</th><th>Clicks</th><th>Tracked URL</th></tr>{link_rows}</table></div>
    <div class="card"><h3 style="margin-top:0">Activity</h3>
      <table><tr><th>When</th><th>Event</th><th>Client</th><th>Location</th><th>IP</th></tr>{ev_rows}</table>
      {bot_note}</div>
    <script>
    try {{ var es=new EventSource("/events"); es.onmessage=function(e){{ var d=JSON.parse(e.data);
      if(d.email_id=={email_id}) setTimeout(function(){{location.reload();}},1200); }}; }}
    catch(x){{ setTimeout(function(){{location.reload();}},15000); }}
    </script>"""
    return page(e["subject"], body)


def render_compose(notice="", form=None, result_html=None):
    form = form or {}
    smtp_ok = bool(CFG["smtp_user"] and CFG["smtp_pass"])
    smtp_note = "" if smtp_ok else (
        '<div class="notice warn">SMTP isn\'t configured, so <b>Send</b> is disabled. '
        'Fill in <code>smtp_user</code> / <code>smtp_pass</code> in config.json (for Gmail, use an '
        '<a href="https://myaccount.google.com/apppasswords" target="_blank">App Password</a>). '
        'You can still use <b>Generate tracked HTML</b> and paste it into another mail tool.</div>')
    result = ""
    if result_html:
        result = f"""<div class="card"><h3 style="margin-top:0">Tracked HTML (copy into your mail client's HTML/source editor)</h3>
        <pre id="out">{esc(result_html)}</pre>
        <button class="secondary" onclick="navigator.clipboard.writeText(document.getElementById('out').textContent)">Copy</button></div>"""
    body = f"""{notice}{smtp_note}{result}
    <form method="post" action="/send" class="card">
      <div class="row">
        <div><label>To</label><input type="email" name="to" required value="{esc(form.get('to',''))}" placeholder="someone@example.com"></div>
        <div><label>Subject</label><input type="text" name="subject" required value="{esc(form.get('subject',''))}"></div>
      </div>
      <label>Body format</label>
      <select name="fmt">
        <option value="text" {'selected' if form.get('fmt','text')=='text' else ''}>Plain text (links auto-detected)</option>
        <option value="html" {'selected' if form.get('fmt')=='html' else ''}>HTML</option>
      </select>
      <label>Body</label>
      <textarea name="body" placeholder="Hi there,&#10;&#10;Here's the doc: https://example.com/doc&#10;&#10;Thanks!">{esc(form.get('body',''))}</textarea>
      <div class="row">
        <div><label>Recipient name (optional)</label><input type="text" name="to_name" value="{esc(form.get('to_name',''))}" placeholder="Jane Doe"></div>
        <div><label>Schedule send (optional)</label><input type="text" name="schedule" value="{esc(form.get('schedule',''))}" placeholder="2026-11-08 09:00 or +2h"></div>
      </div>
      <div style="margin-top:16px;display:flex;gap:10px">
        <button type="submit" name="action" value="send" {'' if smtp_ok else 'disabled style="opacity:.4;cursor:not-allowed"'}>Send tracked email</button>
        <button type="submit" name="action" value="schedule" {'' if smtp_ok else 'disabled style="opacity:.4;cursor:not-allowed"'} class="secondary">Schedule</button>
        <button type="submit" name="action" value="preview" class="secondary">Generate tracked HTML only</button>
      </div>
    </form>
    <p class="muted small">Every link becomes <code>{esc(CFG['base_url'])}/c/&lt;id&gt;</code> and an invisible pixel
    <code>{esc(CFG['base_url'])}/t/&lt;id&gt;.gif</code> is appended. Schedule accepts an absolute
    <code>YYYY-MM-DD HH:MM</code> or a relative <code>+30m</code> / <code>+2h</code> / <code>+1d</code>.</p>"""
    return page("Compose", body, "Compose")


def parse_when(s):
    """Parse '+30m' / '+2h' / '+1d' or 'YYYY-MM-DD HH:MM' -> epoch, or None."""
    s = (s or "").strip()
    if not s:
        return None
    m = re.fullmatch(r"\+(\d+)\s*([mhd])", s)
    if m:
        n = int(m.group(1))
        return time.time() + n * {"m": 60, "h": 3600, "d": 86400}[m.group(2)]
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M"):
        try:
            return datetime.strptime(s, fmt).timestamp()
        except ValueError:
            continue
    return None


def render_campaign(notice="", form=None):
    form = form or {}
    smtp_ok = bool(CFG["smtp_user"] and CFG["smtp_pass"])
    with db() as conn:
        camps = conn.execute(
            """SELECT c.*,
               (SELECT COUNT(*) FROM emails e WHERE e.campaign_id=c.id) AS n,
               (SELECT COUNT(DISTINCT e.id) FROM emails e JOIN events v ON v.email_id=e.id
                  WHERE e.campaign_id=c.id AND v.kind='open' AND v.is_bot=0) AS opened,
               (SELECT COUNT(DISTINCT e.id) FROM emails e JOIN events v ON v.email_id=e.id
                  WHERE e.campaign_id=c.id AND v.kind='click' AND v.is_bot=0) AS clicked
               FROM campaigns c ORDER BY c.created_at DESC""").fetchall()
    crows = "".join(
        f"<tr><td><b>{esc(c['name'])}</b><br><span class='muted small'>{esc(fmt_ts(c['created_at']))}</span></td>"
        f"<td>{c['n']}</td><td>{c['opened']} ({round(100*c['opened']/c['n']) if c['n'] else 0}%)</td>"
        f"<td>{c['clicked']}</td></tr>"
        for c in camps) or "<tr><td colspan='4' class='muted'>No campaigns yet.</td></tr>"
    smtp_note = "" if smtp_ok else '<div class="notice warn">SMTP must be configured to send a campaign.</div>'
    body = f"""{notice}{smtp_note}
    <div class="card"><h2>Mail merge campaign</h2>
    <p class="muted">Paste CSV with a header row including an <code>email</code> column (and optional
    <code>name</code>, <code>company</code>, ...). Use <code>{{{{name}}}}</code>, <code>{{{{company}}}}</code>
    placeholders in the subject and body. One individually tracked copy is sent per recipient.</p>
    <form method="post" action="/campaign">
      <label>Campaign name</label><input type="text" name="name" required value="{esc(form.get('name',''))}" placeholder="November outreach">
      <label>Subject (supports {{{{placeholders}}}})</label>
      <input type="text" name="subject" required value="{esc(form.get('subject',''))}" placeholder="Quick question, {{{{name}}}}">
      <label>Body format</label>
      <select name="fmt"><option value="text">Plain text</option><option value="html">HTML</option></select>
      <label>Body</label>
      <textarea name="body" placeholder="Hi {{{{name}}}},&#10;&#10;I saw {{{{company}}}} is hiring...">{esc(form.get('body',''))}</textarea>
      <label>Recipients CSV</label>
      <textarea name="csv" style="min-height:140px;font-family:monospace" placeholder="email,name,company&#10;jane@acme.com,Jane,Acme&#10;sam@globex.com,Sam,Globex">{esc(form.get('csv',''))}</textarea>
      <div style="margin-top:14px"><button type="submit" {'' if smtp_ok else 'disabled style=opacity:.4'}>Send campaign</button></div>
    </form></div>
    <div class="card"><h3>Campaigns</h3>
      <table><tr><th>Name</th><th>Recipients</th><th>Opened</th><th>Clicked</th></tr>{crows}</table></div>"""
    return page("Campaigns", body, "Campaigns")


def render_report():
    now = time.time()
    week = now - 7 * 86400
    with db() as conn:
        sent = conn.execute("SELECT COUNT(*) c FROM emails WHERE sent=1 AND COALESCE(sent_at,created_at)>=?", (week,)).fetchone()["c"]
        opened = conn.execute(
            """SELECT COUNT(DISTINCT email_id) c FROM events
               WHERE kind='open' AND is_bot=0 AND ts>=?""", (week,)).fetchone()["c"]
        clicks = conn.execute("SELECT COUNT(*) c FROM events WHERE kind='click' AND is_bot=0 AND ts>=?", (week,)).fetchone()["c"]
        top = conn.execute(
            """SELECT e.id, e.subject, e.to_addr,
                 COUNT(*) opens FROM events v JOIN emails e ON e.id=v.email_id
               WHERE v.kind='open' AND v.is_bot=0 AND v.ts>=?
               GROUP BY e.id ORDER BY opens DESC LIMIT 5""", (week,)).fetchall()
        bots = conn.execute("SELECT COUNT(*) c FROM events WHERE is_bot=1 AND ts>=?", (week,)).fetchone()["c"]
    rate = round(100 * opened / sent) if sent else 0
    trows = "".join(
        f"<tr><td><a href='/email/{t['id']}'>{esc(t['subject'])}</a><br><span class='muted small'>{esc(t['to_addr'])}</span></td>"
        f"<td><b>{t['opens']}</b></td></tr>" for t in top) or "<tr><td colspan='2' class='muted'>No opens this week.</td></tr>"
    body = f"""
    <div class="card"><h2>Weekly activity report</h2>
    <div class="muted">{esc(fmt_ts(week))} &ndash; {esc(fmt_ts(now))}</div></div>
    <div class="stats">
      <div class="stat"><div class="n">{sent}</div><div class="l">Sent</div></div>
      <div class="stat"><div class="n">{opened}</div><div class="l">Opened</div></div>
      <div class="stat"><div class="n">{rate}%</div><div class="l">Open rate</div></div>
      <div class="stat"><div class="n">{clicks}</div><div class="l">Clicks</div></div>
    </div>
    <div class="card"><h3>Most-opened this week</h3>
      <table><tr><th>Email</th><th>Opens</th></tr>{trows}</table></div>
    <p class="muted small">{bots} automated hit(s) filtered out this week. Set <code>email_alerts</code>
    in config.json to also receive alerts by email.</p>"""
    return page("Report", body, "Report")


# --------------------------------------------------------------------------
# HTTP server
# --------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "httpd"

    def version_string(self):
        return "httpd"

    def log_message(self, fmt, *args):  # quieter log
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # ---- helpers ----
    def client_ip(self):
        for h in ("X-Forwarded-For", "CF-Connecting-IP", "X-Real-IP"):
            v = self.headers.get(h)
            if v:
                return v.split(",")[0].strip()
        return self.client_address[0]

    def send_html(self, body, status=200):
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, obj, status=200):
        data = json.dumps(obj, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.cors()
        self.end_headers()
        self.wfile.write(data)

    def send_pixel(self):
        self.send_response(200)
        self.send_header("Content-Type", "image/gif")
        self.send_header("Content-Length", str(len(PIXEL_GIF)))
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0, private")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.end_headers()
        self.wfile.write(PIXEL_GIF)

    def redirect(self, url, status=302):
        self.send_response(status)
        self.send_header("Location", url)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def read_form(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n).decode("utf-8") if n else ""
        ctype = self.headers.get("Content-Type", "")
        if "application/json" in ctype:
            return json.loads(raw or "{}")
        return {k: v[0] for k, v in urllib.parse.parse_qs(raw, keep_blank_values=True).items()}

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-API-Key")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def api_ok(self):
        """Require the API key for /api/* (used by the Chrome extension)."""
        key = self.headers.get("X-API-Key") or urllib.parse.parse_qs(
            urllib.parse.urlparse(self.path).query).get("key", [""])[0]
        if CFG.get("api_key") and key == CFG["api_key"]:
            return True
        self.send_response(401)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"error":"invalid or missing X-API-Key"}')
        return False

    def stream_events(self):
        """Server-Sent Events: live open/click/alert stream for the dashboard."""
        sub = HUB.subscribe()
        q, cv = sub
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.cors()
            self.end_headers()
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            last_ping = time.time()
            while True:
                with cv:
                    cv.wait(timeout=15)
                    pending, q[:] = list(q), []
                for payload in pending:
                    self.wfile.write(f"data: {payload}\n\n".encode("utf-8"))
                self.wfile.flush()
                if time.time() - last_ping > 15:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    last_ping = time.time()
        except Exception:
            pass
        finally:
            HUB.unsubscribe(sub)

    def plain_404(self):
        body = b"Not Found"
        self.send_response(404)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authed(self):
        if not CFG.get("password_hash"):
            return False
        c = SimpleCookie()
        try:
            c.load(self.headers.get("Cookie", ""))
        except Exception:
            return False
        m = c.get(SESSION_COOKIE)
        return bool(m and valid_session(m.value))

    def set_session_cookie(self, value, max_age):
        secure = "; Secure" if CFG["base_url"].startswith("https://") else ""
        self.send_header("Set-Cookie", f"{SESSION_COOKIE}={value}; Path=/; HttpOnly; "
                                       f"SameSite=Lax; Max-Age={max_age}{secure}")

    def handle_login(self, form):
        ip = self.client_ip()
        if not CFG.get("password_hash"):
            return self.send_html(render_login())
        if login_blocked(ip):
            return self.send_html(render_login("Too many attempts. Try again in 15 minutes."), 429)
        if not check_password(form.get("password") or "", CFG["password_hash"]):
            note_login_failure(ip)
            time.sleep(0.5)
            return self.send_html(render_login("Wrong password."), 401)
        self.send_response(302)
        self.set_session_cookie(make_session(), SESSION_DAYS * 86400)
        self.send_header("Location", "/")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def logout(self):
        self.send_response(302)
        self.set_session_cookie("", 0)
        self.send_header("Location", CFG["login_path"])
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    # ---- routing ----
    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        ua = self.headers.get("User-Agent", "")

        # Tracking pixel: /t/<token>.gif
        m = re.fullmatch(r"/t/([A-Za-z0-9_\-]+)(?:\.gif|\.png)?", path)
        if m:
            with db() as conn:
                row = conn.execute("SELECT id FROM emails WHERE token=?", (m.group(1),)).fetchone()
            if row:
                record_event(row["id"], "open", self.client_ip(), ua)
            return self.send_pixel()  # always return a pixel, even for unknown tokens

        # Tracked link: /c/<token>
        m = re.fullmatch(r"/c/([A-Za-z0-9_\-]+)", path)
        if m:
            with db() as conn:
                row = conn.execute("SELECT id,email_id,url FROM links WHERE token=?", (m.group(1),)).fetchone()
            if not row:
                return self.plain_404()
            # Link scanners (Outlook SafeLinks etc.) often HEAD/GET links at delivery time;
            # we still log them but the dashboard shows the user agent so you can judge.
            record_event(row["email_id"], "click", self.client_ip(), ua, link_id=row["id"])
            # Also count a click as an implicit open if no open was ever recorded
            return self.redirect(row["url"])

        # ---- everything below is private ----
        if path == CFG["login_path"]:
            return self.redirect("/") if self.authed() else self.send_html(render_login())
        if path == "/logout":
            return self.logout()
        if path.startswith("/api/"):
            if not self.api_ok():
                return
        elif not self.authed():
            return self.plain_404()

        if path == "/":
            return self.send_html(render_dashboard())
        if path == "/compose":
            return self.send_html(render_compose())
        if path == "/campaign":
            return self.send_html(render_campaign())
        if path == "/report":
            return self.send_html(render_report())
        if path == "/settings":
            return self.send_html(render_settings())
        if path == "/events":
            return self.stream_events()
        if path == "/api/activity":
            return self.send_json([dict(r) for r in list_activity(100)])
        if path == "/api/alerts":
            return self.send_json([dict(r) for r in list_alerts(100)])
        m = re.fullmatch(r"/email/(\d+)", path)
        if m:
            return self.send_html(render_email(int(m.group(1))))
        if path == "/api/emails":
            return self.send_json([dict(r) for r in list_emails()])
        m = re.fullmatch(r"/api/emails/(\d+)", path)
        if m:
            e, links, events = get_email(int(m.group(1)))
            if not e:
                return self.send_json({"error": "not found"}, 404)
            return self.send_json({"email": dict(e), "links": [dict(l) for l in links],
                                   "events": [dict(v) for v in events]})
        if path == "/favicon.ico":
            return self.send_pixel()
        return self.plain_404()

    def do_HEAD(self):
        # Scanners sometimes HEAD links/images; answer without logging anything.
        path = urllib.parse.urlparse(self.path).path
        if path.startswith("/t/"):
            self.send_response(200)
            self.send_header("Content-Type", "image/gif")
            self.end_headers()
            return
        self.send_response(302 if path.startswith("/c/") else 404)
        self.end_headers()

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        form = self.read_form()

        if path == CFG["login_path"]:
            return self.handle_login(form)
        if path.startswith("/api/"):
            if not self.api_ok():
                return
        elif not self.authed():
            return self.plain_404()

        if path == "/send":
            to = (form.get("to") or "").strip()
            subject = (form.get("subject") or "").strip()
            body = form.get("body") or ""
            fmt = form.get("fmt") or "text"
            to_name = (form.get("to_name") or "").strip() or None
            action = form.get("action") or "send"
            if not to or not subject:
                return self.send_html(render_compose('<div class="notice bad">To and subject are required.</div>', form))
            text = body if fmt == "text" else re.sub("<[^>]+>", "", body)
            email_id, token, tracked = create_tracked_email(
                to, subject, body, plain_text=(fmt == "text"), to_name=to_name)
            if action == "preview":
                return self.send_html(render_compose(
                    f'<div class="notice ok">Tracked email #{email_id} created (not sent). '
                    f'Paste the HTML below into any mail client\'s HTML editor and send it to <b>{esc(to)}</b>.</div>',
                    form, result_html=tracked))
            if action == "schedule":
                when = parse_when(form.get("schedule"))
                if not when:
                    return self.send_html(render_compose(
                        '<div class="notice bad">Could not read the schedule time. Use '
                        '<code>YYYY-MM-DD HH:MM</code> or <code>+2h</code>.</div>', form))
                schedule_tracked(to, subject, tracked, text, when, email_id)
                return self.send_html(render_compose(
                    f'<div class="notice ok">Scheduled email #{email_id} to <b>{esc(to)}</b> for '
                    f'{esc(fmt_ts(when))}. It will send automatically.</div>'))
            try:
                send_email(to, subject, tracked, text)
                mark_sent(email_id)
            except Exception as ex:  # noqa
                with DB_LOCK, db() as conn:
                    conn.execute("DELETE FROM links WHERE email_id=?", (email_id,))
                    conn.execute("DELETE FROM emails WHERE id=?", (email_id,))
                return self.send_html(render_compose(f'<div class="notice bad">Send failed: {esc(ex)}</div>', form))
            return self.redirect(f"/email/{email_id}")

        if path == "/campaign":
            name = (form.get("name") or "").strip()
            subject = (form.get("subject") or "").strip()
            body = form.get("body") or ""
            fmt = form.get("fmt") or "text"
            csv_text = form.get("csv") or ""
            if not name or not subject or not csv_text.strip():
                return self.send_html(render_campaign('<div class="notice bad">Name, subject and CSV are required.</div>', form))
            try:
                rows = list(csv.DictReader(io.StringIO(csv_text.strip())))
                rows = [{(k or "").strip().lower(): (v or "").strip() for k, v in r.items()} for r in rows]
            except Exception as ex:  # noqa
                return self.send_html(render_campaign(f'<div class="notice bad">CSV error: {esc(ex)}</div>', form))
            if not rows:
                return self.send_html(render_campaign('<div class="notice bad">No recipient rows found.</div>', form))
            cid, sent, errors = send_campaign(name, rows, subject, body, fmt)
            note = f'<div class="notice ok">Campaign "{esc(name)}" sent to {sent} recipient(s).</div>'
            if errors:
                note += f'<div class="notice warn">{len(errors)} failed:<br>' + "<br>".join(esc(e) for e in errors[:10]) + "</div>"
            return self.send_html(render_campaign(note))

        # ---- JSON API (used by the Chrome extension) : requires X-API-Key ----
        if path == "/api/selfview":
            return self.send_json({"ok": mark_self_view(str(form.get("token", "")))})

        if path == "/api/prepare":
            email_id, token, tracked = create_tracked_email(
                form.get("to", ""), form.get("subject", "(no subject)"),
                form.get("html") or form.get("text", ""),
                plain_text=("html" not in form), to_name=form.get("to_name"))
            self.send_response(200)
            self.cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "id": email_id, "token": token, "html": tracked,
                "pixel": f"{CFG['base_url']}/t/{token}.gif"}).encode())
            return

        if path == "/api/send":
            email_id, token, tracked = create_tracked_email(
                form.get("to", ""), form.get("subject", "(no subject)"),
                form.get("html") or form.get("text", ""),
                plain_text=("html" not in form), to_name=form.get("to_name"))
            try:
                send_email(form.get("to", ""), form.get("subject", ""), tracked, form.get("text", ""))
                mark_sent(email_id)
            except Exception as ex:  # noqa
                return self.send_json({"error": str(ex)}, 500)
            self.send_response(200)
            self.cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"id": email_id, "ok": True}).encode())
            return

        return self.send_json({"error": "not found"}, 404)


def main():
    init_db()
    if not os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(DEFAULTS, f, indent=2)
        print(f"Created {CONFIG_PATH} - edit it to set base_url and SMTP credentials.")
    ensure_secrets()
    if not CFG.get("password_hash"):
        print("WARNING: no dashboard password set. Run `python tracker.py set-password` "
              "then restart. Until then the dashboard is locked.")
    threading.Thread(target=followup_worker, daemon=True).start()
    port = CFG["port"]
    srv = ThreadingHTTPServer((CFG["bind"], port), Handler)
    print(f"MailSpy listening on {CFG['bind']}:{port}   public base_url: {CFG['base_url']}")
    print(f"Dashboard login: {CFG['base_url']}{CFG['login_path']}")
    print(f"API key (for the Chrome extension): {CFG['api_key']}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "set-password":
        cli_set_password()
    else:
        main()
