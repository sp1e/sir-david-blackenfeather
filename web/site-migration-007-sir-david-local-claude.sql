CREATE TABLE IF NOT EXISTS site_companion_local_turns (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL UNIQUE REFERENCES site_portal_profiles(id),
  session_hash TEXT NOT NULL REFERENCES site_portal_sessions(token_hash),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  expires_at INTEGER NOT NULL,
  messages_json TEXT NOT NULL CHECK(json_valid(messages_json) AND length(messages_json) <= 40000)
);
