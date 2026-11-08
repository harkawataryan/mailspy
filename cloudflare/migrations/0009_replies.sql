-- Replies, spotted in the sent message's Gmail thread (src/replies.js).
-- The Worker adds these columns itself on first use (ensureGoogleSchema in
-- src/google.js), so running this file is optional.

ALTER TABLE emails ADD COLUMN replied_at REAL;      -- when the first reply arrived; NULL = no reply seen
ALTER TABLE emails ADD COLUMN replied_by TEXT;      -- who replied: their name, or their address
ALTER TABLE emails ADD COLUMN replied_addr TEXT;    -- who replied: their address
ALTER TABLE emails ADD COLUMN reply_thread TEXT;    -- Gmail thread id of the sent message (cache)
ALTER TABLE emails ADD COLUMN reply_checked REAL;   -- last time the thread was checked
