-- Scheduled sends: when Gmail will actually send the email.
--   NULL  = sent immediately
--   -1    = scheduled, time not known yet
--   >0    = scheduled for this unix time
ALTER TABLE emails ADD COLUMN scheduled_at REAL;
