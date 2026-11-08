-- Gmail labels (Tracked/Unopened, Tracked/Opened, Tracked/Clicked), applied by
-- the user's own Google Apps Script. See src/labels.js.

ALTER TABLE emails ADD COLUMN gmail_thread TEXT;   -- Gmail thread id, once the script has found the sent message
ALTER TABLE emails ADD COLUMN label_state TEXT;    -- label last applied: unopened | opened | clicked | nomatch
ALTER TABLE users ADD COLUMN labels_sync_at REAL;  -- last time the script checked in
