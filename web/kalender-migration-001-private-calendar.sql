-- Private calendar (/kalender/) — schema of record.
--
-- These tables already exist in production D1. They were created by a Pages
-- Function that was deployed by direct upload and never committed, so this file
-- is the schema written back down from production (SELECT sql FROM sqlite_master)
-- rather than the file that originally created them. Everything here is
-- IF NOT EXISTS: applying it must never drop or recreate a table that already
-- holds events.
--
-- private_calendar_sessions is the calendar's own session store, deliberately
-- separate from the site's `sessions` table. Same password value, different
-- session: the calendar can be revoked on its own, and signing in to the hub
-- does not unlock it. The planned Microsoft calendar sync will store delegated
-- tokens beside these events, which is what makes that isolation load-bearing
-- rather than merely tidy.

CREATE TABLE IF NOT EXISTS private_calendar_events (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  event_date TEXT NOT NULL CHECK (event_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  all_day    INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0, 1)),
  start_time TEXT,
  end_time   TEXT,
  location   TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',
  color      TEXT NOT NULL DEFAULT 'olive' CHECK (color IN ('olive', 'gold', 'rust', 'sky')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS private_calendar_sessions (
  token      TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- The page always asks for a 42-day window covering the visible month grid.
CREATE INDEX IF NOT EXISTS idx_private_calendar_events_date
  ON private_calendar_events (event_date);
