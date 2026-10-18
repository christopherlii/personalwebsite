CREATE TABLE reading (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL UNIQUE CHECK(length(url) <= 2048),
  title TEXT NOT NULL DEFAULT '' CHECK(length(title) <= 160),
  excerpt TEXT NOT NULL DEFAULT '' CHECK(length(excerpt) <= 8000),
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE reading_fts USING fts5(title, excerpt, url, content='reading', content_rowid='seq', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER reading_insert AFTER INSERT ON reading BEGIN
  INSERT INTO reading_fts(rowid,title,excerpt,url) VALUES(new.seq,new.title,new.excerpt,new.url);
END;
CREATE TRIGGER reading_delete AFTER DELETE ON reading BEGIN
  INSERT INTO reading_fts(reading_fts,rowid,title,excerpt,url) VALUES('delete',old.seq,old.title,old.excerpt,old.url);
END;
CREATE TABLE reading_embeddings (
  reading_id TEXT PRIMARY KEY REFERENCES reading(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  vectors BLOB NOT NULL,
  chunks INTEGER NOT NULL,
  dimensions INTEGER NOT NULL
);
