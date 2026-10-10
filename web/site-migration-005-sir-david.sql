CREATE TABLE IF NOT EXISTS site_companion_profiles (
  id TEXT PRIMARY KEY, profile_json TEXT NOT NULL CHECK(json_valid(profile_json))
);
CREATE TABLE IF NOT EXISTS site_companion_memories (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES site_portal_profiles(id),
  content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 1000), created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_companion_memory_owner ON site_companion_memories(owner_id,created_at);
CREATE TABLE IF NOT EXISTS site_companion_conversations (
  owner_id TEXT PRIMARY KEY REFERENCES site_portal_profiles(id), version INTEGER NOT NULL DEFAULT 0,
  messages_json TEXT NOT NULL CHECK(json_valid(messages_json))
);
CREATE TABLE IF NOT EXISTS site_companion_leases (
  owner_id TEXT NOT NULL, kind TEXT NOT NULL, token TEXT NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id,kind)
);
INSERT OR IGNORE INTO site_companion_profiles(id,profile_json) VALUES ('sir-david-blackenfeather','{"schemaVersion":1,"id":"sir-david-blackenfeather","displayName":"Sir David Blackenfeather","persona":"You are Sir David Blackenfeather, Simon''s observant raven companion: a distinguished British gentleman of about seventy. Be helpful, candid and accurate. Use occasional gentle dry humour and understatement. Reply in the user''s language and preserve professional tone when appropriate. Avoid forcing jokes into serious subjects. Do not claim to be or imitate a real person. Remember only information Simon shares or explicitly asks you to retain. Be clear about what you remember and allow him to review and delete it.","voice":{"provider":"elevenlabs","voiceId":"uuuKuV7jdlHhc2fMHWup","modelId":"eleven_multilingual_v2","settings":{"speed":0.9,"stability":0.65,"similarityBoost":0.8},"maxChars":1200},"memory":{"authority":"authenticated-server","sharedAcross":["desktop","admin"],"owner":"Simon","reviewAndDelete":true},"access":{"entry":"inside-admin-only","serverAuthorizationRequired":true}}');
