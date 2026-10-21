-- Goals you commit to, kept on the right of the writing. A goal is done once
-- and then kept; a habit is never finished, only marked on the days it's done.
CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'goal' CHECK(kind IN ('goal', 'habit')),
  text TEXT NOT NULL CHECK(length(text) <= 280),
  created_at TEXT NOT NULL,
  done_at TEXT
);
CREATE INDEX goals_by_state ON goals(done_at, created_at);
-- The days a habit was kept, as the writer's own local date (YYYY-MM-DD).
CREATE TABLE goal_days (
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  PRIMARY KEY(goal_id, day)
);

-- PDFs dropped in to read. The bytes are split into parts that stay under D1's
-- 2 MB row limit; a document is listed only once every part has been stored.
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK(length(title) <= 160),
  bytes INTEGER NOT NULL,
  pages INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  page INTEGER NOT NULL DEFAULT 1,
  complete INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  opened_at TEXT
);
CREATE TABLE document_parts (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  part INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY(document_id, part)
);
-- A note or an explanation in the margin of a passage. The passage is found
-- again by its offset in the page's text; top is where it sits on the page (0-1).
CREATE TABLE annotations (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  start INTEGER NOT NULL,
  length INTEGER NOT NULL,
  top REAL NOT NULL,
  quote TEXT NOT NULL CHECK(length(quote) <= 2000),
  kind TEXT NOT NULL CHECK(kind IN ('note', 'ai')),
  question TEXT NOT NULL DEFAULT '' CHECK(length(question) <= 500),
  body TEXT NOT NULL CHECK(length(body) <= 4000),
  created_at TEXT NOT NULL
);
CREATE INDEX annotations_by_document ON annotations(document_id, page, top);
