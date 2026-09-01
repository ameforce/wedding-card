ALTER TABLE guestbook_entries
  ADD COLUMN message_search TEXT;

CREATE INDEX IF NOT EXISTS guestbook_entries_message_search_idx
  ON guestbook_entries (message_search);
