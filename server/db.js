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
`;

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);
  return db;
}
