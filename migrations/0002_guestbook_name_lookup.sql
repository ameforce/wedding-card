CREATE UNIQUE INDEX IF NOT EXISTS guestbook_entries_unique_name_idx
  ON guestbook_entries (name);
