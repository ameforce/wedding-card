CREATE TABLE IF NOT EXISTS invitation_media_uploads_v1 (
  media_id TEXT PRIMARY KEY REFERENCES invitation_media_sets_v2(id) ON DELETE CASCADE,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  started_at TEXT
);
