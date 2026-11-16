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

-- AUTH_MODE=6j0 only: links an account to a 6j0.org identity instead of to local passkeys. sub is the identity's
-- ID from the identity server; it stays on this server and is never shown to other users (they see users.guid).
-- wrapped_key is the vault key encrypted with a key derived from the app key the identity server hands the browser.
CREATE TABLE IF NOT EXISTS id_accounts (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  sub         TEXT NOT NULL UNIQUE,
  wrapped_key TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- status: open (looking for attendees) | full (enough attendees matched) | past (full, and it happened) | cancelled
CREATE TABLE IF NOT EXISTS events (
  id             INTEGER PRIMARY KEY,
  host_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  details        TEXT NOT NULL DEFAULT '',
  location       TEXT NOT NULL DEFAULT '',     -- "lat,lon", e.g. "32.719649,-117.220272"; '' = not given
  when_text      TEXT NOT NULL DEFAULT '',     -- "YYYY-MM-DDTHH:MM[;RRULE]" in the host's local time (public/when.js); '' = not given
  visibility     TEXT NOT NULL DEFAULT 'private', -- private (only the host's chosen contacts, in event_viewers) | public (anyone, even guests)
  max_attendees  INTEGER,                      -- NULL = no limit; otherwise the post fills up at this many matches
  cost_amount    REAL NOT NULL DEFAULT 0,      -- 0 = free; rounded to the currency's decimals (public/cost.js)
  cost_currency  TEXT NOT NULL DEFAULT 'USD',  -- ISO 4217 code
  status         TEXT NOT NULL DEFAULT 'open',
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per (event, would-be attendee) swipe.
-- yes=0 means "pass" (never shown again).
-- status for yes-swipes: pending (waiting on host) | accepted (it's a match!) | declined | attended (host marked it happened) | withdrawn
CREATE TABLE IF NOT EXISTS swipes (
  id          INTEGER PRIMARY KEY,
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  attendee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  yes         INTEGER NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pending',
  reconfirm   INTEGER NOT NULL DEFAULT 0, -- 1 when the post was edited after this attendee matched; they must re-confirm
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_id, attendee_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY,
  swipe_id   INTEGER NOT NULL REFERENCES swipes(id) ON DELETE CASCADE,
  sender_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,                -- kind 'user': E2E ciphertext ("iv.ciphertext"); kind 'system': plaintext
  kind       TEXT NOT NULL DEFAULT 'user', -- 'user' (typed by a person) | 'system' (edit notices, re-confirm replies)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Free-form tags on an event (up to 5). pos keeps the host's order; the first known tag picks the card's icon/color.
CREATE TABLE IF NOT EXISTS event_tags (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  pos     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, tag)
);

-- Who may see a private event. The host's browser expands the contacts and groups they picked (which live only in
-- their encrypted vault) into accounts, and re-sends the list whenever those groups change.
CREATE TABLE IF NOT EXISTS event_viewers (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_event_viewers_user ON event_viewers(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON events(status);
CREATE INDEX IF NOT EXISTS idx_event_tags_tag ON event_tags(tag);
CREATE INDEX IF NOT EXISTS idx_swipes_attendee ON swipes(attendee_id);
CREATE INDEX IF NOT EXISTS idx_messages_swipe ON messages(swipe_id);
`);

// Prototype: no migrations. After a schema change, delete data.sqlite* and run `npm run seed`.

// ---------- tags ----------
export const MAX_ATTENDEES_LIMIT = 500;
export const MAX_VIEWERS = 1000; // people one private event can be shared with

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

export function setEventTags(eventId, tags) {
  db.prepare('DELETE FROM event_tags WHERE event_id = ?').run(eventId);
  const ins = db.prepare('INSERT INTO event_tags (event_id, tag, pos) VALUES (?, ?, ?)');
  tags.forEach((tag, i) => ins.run(eventId, tag, i));
}
