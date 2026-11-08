-- Appearance preference per account: NULL or 'system' follows the device; 'light' or 'dark' forces it.
ALTER TABLE users ADD COLUMN theme TEXT;
