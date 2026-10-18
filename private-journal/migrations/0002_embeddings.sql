CREATE TABLE embeddings (
  thought_id TEXT PRIMARY KEY REFERENCES thoughts(id) ON DELETE CASCADE,
  body_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  vectors BLOB NOT NULL,
  chunks INTEGER NOT NULL,
  dimensions INTEGER NOT NULL
);
CREATE TRIGGER embeddings_invalidate AFTER UPDATE OF body ON thoughts BEGIN
  DELETE FROM embeddings WHERE thought_id = new.id;
END;
