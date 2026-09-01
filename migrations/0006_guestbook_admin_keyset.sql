CREATE INDEX IF NOT EXISTS guestbook_entries_admin_keyset_idx
  ON guestbook_entries (created_at DESC, id DESC);
