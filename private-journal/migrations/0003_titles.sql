ALTER TABLE thoughts ADD COLUMN title TEXT NOT NULL DEFAULT '' CHECK(length(title) <= 160);
ALTER TABLE draft ADD COLUMN title TEXT NOT NULL DEFAULT '' CHECK(length(title) <= 160);

DROP TRIGGER thoughts_insert;
DROP TRIGGER thoughts_delete;
DROP TRIGGER thoughts_update;
DROP TABLE thoughts_fts;
CREATE VIRTUAL TABLE thoughts_fts USING fts5(title, body, content='thoughts', content_rowid='seq', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER thoughts_insert AFTER INSERT ON thoughts BEGIN
  INSERT INTO thoughts_fts(rowid, title, body) VALUES (new.seq, new.title, new.body);
END;
CREATE TRIGGER thoughts_delete AFTER DELETE ON thoughts BEGIN
  INSERT INTO thoughts_fts(thoughts_fts, rowid, title, body) VALUES ('delete', old.seq, old.title, old.body);
END;
CREATE TRIGGER thoughts_update AFTER UPDATE OF title, body ON thoughts BEGIN
  INSERT INTO thoughts_fts(thoughts_fts, rowid, title, body) VALUES ('delete', old.seq, old.title, old.body);
  INSERT INTO thoughts_fts(rowid, title, body) VALUES (new.seq, new.title, new.body);
END;
INSERT INTO thoughts_fts(thoughts_fts) VALUES ('rebuild');

DROP TRIGGER embeddings_invalidate;
CREATE TRIGGER embeddings_invalidate AFTER UPDATE OF title, body ON thoughts BEGIN
  DELETE FROM embeddings WHERE thought_id = new.id;
END;
DELETE FROM embeddings;
