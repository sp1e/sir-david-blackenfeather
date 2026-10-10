-- Additive portal identity. Existing application rows are retained.
CREATE TABLE IF NOT EXISTS site_portal_profiles (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK(role IN ('admin','clique','guest')),
  device_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE(device_hash,role)
);

CREATE TABLE IF NOT EXISTS site_portal_invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  grants_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  claimed_at TEXT,
  claimed_by TEXT REFERENCES site_portal_profiles(id),
  claimed_session_hash TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS site_portal_sessions (
  token_hash TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES site_portal_profiles(id),
  invite_id TEXT REFERENCES site_portal_invites(id),
  legacy_token TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_site_portal_sessions_profile ON site_portal_sessions(profile_id);

CREATE TABLE IF NOT EXISTS site_portal_app_links (
  profile_id TEXT NOT NULL REFERENCES site_portal_profiles(id),
  app TEXT NOT NULL,
  account_id TEXT NOT NULL,
  PRIMARY KEY(profile_id,app)
);

CREATE TABLE IF NOT EXISTS site_portal_job_owners (
  job_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES site_portal_profiles(id)
);
