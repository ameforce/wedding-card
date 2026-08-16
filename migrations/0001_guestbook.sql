CREATE TABLE IF NOT EXISTS guestbook_entries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 30),
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 500),
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS guestbook_entries_created_at_idx
  ON guestbook_entries (created_at DESC);
