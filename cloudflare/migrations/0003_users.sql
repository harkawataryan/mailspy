-- Multiple people: accounts, invite codes, and an owner on every email/alert.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT,
  password_hash TEXT NOT NULL,
  api_key       TEXT NOT NULL UNIQUE,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  note       TEXT,
  created_at REAL NOT NULL,
  used_by    INTEGER,
  used_at    REAL
);

ALTER TABLE emails ADD COLUMN user_id INTEGER;
ALTER TABLE alerts ADD COLUMN user_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_emails_user ON emails(user_id, id);
CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(user_id, id);
