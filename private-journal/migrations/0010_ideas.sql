CREATE TABLE thought_ideas (
  id TEXT PRIMARY KEY,
  thought_id TEXT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('idea', 'project')),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  done_at TEXT,
  UNIQUE(thought_id, kind, text)
);
CREATE INDEX ideas_by_kind ON thought_ideas(kind, created_at);
CREATE TABLE thought_idea_index (
  thought_id TEXT PRIMARY KEY REFERENCES thoughts(id) ON DELETE CASCADE
);
-- Unlike tags, rows survive an edit so a written/started mark is kept; the
-- next index pass adds and removes only the lines that changed.
CREATE TRIGGER ideas_invalidate AFTER UPDATE OF body ON thoughts BEGIN
  DELETE FROM thought_idea_index WHERE thought_id = new.id;
END;
