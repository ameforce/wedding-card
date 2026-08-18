ALTER TABLE guestbook_entries
  ADD COLUMN auth_failure_count INTEGER NOT NULL DEFAULT 0
  CHECK (auth_failure_count BETWEEN 0 AND 5);

ALTER TABLE guestbook_entries
  ADD COLUMN auth_window_started_at_ms INTEGER NOT NULL DEFAULT 0
  CHECK (auth_window_started_at_ms >= 0);

ALTER TABLE guestbook_entries
  ADD COLUMN auth_locked_until_ms INTEGER NOT NULL DEFAULT 0
  CHECK (auth_locked_until_ms >= 0);
