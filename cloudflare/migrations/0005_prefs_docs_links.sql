-- Per-user settings, tracked PDFs and standalone tracked links.

ALTER TABLE users ADD COLUMN prefs TEXT;   -- JSON, see src/prefs.js

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
