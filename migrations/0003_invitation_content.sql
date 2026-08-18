CREATE TABLE IF NOT EXISTS invitation_revisions (
  id TEXT PRIMARY KEY,
  content_json TEXT NOT NULL CHECK (length(content_json) BETWEEN 2 AND 131072),
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  published_at TEXT
);

CREATE INDEX IF NOT EXISTS invitation_revisions_created_at_idx
  ON invitation_revisions (created_at DESC);

CREATE INDEX IF NOT EXISTS invitation_revisions_status_idx
  ON invitation_revisions (status, created_at DESC);

CREATE TABLE IF NOT EXISTS invitation_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  draft_revision_id TEXT,
  published_revision_id TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (draft_revision_id) REFERENCES invitation_revisions(id),
  FOREIGN KEY (published_revision_id) REFERENCES invitation_revisions(id)
);

INSERT OR IGNORE INTO invitation_state (
  singleton_id,
  draft_revision_id,
  published_revision_id,
  updated_at
) VALUES (1, NULL, NULL, '1970-01-01T00:00:00.000Z');
