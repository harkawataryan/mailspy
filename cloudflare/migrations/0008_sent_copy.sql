-- "Hide tracking from my own Sent copy" (src/sentcopy.js). The Worker adds this
-- column itself on first use (ensureGoogleSchema in src/google.js), so running
-- this file is optional; it's here for the record.
-- (gmail_msg, gmail_label and retry_json were added the same way, earlier.)

ALTER TABLE emails ADD COLUMN sent_clean TEXT;   -- NULL | work:… | copy:… | err:n | done | none | big | failed

-- events.flagged can now also be 'apple': an Apple Mail Privacy Protection
-- fetch, which may be automatic (src/tracking.js isAppleProxy). No change needed.
