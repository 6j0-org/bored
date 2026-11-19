import { DatabaseSync } from 'node:sqlite';

// DEMO=1 runs a throwaway demo site (see demo.js): an in-memory database, ignoring DB_PATH, so demo accounts and
// demo content never land in a real database. Everything is gone when the server stops.
export const DEMO = /^(1|true|yes|on)$/i.test(process.env.DEMO || '');
export const db = new DatabaseSync(DEMO ? ':memory:' : process.env.DB_PATH || new URL('./data.sqlite', import.meta.url).pathname);

// A database from before the schema was reset (it still has the old events table) can't be upgraded.
if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'events'").get())
  throw new Error('This database is from an older, incompatible version of Bored? (before the schema was reset). Delete it (data.sqlite and its -wal and -shm files) to start fresh.');

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Accounts have no name, email, or password: just a random GUID, authenticated by passkeys.
-- Everything private is encrypted in the browser; the server only ever stores ciphertext ("iv.ciphertext", base64url).
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY,
  guid            TEXT NOT NULL UNIQUE,
  chat_pubkey     TEXT,                              -- ECDH P-256 public key (JWK JSON): mail is sealed to it
  chat_privkey    TEXT,                              -- matching private key, encrypted with the vault key
  sign_pubkey     TEXT,                              -- ECDSA P-256 public key (JWK JSON): signs posts and identities
  sign_privkey    TEXT,                              -- matching private key, encrypted with the vault key
  inbox_id        TEXT UNIQUE,                       -- main inbox: SHA-256 of a read token only the vault holds, base64url
  vault           TEXT,                              -- encrypted contacts, posts, and requests, see public/secure.js
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

-- Mail (see public/envelope.js): sealed envelopes and channel messages, filed by inbox. No sender.
CREATE TABLE IF NOT EXISTS mail (
  id         INTEGER PRIMARY KEY,
  inbox      TEXT NOT NULL,  -- inbox ID (SHA-256 of the read token), base64url
  body       TEXT NOT NULL,  -- ciphertext
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mail_inbox ON mail(inbox, id);

-- Hosts' signed public posts: readable by anyone, but only the host can make or change them.
CREATE TABLE IF NOT EXISTS public_posts (
  pid        TEXT PRIMARY KEY,  -- random ID the host's browser picks
  host_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  v          INTEGER NOT NULL,  -- version: each update must be higher
  body       TEXT NOT NULL,     -- the signed record, JSON: { body, sig, signer }
  live       INTEGER NOT NULL DEFAULT 1,  -- 0 once it's past or cancelled
  seq        INTEGER NOT NULL DEFAULT 0,  -- change counter: each publish or update gets one more than the highest
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_public_posts_seq ON public_posts(seq);

-- Invitations to connect. An invite is a link its owner shares however they like, usable until they delete it.
-- Only a hash of the link's token is stored. Connecting takes both people: whoever opens the link asks to connect
-- (a connection_request), and the owner confirms or declines it in their Confirm tab. A connection (a < b) makes two
-- people contacts.
CREATE TABLE IF NOT EXISTS invites (
  id         INTEGER PRIMARY KEY,
  owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  uses       INTEGER NOT NULL DEFAULT 0,  -- how many people connected through it (confirmed)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invites_owner ON invites(owner_id);
CREATE TABLE IF NOT EXISTS connections (
  a          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  b          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (a, b),
  CHECK (a < b)
);
CREATE INDEX IF NOT EXISTS idx_connections_b ON connections(b);
-- status: pending (waiting for the invite's owner) | accepted (connected) | declined
CREATE TABLE IF NOT EXISTS connection_requests (
  id           INTEGER PRIMARY KEY,
  owner_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_id    INTEGER REFERENCES invites(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  note         TEXT NOT NULL DEFAULT '', -- the nickname the requester suggests, encrypted with the invite link's key
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_id, requester_id)
);

-- Web push: a device's push subscription (from the browser's PushManager), and a small key-value table for server
-- settings such as this server's VAPID key pair (see push.js).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,  -- the push service URL for this device
  p256dh     TEXT NOT NULL,         -- the device's public key, base64url
  auth       TEXT NOT NULL,         -- the device's auth secret, base64url
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

// ---------- migrations ----------
// The CREATE TABLEs above are the schema as of the first real users. Once anyone depends on a database, they never
// change: every change is a migration below. Append one, never edit or reorder old ones. The database's PRAGMA
// user_version counts how many have run; on startup the rest run in order, each in its own transaction with the
// version bump, so a failure leaves the database on the last good version.
const MIGRATIONS = [];

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
