CREATE TABLE thought_tags (
  thought_id TEXT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY(thought_id,tag)
);
CREATE INDEX tags_by_name ON thought_tags(tag,thought_id);
CREATE TABLE thought_tag_index (
  thought_id TEXT PRIMARY KEY REFERENCES thoughts(id) ON DELETE CASCADE
);
CREATE TRIGGER tags_invalidate AFTER UPDATE OF body,title ON thoughts BEGIN
  DELETE FROM thought_tags WHERE thought_id=new.id;
  DELETE FROM thought_tag_index WHERE thought_id=new.id;
END;
