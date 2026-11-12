CREATE TABLE spotify_connection (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  client_id TEXT NOT NULL,
  refresh_token TEXT,
  public_json TEXT,
  refresh_after INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE spotify_authorizations (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  client_id TEXT NOT NULL,
  verifier TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
