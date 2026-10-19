-- Ideas logged on their own (not as a line in a note). They live only in the
-- ideas list; context points at the note written just before, and survives
-- that note being deleted as a plain, unlinked idea.
CREATE TABLE loose_ideas (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('idea', 'project')),
  text TEXT NOT NULL,
  context_id TEXT REFERENCES thoughts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  done_at TEXT
);
CREATE INDEX loose_ideas_by_kind ON loose_ideas(kind, created_at);
