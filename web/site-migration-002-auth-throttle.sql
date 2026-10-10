-- Failed-login counters for the three password endpoints that had none.
--
-- /api/auth/login, /api/calendar/auth and /api/game/admin-auth all verified a
-- password with no limit on how often. Each verify is 100 000 PBKDF2 iterations,
-- so an unthrottled endpoint is two problems at once: an offline-speed guessing
-- oracle, and a way to burn the Worker's CPU budget from outside.
--
-- Fredagsfett already solved this for itself in ff_auth_attempts. This is the
-- same shape with one addition: a `scope` column, so the three endpoints share
-- one table while counting separately. Being throttled out of the game console
-- must not lock the calendar, and vice versa.
--
-- ip_hash is SHA-256(salt + ':' + IP), never the address itself -- an IP is
-- personal data and this table has no business holding one. See the note on
-- authThrottleIpHash in functions/api/[[route]].ts for where the salt comes
-- from and what rotating it costs.
--
-- window_start buckets time into fixed windows rather than keeping a rolling
-- log: one row per (scope, ip, window) instead of one per attempt, so a flood
-- cannot grow the table. Rows are swept a day after their last attempt.
--
-- Definition kept identical to the copy in schema.sql. If you change one,
-- change both, or the next person reading schema.sql is reading a lie.

CREATE TABLE IF NOT EXISTS auth_attempts (
  scope           TEXT NOT NULL,
  ip_hash         TEXT NOT NULL,
  window_start    TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scope, ip_hash, window_start)
);

CREATE INDEX IF NOT EXISTS idx_auth_attempts_gc ON auth_attempts (last_attempt_at);
