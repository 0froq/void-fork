ALTER TABLE users ADD COLUMN billing_cycle_start TEXT NOT NULL DEFAULT (datetime('now'));
ALTER TABLE users ADD COLUMN suspended_reason TEXT DEFAULT NULL;
