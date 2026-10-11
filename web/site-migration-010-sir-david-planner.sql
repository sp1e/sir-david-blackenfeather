-- Private owner-scoped planner. Applied after the host's 008 projects and 009 collaboration migrations.
-- Calendar credentials are encrypted by the Worker.
CREATE TABLE IF NOT EXISTS site_companion_planners (
  owner_id TEXT PRIMARY KEY REFERENCES site_portal_profiles(id),
  document_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS site_companion_reminders (
  owner_id TEXT NOT NULL REFERENCES site_portal_profiles(id), reminder_key TEXT NOT NULL,
  claim_id TEXT, claim_session TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
  delivered_at INTEGER, day_key TEXT, snooze_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(owner_id, reminder_key)
);
CREATE INDEX IF NOT EXISTS site_companion_reminder_day ON site_companion_reminders(owner_id,day_key);
CREATE TABLE IF NOT EXISTS site_companion_reminder_days (
  owner_id TEXT NOT NULL REFERENCES site_portal_profiles(id), day_key TEXT NOT NULL,
  claims INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner_id,day_key)
);
CREATE TABLE IF NOT EXISTS site_companion_outlook (
  owner_id TEXT PRIMARY KEY REFERENCES site_portal_profiles(id), tokens_cipher TEXT NOT NULL,
  events_json TEXT NOT NULL DEFAULT '[]', last_sync INTEGER, last_attempt INTEGER,
  sync_id TEXT, sync_until INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'connected'
);
CREATE TABLE IF NOT EXISTS site_companion_outlook_states (
  state_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES site_portal_profiles(id),
  session_hash TEXT NOT NULL, verifier_cipher TEXT NOT NULL, redirect_uri TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
