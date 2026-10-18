CREATE TABLE thoughts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 20000),
  reply_to TEXT REFERENCES thoughts(id) ON DELETE SET NULL,
  bookmarked INTEGER NOT NULL DEFAULT 0 CHECK(bookmarked IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX thoughts_parent ON thoughts(reply_to, seq);
CREATE VIRTUAL TABLE thoughts_fts USING fts5(body, content='thoughts', content_rowid='seq', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER thoughts_insert AFTER INSERT ON thoughts BEGIN
  INSERT INTO thoughts_fts(rowid, body) VALUES (new.seq, new.body);
END;
CREATE TRIGGER thoughts_delete AFTER DELETE ON thoughts BEGIN
  INSERT INTO thoughts_fts(thoughts_fts, rowid, body) VALUES ('delete', old.seq, old.body);
END;
CREATE TRIGGER thoughts_update AFTER UPDATE OF body ON thoughts BEGIN
  INSERT INTO thoughts_fts(thoughts_fts, rowid, body) VALUES ('delete', old.seq, old.body);
  INSERT INTO thoughts_fts(rowid, body) VALUES (new.seq, new.body);
END;
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  password_version TEXT NOT NULL
);
CREATE TABLE login_limits (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
CREATE TABLE draft (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  body TEXT NOT NULL DEFAULT '',
  reply_to TEXT REFERENCES thoughts(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 0
);
INSERT INTO draft(id) VALUES(1);
