-- Email templates. The Worker also creates this table itself on first use
-- (src/templates.js), so running this file is optional.

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
