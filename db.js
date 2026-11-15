import { DatabaseSync } from 'node:sqlite';

export const db = new DatabaseSync(process.env.DB_PATH || new URL('./data.sqlite', import.meta.url).pathname);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Accounts have no name, email or password: just a random GUID, authenticated by passkeys.
-- Everything private is encrypted in the browser; the server only ever stores ciphertext ("iv.ciphertext", base64url).
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY,
  guid            TEXT NOT NULL UNIQUE,
  chat_pubkey     TEXT,                              -- ECDH P-256 public key (JWK JSON) others use for E2E chat
  chat_privkey    TEXT,                              -- matching private key, encrypted with the vault key
  vault           TEXT,                              -- encrypted contacts/nicknames, see public/secure.js
  vault_version   INTEGER NOT NULL DEFAULT 0,        -- optimistic concurrency for vault writes
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per passkey. wrapped_key is the vault key encrypted with a key derived from this passkey's PRF output.
CREATE TABLE IF NOT EXISTS passkeys (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,                -- base64url
  public_key    TEXT NOT NULL,                       -- SPKI DER, base64url
  alg           INTEGER NOT NULL,                    -- COSE: -7 ES256, -257 RS256
  sign_count    INTEGER NOT NULL DEFAULT 0,
  wrapped_key   TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at  TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- status: open (looking for helpers) | full (enough helpers matched) | done | cancelled
CREATE TABLE IF NOT EXISTS tasks (
  id             INTEGER PRIMARY KEY,
  creator_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  details        TEXT NOT NULL DEFAULT '',
  location       TEXT NOT NULL DEFAULT '',
  when_text      TEXT NOT NULL DEFAULT '',
  public_event   INTEGER NOT NULL DEFAULT 0,   -- 1 = a public event: open to all (or ticketed elsewhere), never capped
  max_attendees  INTEGER,                      -- NULL = no limit; otherwise the post fills up at this many matches. Always NULL for public events
  cost           TEXT NOT NULL DEFAULT 'free', -- free | low ($) | medium ($$) | high ($$$)
  status         TEXT NOT NULL DEFAULT 'open',
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per (task, would-be helper) swipe.
-- yes=0 means "pass" (never shown again).
-- status for yes-swipes: pending (waiting on creator) | accepted (it's a match!) | declined | done | withdrawn
CREATE TABLE IF NOT EXISTS swipes (
  id         INTEGER PRIMARY KEY,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  helper_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  yes        INTEGER NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'pending',
  reconfirm  INTEGER NOT NULL DEFAULT 0, -- 1 when the post was edited after this helper matched; they must re-confirm
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (task_id, helper_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY,
  swipe_id   INTEGER NOT NULL REFERENCES swipes(id) ON DELETE CASCADE,
  sender_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,                -- kind 'user': E2E ciphertext ("iv.ciphertext"); kind 'system': plaintext
  kind       TEXT NOT NULL DEFAULT 'user', -- 'user' (typed by a person) | 'system' (edit notices, re-confirm replies)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Free-form tags on a task (up to 5). pos keeps the poster's order; the first known tag picks the card's icon/color.
CREATE TABLE IF NOT EXISTS task_tags (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  pos     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_task_tags_tag ON task_tags(tag);
CREATE INDEX IF NOT EXISTS idx_swipes_helper ON swipes(helper_id);
CREATE INDEX IF NOT EXISTS idx_messages_swipe ON messages(swipe_id);
`);

// Prototype: no migrations. After a schema change, delete data.sqlite* and run `npm run seed`.

// ---------- tags ----------
export const COSTS = ['free', 'low', 'medium', 'high'];
export const COST_LABELS = { free: 'Free', low: '$', medium: '$$', high: '$$$' };

export const MAX_ATTENDEES_LIMIT = 500;

export const MAX_TAGS = 5;
export const MAX_TAG_LENGTH = 24;

// "  #Outdoor Fun! " → "outdoor-fun". Returns '' if nothing usable is left.
export function normalizeTag(raw) {
  return String(raw ?? '').toLowerCase().trim().replace(/^#+/, '')
    .replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '')
    .slice(0, MAX_TAG_LENGTH);
}

// Accepts an array or a comma-separated string; returns unique, normalized tags in order.
export function parseTags(input) {
  const list = Array.isArray(input) ? input : String(input ?? '').split(',');
  return [...new Set(list.map(normalizeTag).filter(Boolean))];
}

export function setTaskTags(taskId, tags) {
  db.prepare('DELETE FROM task_tags WHERE task_id = ?').run(taskId);
  const ins = db.prepare('INSERT INTO task_tags (task_id, tag, pos) VALUES (?, ?, ?)');
  tags.forEach((tag, i) => ins.run(taskId, tag, i));
}
