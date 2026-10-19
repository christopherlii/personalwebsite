-- The shelf: articles opened with /read <link> and books dropped in as PDFs.
-- Only extracted plain text is kept (headings, paragraphs, lists, quotes),
-- split into parts so a whole book fits D1's row limits.
CREATE TABLE works (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('article', 'book')),
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  url TEXT UNIQUE,
  site TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'reading' CHECK(status IN ('reading', 'finished')),
  parts INTEGER NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0 CHECK(position >= 0 AND position <= 1),
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX works_by_status ON works(status, started_at);
CREATE TABLE work_parts (
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  part INTEGER NOT NULL,
  blocks TEXT NOT NULL,
  PRIMARY KEY(work_id, part)
);
