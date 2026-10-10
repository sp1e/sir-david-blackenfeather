CREATE TABLE IF NOT EXISTS site_companion_preferences (
  owner_id TEXT PRIMARY KEY REFERENCES site_portal_profiles(id),
  auto_speak INTEGER NOT NULL DEFAULT 1 CHECK (auto_speak IN (0,1)),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0)
);
