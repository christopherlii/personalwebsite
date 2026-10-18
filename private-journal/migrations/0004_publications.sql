ALTER TABLE thoughts ADD COLUMN source_date TEXT;

CREATE TABLE publications (
  thought_id TEXT PRIMARY KEY REFERENCES thoughts(id) ON DELETE CASCADE,
  draft TEXT NOT NULL CHECK(json_valid(draft)),
  version INTEGER NOT NULL DEFAULT 1,
  published TEXT CHECK(published IS NULL OR json_valid(published)),
  published_slug TEXT UNIQUE,
  published_at TEXT,
  source_key TEXT UNIQUE,
  updated_at TEXT NOT NULL,
  CHECK((published IS NULL) = (published_slug IS NULL))
);
