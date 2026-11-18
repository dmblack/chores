import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
-- The household's history. Append-only: every task, completion, approval,
-- points award and spend is an event here, and current state is derived from it.
CREATE TABLE IF NOT EXISTS events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id   TEXT NOT NULL,
  type        TEXT NOT NULL,
  actor_id    TEXT,
  device_id   TEXT,
  at          TEXT NOT NULL,   -- when it happened (the iPad's clock, sanity-checked)
  recorded_at TEXT NOT NULL,   -- when the server received it
  payload     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_action ON events(action_id);

CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

-- One row per action an iPad sent, keyed by the iPad's stable action id, so a
-- resend after reconnecting is recognised and never applied twice.
CREATE TABLE IF NOT EXISTS actions (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT,
  type        TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('accepted', 'rejected')),
  error_code  TEXT,
  error       TEXT,
  recorded_at TEXT NOT NULL
);

-- Accounts and credentials. Points and history are NOT stored here; they are
-- derived from the event log. Profile changes are also logged as events.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  nickname      TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('grownup', 'kid')),
  birth_date    TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  pin_hash      TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  device_id    TEXT,
  created_at   INTEGER NOT NULL,
  refreshed_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- Wrong PIN / password attempts, per device and per network address.
CREATE TABLE IF NOT EXISTS login_throttle (
  key          TEXT PRIMARY KEY,
  misses       INTEGER NOT NULL,
  last_miss    INTEGER NOT NULL,
  locked_until INTEGER NOT NULL
);

-- Storage-independent concurrency metadata and durable domain projections.
CREATE TABLE IF NOT EXISTS storage_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS storage_projection (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * Open or additively upgrade a SQLite file without replacing existing data.
 * @param {string} file - Database path or :memory:.
 * @returns {Database.Database} Open SQLite connection.
 */
export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  // Serialize schema checks with upgrades when several server processes start together.
  const upgrade = db.transaction(() => {
    db.exec(SCHEMA);
    if (!db.prepare('PRAGMA table_info(users)').all().some((column) => column.name === 'auth_version')) {
      db.exec('ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0');
    }
    if (!db.prepare('PRAGMA table_info(sessions)').all().some((column) => column.name === 'user_version')) {
      db.exec('ALTER TABLE sessions ADD COLUMN user_version INTEGER NOT NULL DEFAULT 0');
    }
  });
  upgrade.immediate();
  return db;
}
