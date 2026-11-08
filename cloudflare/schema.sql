-- MailSpy D1 schema. Safe to run more than once.

CREATE TABLE IF NOT EXISTS emails (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  token         TEXT UNIQUE NOT NULL,
  to_addr       TEXT NOT NULL,
  to_name       TEXT,
  subject       TEXT NOT NULL,
  created_at    REAL NOT NULL,
  -- running totals of genuine (human) events, kept in sync on every event
  opens         INTEGER NOT NULL DEFAULT 0,
  clicks        INTEGER NOT NULL DEFAULT 0,
  first_open    REAL,
  last_open     REAL,
  followup_done INTEGER NOT NULL DEFAULT 0,
  -- NULL = sent now; -1 = scheduled, time unknown; >0 = scheduled unix time
  scheduled_at  REAL,
  user_id       INTEGER,
  gmail_thread  TEXT,     -- Gmail thread id, found by the labels script
  label_state   TEXT      -- Gmail label last applied: unopened | opened | clicked | nomatch
);
CREATE INDEX IF NOT EXISTS idx_emails_followup ON emails(followup_done, opens, created_at);
CREATE INDEX IF NOT EXISTS idx_emails_user ON emails(user_id, id);

CREATE TABLE IF NOT EXISTS links (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id INTEGER NOT NULL,
  token    TEXT UNIQUE NOT NULL,
  url      TEXT NOT NULL,
  clicks   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_links_email ON links(email_id);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id   INTEGER NOT NULL,
  kind       TEXT NOT NULL,            -- 'open' or 'click'
  link_id    INTEGER,
  ip         TEXT,
  user_agent TEXT,
  geo        TEXT,
  ts         REAL NOT NULL,
  is_bot     INTEGER NOT NULL DEFAULT 0,
  flagged    TEXT                      -- 'prefetch' | 'scanner' | 'self' | NULL
);
CREATE INDEX IF NOT EXISTS idx_events_email ON events(email_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS alerts (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id INTEGER,
  kind     TEXT NOT NULL,              -- open | click | spike | revived | followup
  message  TEXT NOT NULL,
  ts       REAL NOT NULL,
  user_id  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(user_id, id);
CREATE INDEX IF NOT EXISTS idx_alerts_email ON alerts(email_id, ts);
CREATE INDEX IF NOT EXISTS idx_alerts_kind ON alerts(kind, id);

CREATE TABLE IF NOT EXISTS self_views (
  email_id INTEGER NOT NULL,
  ts       REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_self_views ON self_views(email_id, ts);

CREATE TABLE IF NOT EXISTS login_failures (
  ip TEXT NOT NULL,
  ts REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_failures ON login_failures(ip, ts);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT,
  password_hash TEXT NOT NULL,
  api_key       TEXT NOT NULL UNIQUE,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    REAL NOT NULL,
  theme         TEXT,           -- NULL/'system' | 'light' | 'dark'
  prefs         TEXT,           -- JSON settings, see src/prefs.js
  labels_sync_at REAL           -- last check-in from the Gmail labels script
);

CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  note       TEXT,
  created_at REAL NOT NULL,
  used_by    INTEGER,
  used_at    REAL
);

CREATE TABLE IF NOT EXISTS docs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  token      TEXT NOT NULL UNIQUE,
  filename   TEXT NOT NULL,
  size       INTEGER NOT NULL,
  pages      INTEGER,
  created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_docs_user ON docs(user_id, id);

CREATE TABLE IF NOT EXISTS doc_views (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id     INTEGER NOT NULL,
  email_id   INTEGER,                 -- which tracked email the link came from, if any
  ts         REAL NOT NULL,           -- first seen
  last_ts    REAL NOT NULL,           -- last heartbeat
  ip         TEXT,
  user_agent TEXT,
  geo        TEXT,
  is_self    INTEGER NOT NULL DEFAULT 0,
  seconds    INTEGER NOT NULL DEFAULT 0,
  pages_json TEXT NOT NULL DEFAULT '{}' -- {"1": 12, "2": 40}
);
CREATE INDEX IF NOT EXISTS idx_doc_views_doc ON doc_views(doc_id, ts);
CREATE INDEX IF NOT EXISTS idx_doc_views_ts ON doc_views(ts);

CREATE TABLE IF NOT EXISTS tlinks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  token      TEXT NOT NULL UNIQUE,
  url        TEXT NOT NULL,
  label      TEXT,
  created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tlinks_user ON tlinks(user_id, id);

CREATE TABLE IF NOT EXISTS tlink_clicks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tlink_id   INTEGER NOT NULL,
  ts         REAL NOT NULL,
  ip         TEXT,
  user_agent TEXT,
  geo        TEXT,
  is_bot     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tlink_clicks ON tlink_clicks(tlink_id, ts);
CREATE INDEX IF NOT EXISTS idx_tlink_clicks_ts ON tlink_clicks(ts);
CREATE TABLE IF NOT EXISTS templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  name        TEXT NOT NULL,
  subject     TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',     -- HTML, cleaned (src/templates.js cleanHtml)
  scope_type  TEXT NOT NULL DEFAULT 'any',  -- any | company | person
  scope_value TEXT NOT NULL DEFAULT '',     -- email domain or email address
  uses        INTEGER NOT NULL DEFAULT 0,
  created_at  REAL NOT NULL,
  updated_at  REAL NOT NULL,
  last_used   REAL
);
CREATE INDEX IF NOT EXISTS idx_templates_user ON templates(user_id, updated_at);
