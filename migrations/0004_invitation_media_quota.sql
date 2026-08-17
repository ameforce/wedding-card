CREATE TABLE IF NOT EXISTS invitation_media_sets (
  id TEXT PRIMARY KEY,
  slot TEXT NOT NULL CHECK (length(slot) BETWEEN 1 AND 40),
  total_bytes INTEGER NOT NULL CHECK (total_bytes BETWEEN 1 AND 31457280),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'stored')),
  created_at TEXT NOT NULL,
  stored_at TEXT
);

CREATE INDEX IF NOT EXISTS invitation_media_sets_status_idx
  ON invitation_media_sets (status, created_at DESC);
