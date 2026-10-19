-- Curiosities join ideas and projects. SQLite can't widen a CHECK, so both
-- tables are rebuilt with the same rows.
CREATE TABLE thought_ideas_next (
  id TEXT PRIMARY KEY,
  thought_id TEXT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('idea', 'project', 'curious')),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  done_at TEXT,
  UNIQUE(thought_id, kind, text)
);
INSERT INTO thought_ideas_next(id, thought_id, kind, text, created_at, done_at) SELECT id, thought_id, kind, text, created_at, done_at FROM thought_ideas;
DROP TABLE thought_ideas;
ALTER TABLE thought_ideas_next RENAME TO thought_ideas;
CREATE INDEX ideas_by_kind ON thought_ideas(kind, created_at);
CREATE TABLE loose_ideas_next (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('idea', 'project', 'curious')),
  text TEXT NOT NULL,
  context_id TEXT REFERENCES thoughts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  done_at TEXT
);
INSERT INTO loose_ideas_next(id, kind, text, context_id, created_at, done_at) SELECT id, kind, text, context_id, created_at, done_at FROM loose_ideas;
DROP TABLE loose_ideas;
ALTER TABLE loose_ideas_next RENAME TO loose_ideas;
CREATE INDEX loose_ideas_by_kind ON loose_ideas(kind, created_at);
-- Re-read every note once so any "/curious" or "/hm" lines already written
-- are picked up; existing ideas and their done marks are kept.
DELETE FROM thought_idea_index;
