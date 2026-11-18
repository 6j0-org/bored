import { DatabaseSync } from 'node:sqlite';

// DEMO=1 runs a throwaway demo site (see demo.js): an in-memory database, ignoring DB_PATH, so demo accounts and
// demo content never land in a real database. Everything is gone when the server stops.
export const DEMO = /^(1|true|yes|on)$/i.test(process.env.DEMO || '');
export const db = new DatabaseSync(DEMO ? ':memory:' : process.env.DB_PATH || new URL('./data.sqlite', import.meta.url).pathname);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Accounts have no name, email, or password: just a random GUID, authenticated by passkeys.
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
-- status for yes-swipes: pending (waiting on host) | accepted (it's a match!) | waitlisted (host said yes but it was full;
--   matched automatically, first come first served, when a spot opens) | declined | attended (host marked it happened) | withdrawn
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

-- Free-form tags on an event (up to 5). pos keeps the host's order.
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

// ---------- migrations ----------
// The CREATE TABLEs above are the schema as it was at public launch, and never change. Every change since is a
// migration below: append one, never edit or reorder old ones. The database's PRAGMA user_version counts how many
// have run; on startup the rest run in order, each in its own transaction with the version bump, so a failure
// leaves the database on the last good version.
const MIGRATIONS = [
  // 1: a friendly name for a post's location, shown instead of the coordinates, e.g. "Ocean Beach Pier"; '' = none.
  `ALTER TABLE events ADD COLUMN location_name TEXT NOT NULL DEFAULT ''`,
  // 2: drop the "social" tag. Everything in the app is social, so it said nothing.
  `DELETE FROM event_tags WHERE tag = 'social'`,
  // 3: online posts. 0 = in person, 1 = online only (location and location_name are then ''), 2 = both, e.g. a
  //    city hall meeting with a video call (location is the in-person part).
  `ALTER TABLE events ADD COLUMN online INTEGER NOT NULL DEFAULT 0`,
  // 4: invitations to connect. An invite is a link its owner shares however they like, usable until they delete it.
  //    Only a hash of the link's token is stored. Connecting takes both people: whoever opens the link asks to
  //    connect (a connection_request), and the owner confirms or declines it in their Confirm tab.
  //    A connection (a < b) makes two people contacts, just like a match does.
  `CREATE TABLE invites (
     id         INTEGER PRIMARY KEY,
     owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     token_hash TEXT NOT NULL UNIQUE,
     uses       INTEGER NOT NULL DEFAULT 0,  -- how many people connected through it (confirmed)
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX idx_invites_owner ON invites(owner_id);
   CREATE TABLE connections (
     a          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     b          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (a, b),
     CHECK (a < b)
   );
   CREATE INDEX idx_connections_b ON connections(b);
   -- status: pending (waiting for the invite's owner) | accepted (connected) | declined
   CREATE TABLE connection_requests (
     id           INTEGER PRIMARY KEY,
     owner_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     invite_id    INTEGER REFERENCES invites(id) ON DELETE SET NULL,
     status       TEXT NOT NULL DEFAULT 'pending',
     note         TEXT NOT NULL DEFAULT '', -- the nickname the requester suggests, encrypted with the invite link's key
     created_at   TEXT NOT NULL DEFAULT (datetime('now')),
     UNIQUE (owner_id, requester_id)
   );`,
  // 5: web push. A device's push subscription (from the browser's PushManager), and a small key-value table for
  //    server settings such as this server's VAPID key pair (see push.js).
  `CREATE TABLE push_subscriptions (
     id         INTEGER PRIMARY KEY,
     user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     endpoint   TEXT NOT NULL UNIQUE,  -- the push service URL for this device
     p256dh     TEXT NOT NULL,         -- the device's public key, base64url
     auth       TEXT NOT NULL,         -- the device's auth secret, base64url
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX idx_push_user ON push_subscriptions(user_id);
   CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // 6: rename well-known tags (outdoors → hiking, garden → gardening, repair → fixing) and drop "events", which
  //    every post is. "games" was split into board-games and video-games; existing "games" tags can't be sorted
  //    into one, so they stay as a free-form tag. OR IGNORE + DELETE handles a post that already had the new tag.
  `UPDATE OR IGNORE event_tags SET tag = 'hiking' WHERE tag = 'outdoors';
   UPDATE OR IGNORE event_tags SET tag = 'gardening' WHERE tag = 'garden';
   UPDATE OR IGNORE event_tags SET tag = 'fixing' WHERE tag = 'repair';
   DELETE FROM event_tags WHERE tag IN ('outdoors', 'garden', 'repair', 'events');`,
  // 7: encrypted mail (see "mail" in public/secure.js). Each account gets an ECDSA P-256 signing key (the private
  //    half encrypted with the vault key, like chat_privkey) and a main inbox, published as the SHA-256 of a read
  //    token only the account's vault holds. Mail rows have the inbox and the ciphertext, and no sender.
  //    public_posts holds hosts' signed public posts: readable by anyone, but only the host can make or change them.
  `ALTER TABLE users ADD COLUMN sign_pubkey TEXT;   -- ECDSA P-256 public key (JWK JSON)
   ALTER TABLE users ADD COLUMN sign_privkey TEXT;  -- matching private key, encrypted with the vault key
   ALTER TABLE users ADD COLUMN inbox_id TEXT;      -- main inbox: SHA-256 of its read token, base64url
   CREATE UNIQUE INDEX idx_users_inbox ON users(inbox_id);
   CREATE TABLE mail (
     id         INTEGER PRIMARY KEY,
     inbox      TEXT NOT NULL,  -- inbox ID (SHA-256 of the read token), base64url
     body       TEXT NOT NULL,  -- ciphertext
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX idx_mail_inbox ON mail(inbox, id);
   CREATE TABLE public_posts (
     pid        TEXT PRIMARY KEY,  -- random ID the host's browser picks
     host_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     v          INTEGER NOT NULL,  -- version: each update must be higher
     body       TEXT NOT NULL,     -- the signed record, JSON: { body, sig, signer }
     live       INTEGER NOT NULL DEFAULT 1,
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX idx_public_posts_live ON public_posts(live, updated_at);`,
];

export function migrate() {
  const from = db.prepare('PRAGMA user_version').get().user_version;
  if (from > MIGRATIONS.length) throw new Error(`Database is at version ${from}, newer than this code (${MIGRATIONS.length})`);
  for (let v = from; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
      console.log(`Database migrated to version ${v + 1}`);
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}
migrate();

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
