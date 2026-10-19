-- Private planning decisions. Calendar events stay ordinary manual events and
-- are never rewritten by another suggestion or by this decision ledger.
CREATE TABLE IF NOT EXISTS site_companion_work_windows (
  owner_id TEXT NOT NULL REFERENCES site_portal_profiles(id),
  action_hash TEXT NOT NULL,
  decision_key TEXT NOT NULL,
  project_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('accepted','rejected')),
  event_id TEXT,
  event_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id,decision_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS site_companion_work_window_accepted
  ON site_companion_work_windows(owner_id,action_hash) WHERE state='accepted';
CREATE TABLE IF NOT EXISTS site_companion_work_window_settings (
  owner_id TEXT PRIMARY KEY REFERENCES site_portal_profiles(id),
  settings_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
