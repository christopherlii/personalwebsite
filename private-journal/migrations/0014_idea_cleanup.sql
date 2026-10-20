-- An idea from a note can be crossed off the list without touching the note.
ALTER TABLE thought_ideas ADD COLUMN dismissed_at TEXT;
-- A standalone idea only links to a note that was being written within 30
-- minutes before it; older links pointed at whatever happened to be newest.
UPDATE loose_ideas SET context_id = NULL WHERE context_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM thoughts t WHERE t.id = loose_ideas.context_id
  AND (julianday(loose_ideas.created_at) - julianday(t.created_at)) BETWEEN 0 AND 30.0 / 1440
);
