import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { newChallenge, takeChallenge, verifyRegistration, verifyAssertion, WebAuthnError } from './webauthn.js';
import { verifyIdToken, IdTokenError } from './idtoken.js';
import { composeWhen, whenLabel, occursBetween } from './public/when.js';
import { parseCost, costLabel } from './public/cost.js';
import { vapidPublicKey, validEndpoint, sendPush } from './push.js';
import { db, parseTags, setEventTags, MAX_TAGS, MAX_ATTENDEES_LIMIT, MAX_VIEWERS } from './db.js';

const PORT = Number(process.env.PORT || 3000);
// Passkeys are bound to an origin. Defaults to whatever host the browser used (fine for localhost);
// set ORIGIN (e.g. https://bored.example) and optionally RP_ID in production.
const originOf = (req) => process.env.ORIGIN || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
const rpIdOf = (req) => process.env.RP_ID || new URL(originOf(req)).hostname;
const MAX_SEALED = 200 * 1024; // max size of one encrypted blob (vault, key) in characters

// Who signs people in:
// - AUTH_MODE=local (default): Bored? runs its own passkeys (RP ID = RP_ID or the ORIGIN hostname). Standalone.
// - AUTH_MODE=6j0: a 6j0.org identity server at ID_ORIGIN does. The browser comes back with a signed token and
//   this app's key from that server; the local passkey routes are switched off. ID_APP is this app's name in the
//   identity server's APPS list (default "bored"). ID_JWKS_URL overrides where its public keys are fetched from
//   (default ID_ORIGIN + /.well-known/jwks.json), e.g. an in-cluster Service URL.
// The two modes have separate accounts: switching a running instance from one to the other strands existing users.
const AUTH_MODE = process.env.AUTH_MODE || 'local';
if (!['local', '6j0'].includes(AUTH_MODE)) throw new Error(`AUTH_MODE must be "local" or "6j0", not "${AUTH_MODE}"`);
const ID = AUTH_MODE === '6j0' ? (() => {
  const origin = process.env.ID_ORIGIN;
  if (!origin || new URL(origin).origin !== origin) throw new Error('AUTH_MODE=6j0 needs ID_ORIGIN, e.g. https://id.6j0.org');
  return { origin, app: process.env.ID_APP || 'bored', jwksUrl: process.env.ID_JWKS_URL || `${origin}/.well-known/jwks.json` };
})() : null;

// ---------- helpers ----------

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const q = (sql) => db.prepare(sql);

function str(v, max, { required = false, field = 'field' } = {}) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw new HttpError(400, `${field} is required`);
  if (s.length > max) throw new HttpError(400, `${field} is too long (max ${max})`);
  return s;
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 512 * 1024) throw new HttpError(413, 'Body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON'); }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function newSession(res, userId) {
  const token = randomBytes(24).toString('hex');
  q('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
  const secure = String(process.env.ORIGIN || '').startsWith('https:') ? '; Secure' : '';
  return { 'Set-Cookie': `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}${secure}` };
}

function stats(userId) {
  const hosted = q(`SELECT COUNT(DISTINCT s.event_id) n FROM swipes s JOIN events t ON t.id = s.event_id WHERE t.host_id = ? AND s.status = 'attended'`).get(userId).n;
  const attended = q(`SELECT COUNT(*) n FROM swipes WHERE attendee_id = ? AND status = 'attended'`).get(userId).n;
  return { hosted, attended };
}

// What anyone may learn about an account: its GUID and activity counts. Never a name.
function publicUser(u) {
  return { guid: u.guid, ...stats(u.id) };
}

// Encrypted values from the browser look like "iv.ciphertext" in base64url. The server never decrypts them.
function sealed(v, field, max = MAX_SEALED) {
  if (typeof v !== 'string' || v.length > max || !/^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/.test(v)) throw new HttpError(400, `Bad ${field}`);
  return v;
}
function chatPubkey(v) {
  if (!v || v.kty !== 'EC' || v.crv !== 'P-256' || typeof v.x !== 'string' || typeof v.y !== 'string' || v.d) throw new HttpError(400, 'Bad chat key');
  return JSON.stringify({ kty: 'EC', crv: 'P-256', x: v.x, y: v.y });
}

// A "match" is an accepted/attended yes-swipe. Only the attendee and the event host may see it.
function loadMatch(swipeId, userId) {
  const m = q(`
    SELECT s.*, t.host_id, t.title, t.status AS event_status
    FROM swipes s JOIN events t ON t.id = s.event_id
    WHERE s.id = ? AND s.status IN ('accepted', 'attended', 'withdrawn')`).get(swipeId);
  if (!m || (m.attendee_id !== userId && m.host_id !== userId)) throw new HttpError(404, 'Match not found');
  return m;
}

function tagsField(v) {
  const tags = parseTags(v);
  if (tags.length > MAX_TAGS) throw new HttpError(400, `Up to ${MAX_TAGS} tags, please`);
  return tags;
}

// SQL column yielding an event's tags as a JSON array, in the host's order. Use with alias t for events.
const TAGS_COL = `(SELECT json_group_array(tag ORDER BY pos) FROM event_tags WHERE event_id = t.id) AS tags`;
const withTags = (row) => ({ ...row, tags: JSON.parse(row.tags || '[]') });

// Blank/missing → null (no limit); otherwise a whole number 1..MAX_ATTENDEES_LIMIT.
function maxAttendeesField(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_ATTENDEES_LIMIT)
    throw new HttpError(400, `Max attendees must be a whole number from 1 to ${MAX_ATTENDEES_LIMIT}, or blank for no limit`);
  return n;
}

// Reverse geocoding for the map picker: coordinates → a friendly place name, from OpenStreetMap's Nominatim.
// The browser asks us rather than OSM, so it doesn't talk to another server. Nominatim's usage policy allows at most
// one request a second with an identifying User-Agent, so requests are spaced out and answers are cached.
const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';
const placeCache = new Map(); // "lat,lon" (5 decimals, about a metre) → name
let nextNominatim = 0;
function placeName(a = {}, name = '') {
  const street = [a.house_number, a.road].filter(Boolean).join(' ');
  const area = a.neighbourhood || a.suburb || a.quarter || a.hamlet;
  const town = a.city || a.town || a.village || a.municipality || a.county;
  const parts = [name || street, name && street ? '' : area, town].filter(Boolean);
  return [...new Set(parts)].join(', ').slice(0, 100);
}
async function reverseGeocode(lat, lon, lang) {
  const key = `${lat.toFixed(5)},${lon.toFixed(5)}|${lang}`;
  if (placeCache.has(key)) return placeCache.get(key);
  const wait = nextNominatim - Date.now();
  nextNominatim = Math.max(Date.now(), nextNominatim) + 1100;
  if (wait > 5000) throw new HttpError(503, 'Too many place lookups right now. Type a name instead, or try again shortly.');
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  const url = `${NOMINATIM}?format=jsonv2&addressdetails=1&zoom=18&lat=${lat}&lon=${lon}`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Bored-event-app/0.1 (self-hosted)', ...(lang ? { 'Accept-Language': lang } : {}) },
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  if (!r?.ok) throw new HttpError(502, "Couldn't look up a name for that spot. You can type one.");
  const j = await r.json();
  const name = placeName(j.address, j.name) || String(j.display_name || '').split(',').slice(0, 3).join(',').trim().slice(0, 100);
  if (placeCache.size > 1000) placeCache.delete(placeCache.keys().next().value);
  placeCache.set(key, name);
  return name;
}

// Location: "lat,lon" with 6 decimals, e.g. "32.719649,-117.220272", or blank.
function locationField(v) {
  const s = str(v, 100, { field: 'Location' });
  if (!s) return s;
  const m = /^(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/.exec(s);
  const lat = m && Number(m[1]), lon = m && Number(m[2]);
  if (!m || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    throw new HttpError(400, 'Where must be "latitude,longitude", e.g. 32.719649,-117.220272, or picked on the map');
  return `${lat.toFixed(6)},${lon.toFixed(6)}`;
}

// When: a date and time, optionally repeating; format in public/when.js. Blank = unspecified.
function whenField(start, repeat) {
  const s = str(start, 100, { field: 'When' });
  const rule = str(repeat, 100, { field: 'Repeats' });
  if (!s) return s;
  const v = composeWhen(s, rule);
  if (!v) throw new HttpError(400, rule ? "That repeat doesn't fit the date picked" : 'When must be a date and time');
  return v;
}

function costFields(amount, currency) {
  const c = parseCost(amount, currency);
  if (c.error) throw new HttpError(400, c.error);
  return c;
}

function eventFields(body) {
  const cost = costFields(body.cost_amount, body.cost_currency);
  const f = {
    visibility: body.visibility === 'public' ? 'public' : 'private',
    title: str(body.title, 100, { required: true, field: 'Title' }),
    details: str(body.details, 1000, { field: 'Details' }),
    tags: tagsField(body.tags),
    cost_amount: cost.amount,
    cost_currency: cost.currency,
    location: locationField(body.location),
    location_name: str(body.location_name, 100, { field: 'Where' }),
    online: [1, 2].includes(Number(body.online)) ? Number(body.online) : 0, // 0 in person, 1 online, 2 both
    when_text: whenField(body.when_text, body.when_repeat),
    max_attendees: maxAttendeesField(body.max_attendees),
  };
  // An online-only post has no place.
  if (f.online === 1) { f.location = ''; f.location_name = ''; }
  return f;
}
const FIELD_LABELS = { title: 'Title', details: 'Details', tags: 'Tags', location: 'Where', when_text: 'When', cost: 'Cost', visibility: 'Visibility', max_attendees: 'Max attendees' };

// GUIDs are only ever sent for people you've matched with (now or before, on either side) or connected with through
// an invitation. Those are your contacts, which your browser keys by GUID. Anyone else stays anonymous, so nobody can
// link someone's posts or requests together, or share private posts with strangers by GUID.
// SQL: true when users `a` and `b` have matched or are connected.
const MATCHED = (a, b) => `(EXISTS (SELECT 1 FROM swipes ms JOIN events mt ON mt.id = ms.event_id
  WHERE ms.status IN ('accepted', 'attended', 'withdrawn')
    AND ((ms.attendee_id = ${a} AND mt.host_id = ${b}) OR (mt.host_id = ${a} AND ms.attendee_id = ${b})))
  OR EXISTS (SELECT 1 FROM connections mc WHERE (mc.a = ${a} AND mc.b = ${b}) OR (mc.a = ${b} AND mc.b = ${a})))`;

// Everyone's avatar is the Jdenticon of their GUID. Jdenticon draws from the SHA-1 of its input, so sending that hash
// lets any browser draw the same icon without learning the GUID (which a SHA-1 of 122 random bits doesn't reveal).
const iconHash = (guid) => createHash('sha1').update(guid).digest('hex');

// Taken spots on an event: matched attendees, including ones who already went.
const filledSpots = (eventId) =>
  q(`SELECT COUNT(*) n FROM swipes WHERE event_id = ? AND status IN ('accepted', 'attended')`).get(eventId).n;
const isFull = (t) => t.max_attendees !== null && filledSpots(t.id) >= t.max_attendees;

// Recompute open/full/past for a live event from its matched attendees, first moving people up from the waitlist
// (first come, first served) into any open spots. Call inside a transaction.
function syncEventStatus(eventId) {
  const t = q('SELECT id, host_id, title, status, max_attendees FROM events WHERE id = ?').get(eventId);
  if (!t || !['open', 'full'].includes(t.status)) return;
  const room = t.max_attendees === null ? -1 : t.max_attendees - filledSpots(eventId); // -1 = no limit (SQLite LIMIT)
  if (room !== 0) {
    for (const { id, attendee_id } of q(`SELECT id, attendee_id FROM swipes WHERE event_id = ? AND status = 'waitlisted' ORDER BY id LIMIT ?`).all(eventId, room)) {
      q(`UPDATE swipes SET status = 'accepted', reconfirm = 0 WHERE id = ?`).run(id);
      systemMessage(id, t.host_id, "🎉 A spot opened up, so you're off the waitlist and in!");
      notify(attendee_id, { body: `A spot opened up for ${quoted(t.title)}. You're in!`, tag: `chat-${id}`, open: `chat:${id}` });
    }
  }
  const { accepted, attended } = q(`
    SELECT COALESCE(SUM(status = 'accepted'), 0) accepted, COALESCE(SUM(status = 'attended'), 0) attended
    FROM swipes WHERE event_id = ?`).get(eventId);
  // No limit → stays open for more people until the host removes it.
  const status = t.max_attendees === null || accepted + attended < t.max_attendees ? 'open' : accepted === 0 ? 'past' : 'full';
  if (status !== t.status) q('UPDATE events SET status = ? WHERE id = ?').run(status, eventId);
}

// Private events: replace who may see one. guids come from the host's browser (contacts and groups expanded);
// unknown GUIDs, the host, and anyone the host hasn't matched with are skipped. Call inside a transaction.
function viewerIds(guids, hostId) {
  if (guids === undefined) return undefined;
  if (!Array.isArray(guids) || guids.length > MAX_VIEWERS || !guids.every(g => typeof g === 'string' && g.length <= 64))
    throw new HttpError(400, `Share with up to ${MAX_VIEWERS} people`);
  const find = q(`SELECT id FROM users u WHERE u.guid = :guid AND u.id != :host AND ${MATCHED(':host', 'u.id')}`);
  return [...new Set(guids.map(guid => find.get({ guid, host: hostId })?.id).filter(Boolean))];
}
function setViewers(eventId, ids) {
  if (ids === undefined) return;
  q('DELETE FROM event_viewers WHERE event_id = ?').run(eventId);
  const ins = q('INSERT INTO event_viewers (event_id, user_id) VALUES (?, ?)');
  for (const id of ids) ins.run(eventId, id);
}

function loadEvent(id) {
  const row = q(`SELECT t.*, ${TAGS_COL} FROM events t WHERE t.id = ?`).get(id);
  return row && withTags(row);
}

const systemMessage = (swipeId, senderId, body) =>
  q(`INSERT INTO messages (swipe_id, sender_id, body, kind) VALUES (?, ?, ?, 'system')`).run(swipeId, senderId, body);

// Runs fn in a transaction. Notifications sent inside it wait for the commit, so a rolled-back change never notifies.
let afterCommit = null;
function tx(fn) {
  afterCommit = [];
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    const later = afterCommit; afterCommit = null;
    for (const f of later) f();
    return r;
  } catch (e) { db.exec('ROLLBACK'); afterCommit = null; throw e; }
}

// ---------- push notifications ----------
// notify(userId, { body, tag, open }) sends to all of that user's devices, best effort. Text stays generic: the
// server doesn't know anyone's name, and messages are end-to-end encrypted. tag groups notifications on the device
// (a newer one replaces an older one with the same tag); open says what the app shows when it's tapped
// ('confirm', 'plans', 'profile' or 'chat:<matchId>'). Chat notifications are sent at most once a minute per chat.
const PUSH_SUBJECT = process.env.VAPID_SUBJECT || (process.env.ORIGIN?.startsWith('https:') ? process.env.ORIGIN : 'mailto:push@bored.invalid');
const lastPush = new Map(); // "userId:tag" → time, for throttling chat notifications
function notify(userId, { body, tag, open = '', throttle = false }) {
  if (afterCommit) return void afterCommit.push(() => notify(userId, { body, tag, open, throttle }));
  if (throttle) {
    const k = `${userId}:${tag}`, now = Date.now();
    if (now - (lastPush.get(k) || 0) < 60000) return;
    lastPush.set(k, now);
    if (lastPush.size > 10000) lastPush.clear();
  }
  for (const s of q('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId)) {
    sendPush(s, { title: 'Bored?', body, tag, open }, { subject: PUSH_SUBJECT, topic: tag }).then((status) => {
      if (status === 404 || status === 410) q('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
      else if (status >= 400) console.warn(`Push to subscription ${s.id} failed with HTTP ${status}`);
    }, (err) => console.warn(`Push to subscription ${s.id} failed: ${err.message}`));
  }
}
const quoted = (title) => `“${String(title).slice(0, 60)}”`;

// ---------- routes ----------

const routes = [];
// auth: true (must be signed in) | false (no user) | 'optional' (user if signed in, else null)
// mode: only register the route in this AUTH_MODE ('local' | '6j0'); default: always.
const route = (method, pattern, handler, { auth = true, mode } = {}) => {
  if (mode && mode !== AUTH_MODE) return;
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '(\\d+)'; }) + '$');
  routes.push({ method, re, keys, handler, auth });
};

// ---------- passkeys ----------
// Sign-up: the server picks the GUID; the browser creates a passkey (with the PRF extension), derives a vault key,
// encrypts its chat private key and empty vault with it, and sends only ciphertext plus the passkey's public key.

const webauthnCtx = (req, kind) => ({ origin: originOf(req), rpId: rpIdOf(req), kind });
const keyBundle = (user, wrappedKey) => ({
  user: publicUser(user),
  wrappedKey,
  chatPrivkey: user.chat_privkey,
  vault: { data: user.vault, version: user.vault_version },
});

route('POST', '/api/passkey/register/options', async ({ req, res }) => {
  const guid = randomUUID();
  send(res, 200, {
    challenge: newChallenge('register', { guid }),
    rp: { id: rpIdOf(req), name: 'Bored?' },
    user: { id: Buffer.from(guid).toString('base64url'), name: `Bored? ${guid.slice(0, 8)}`, displayName: 'Bored? account' },
  });
}, { auth: false, mode: 'local' });

route('POST', '/api/passkey/register/verify', async ({ req, body, res }) => {
  const reg = verifyRegistration(body, webauthnCtx(req, 'register'));
  const fields = {
    wrapped: sealed(body.wrappedKey, 'wrapped key'),
    pub: chatPubkey(body.chatPubkey),
    priv: sealed(body.chatPrivkey, 'chat key'),
    vault: sealed(body.vault, 'vault'),
  };
  const userId = tx(() => {
    const { lastInsertRowid } = q('INSERT INTO users (guid, chat_pubkey, chat_privkey, vault) VALUES (?, ?, ?, ?)')
      .run(reg.data.guid, fields.pub, fields.priv, fields.vault);
    q(`INSERT INTO passkeys (user_id, credential_id, public_key, alg, sign_count, wrapped_key, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`).run(lastInsertRowid, reg.credentialId, reg.publicKey, reg.alg, reg.signCount, fields.wrapped);
    return lastInsertRowid;
  });
  const user = q('SELECT * FROM users WHERE id = ?').get(userId);
  send(res, 200, { user: publicUser(user) }, newSession(res, userId));
}, { auth: false, mode: 'local' });

route('POST', '/api/passkey/login/options', async ({ req, res }) => {
  send(res, 200, { challenge: newChallenge('login'), rpId: rpIdOf(req) });
}, { auth: false, mode: 'local' });

route('POST', '/api/passkey/login/verify', async ({ req, body, res }) => {
  const pk = q('SELECT * FROM passkeys WHERE credential_id = ?').get(String(body.credentialId || ''));
  if (!pk) throw new HttpError(401, "This passkey isn't registered with Bored?. Was the account created on another site or deleted?");
  const { signCount } = verifyAssertion(body, pk, webauthnCtx(req, 'login'));
  const user = q('SELECT * FROM users WHERE id = ?').get(pk.user_id);
  if (body.userHandle && Buffer.from(body.userHandle, 'base64url').toString() !== user.guid) throw new HttpError(401, 'Passkey user mismatch');
  q(`UPDATE passkeys SET sign_count = ?, last_used_at = datetime('now') WHERE id = ?`).run(signCount, pk.id);
  send(res, 200, keyBundle(user, pk.wrapped_key), newSession(res, user.id));
}, { auth: false, mode: 'local' });

// Add another passkey to my account (e.g. a phone, a security key, or a password manager that supports PRF).
// The browser unlocks the vault key with an existing passkey, then wraps it for the new one.
route('POST', '/api/passkey/add/options', async ({ req, user, res }) => {
  const mine = q('SELECT credential_id, wrapped_key FROM passkeys WHERE user_id = ?').all(user.id);
  send(res, 200, {
    challenge: newChallenge('add', { userId: user.id }),
    rp: { id: rpIdOf(req), name: 'Bored?' },
    user: { id: Buffer.from(user.guid).toString('base64url'), name: `Bored? ${user.guid.slice(0, 8)}`, displayName: 'Bored? account' },
    existing: mine.map(p => ({ credentialId: p.credential_id, wrappedKey: p.wrapped_key })),
  });
}, { mode: 'local' });

route('POST', '/api/passkey/add/verify', async ({ req, user, body, res }) => {
  const reg = verifyRegistration(body, webauthnCtx(req, 'add'));
  if (reg.data.userId !== user.id) throw new HttpError(403, 'Passkey request was for a different account');
  q(`INSERT INTO passkeys (user_id, credential_id, public_key, alg, sign_count, wrapped_key) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(user.id, reg.credentialId, reg.publicKey, reg.alg, reg.signCount, sealed(body.wrappedKey, 'wrapped key'));
  send(res, 200, { ok: true });
}, { mode: 'local' });

route('GET', '/api/passkeys', async ({ user, res }) => {
  send(res, 200, q('SELECT id, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY id').all(user.id));
}, { mode: 'local' });

route('DELETE', '/api/passkeys/:id', async ({ user, params, res }) => {
  const n = q('SELECT COUNT(*) n FROM passkeys WHERE user_id = ?').get(user.id).n;
  if (n <= 1) throw new HttpError(409, "That's your only passkey. Add another one before removing it, or you'll lose your account.");
  const r = q('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(params.id, user.id);
  if (!r.changes) throw new HttpError(404, 'Passkey not found');
  send(res, 200, { ok: true });
}, { mode: 'local' });

// ---------- 6j0.org identity (AUTH_MODE=6j0) ----------
// The browser went to ID_ORIGIN/authorize and came back with a signed token plus this app's key, which only the
// page can decrypt. Known identity: return the key bundle and start a session. New identity: hand out a short-lived
// setup ticket, and the browser creates the vault and chat keys (wrapped under the app key) and calls /api/id/register.

route('GET', '/api/config', async ({ res }) => {
  send(res, 200, ID ? { authMode: AUTH_MODE, idOrigin: ID.origin, idApp: ID.app } : { authMode: AUTH_MODE });
}, { auth: false });

route('POST', '/api/id/login', async ({ body, res }) => {
  let claims;
  try {
    claims = await verifyIdToken(body.token, { issuer: ID.origin, audience: ID.app, nonce: body.nonce, jwksUrl: ID.jwksUrl });
  } catch (e) {
    if (e instanceof IdTokenError) throw new HttpError(401, e.message);
    console.error(e);
    throw new HttpError(502, "Couldn't reach the 6j0.org identity server. Please try again.");
  }
  const acct = q('SELECT * FROM id_accounts WHERE sub = ?').get(claims.sub);
  if (!acct) return send(res, 200, { setup: newChallenge('id-setup', { sub: claims.sub }) });
  const user = q('SELECT * FROM users WHERE id = ?').get(acct.user_id);
  send(res, 200, keyBundle(user, acct.wrapped_key), newSession(res, user.id));
}, { auth: false, mode: '6j0' });

route('POST', '/api/id/register', async ({ body, res }) => {
  let data;
  try { data = takeChallenge(String(body.setup || ''), 'id-setup'); } catch (e) { throw new HttpError(400, e.message); }
  const fields = {
    wrapped: sealed(body.wrappedKey, 'wrapped key'),
    pub: chatPubkey(body.chatPubkey),
    priv: sealed(body.chatPrivkey, 'chat key'),
    vault: sealed(body.vault, 'vault'),
  };
  const userId = tx(() => {
    if (q('SELECT 1 FROM id_accounts WHERE sub = ?').get(data.sub)) throw new HttpError(409, 'This identity already has an account. Please sign in again.');
    // A fresh public GUID, unrelated to the identity's sub, so other apps' users can't link accounts across apps.
    const { lastInsertRowid } = q('INSERT INTO users (guid, chat_pubkey, chat_privkey, vault) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), fields.pub, fields.priv, fields.vault);
    q('INSERT INTO id_accounts (user_id, sub, wrapped_key) VALUES (?, ?, ?)').run(lastInsertRowid, data.sub, fields.wrapped);
    return lastInsertRowid;
  });
  const user = q('SELECT * FROM users WHERE id = ?').get(userId);
  send(res, 200, { user: publicUser(user) }, newSession(res, userId));
}, { auth: false, mode: '6j0' });

// ---------- encrypted vault (contacts, nicknames) ----------
route('GET', '/api/vault', async ({ user, res }) => {
  send(res, 200, { data: user.vault, version: user.vault_version });
});

// Write with the version you read; 409 means another device saved first, so re-read, re-apply, retry.
route('PUT', '/api/vault', async ({ user, body, res }) => {
  const r = q('UPDATE users SET vault = ?, vault_version = vault_version + 1 WHERE id = ? AND vault_version = ?')
    .run(sealed(body.data, 'vault'), user.id, Number(body.version));
  if (!r.changes) throw new HttpError(409, 'Your contacts changed on another device');
  send(res, 200, { version: Number(body.version) + 1 });
});

route('POST', '/api/logout', async ({ req, res }) => {
  const { sid } = parseCookies(req.headers.cookie);
  if (sid) q('DELETE FROM sessions WHERE token = ?').run(sid);
  send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
}, { auth: false });

route('GET', '/api/me', async ({ user, res }) => {
  const counts = {
    confirm: q(`SELECT COUNT(*) n FROM swipes s JOIN events t ON t.id = s.event_id
               WHERE t.host_id = ? AND s.yes = 1 AND s.status = 'pending' AND t.status IN ('open', 'full')`).get(user.id).n
      + q(`SELECT COUNT(*) n FROM connection_requests WHERE owner_id = ? AND status = 'pending'`).get(user.id).n,
    plans: q(`SELECT COUNT(*) n FROM swipes s JOIN events t ON t.id = s.event_id
                WHERE s.status = 'accepted' AND (s.attendee_id = ? OR t.host_id = ?)`).get(user.id, user.id).n,
  };
  send(res, 200, { ...publicUser(user), counts });
});

const COST_FILTERS = ['free', 'paid'];

// Open events from other people that I haven't swiped on yet.
// Who may see an event (alias t) at all: anyone if it's public, otherwise its host and chosen viewers.
const VISIBLE = `(t.visibility = 'public' OR t.host_id = :me
  OR EXISTS (SELECT 1 FROM event_viewers v WHERE v.event_id = t.id AND v.user_id = :me))`;
// Full events stay in the deck: saying yes asks to join the waitlist.
const DISCOVERABLE = `t.status IN ('open', 'full') AND t.host_id != :me AND ${VISIBLE}
  AND NOT EXISTS (SELECT 1 FROM swipes s WHERE s.event_id = t.id AND s.attendee_id = :me)`;

// A date range from the query, "YYYY-MM-DD" days in the viewer's own calendar (only they know what "today" is):
// ?from=…&to=… → { from, to }, or null if not given or malformed.
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function dateRange(from, to) {
  return DAY_RE.test(from || '') && DAY_RE.test(to || '') && from <= to ? { from, to } : null;
}

// Distance filter: ?near=lat,lon&km=N, the viewer's spot (the browser rounds it to about a kilometre) and a radius.
const MAX_RADIUS_KM = 1000;
function nearFilter(near, km) {
  const m = /^(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$/.exec(near || '');
  const lat = m && Number(m[1]), lon = m && Number(m[2]), r = Number(km);
  return m && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && r > 0 && r <= MAX_RADIUS_KM ? { lat, lon, km: r } : null;
}
// Great-circle distance in km from { lat, lon } to an event's "lat,lon" location (Infinity without one).
function distanceKm({ lat, lon }, location) {
  const m = /^(-?[\d.]+),(-?[\d.]+)$/.exec(location || '');
  if (!m) return Infinity;
  const rad = Math.PI / 180, dLat = (m[1] - lat) * rad, dLon = (m[2] - lon) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat * rad) * Math.cos(m[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a)); // Earth's mean diameter, km
}

// Map picker: a friendly name for a spot (signed-in hosts only). ?lat=&lon=
route('GET', '/api/places/reverse', async ({ req, query, res }) => {
  const lat = Number(query.get('lat')), lon = Number(query.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    throw new HttpError(400, 'Bad coordinates');
  const lang = String(req.headers['accept-language'] || '').split(',')[0].trim().slice(0, 20).replace(/[^\w-]/g, '');
  send(res, 200, { name: await reverseGeocode(lat, lon, lang) });
});

// The Discover deck (also shown to signed-out guests). ?tags=a,b keeps events with ANY of those tags;
// ?cost=free or ?cost=paid keeps only free or paid events (both, or neither, = all); ?from=&to= keeps events that
// happen (or repeat) on one of those days. Where: ?near=&km= keeps events within that distance, and ?online=1 events
// you can join online (online only, or both); given both, either one will do (e.g. "within 10 miles, or online").
// Every filter given must match.
route('GET', '/api/discover', async ({ user, query, res }) => {
  const tags = parseTags(query.get('tags'));
  const costs = String(query.get('cost') || '').split(',').filter(c => COST_FILTERS.includes(c));
  const range = dateRange(query.get('from'), query.get('to'));
  const near = nearFilter(query.get('near'), query.get('km'));
  const online = query.get('online') === '1';
  const placed = (t) => (near && distanceKm(near, t.location) <= near.km) || (online && t.online > 0);
  const rows = q(`
    SELECT t.*, u.guid AS host_raw, CASE WHEN ${MATCHED(':me', 't.host_id')} THEN u.guid END AS host_guid, ${TAGS_COL}
    FROM events t JOIN users u ON u.id = t.host_id
    WHERE ${DISCOVERABLE}
      AND (:tags = '[]' OR EXISTS (SELECT 1 FROM event_tags tt WHERE tt.event_id = t.id AND tt.tag IN (SELECT value FROM json_each(:tags))))
      AND (:costs = '[]' OR (CASE WHEN t.cost_amount > 0 THEN 'paid' ELSE 'free' END) IN (SELECT value FROM json_each(:costs)))
      AND (:dated = 0 OR t.when_text != '')
      AND (:located = 0 OR t.location != '' OR t.online > 0)
    ORDER BY t.created_at DESC, t.id DESC
    LIMIT :limit`).all({ me: user?.id ?? -1, tags: JSON.stringify(tags), costs: JSON.stringify(costs),
      dated: range ? 1 : 0, located: near || online ? 1 : 0, limit: range || near || online ? -1 : 30 }) // date and place are checked in JS, so those read all, then cut
    .filter(t => !range || occursBetween(t.when_text, range.from, range.to))
    .filter(t => !(near || online) || placed(t)).slice(0, 30);
  send(res, 200, rows.map(({ host_id, host_raw, host_guid, ...t }) =>
    withTags({ ...t, host: { ...(host_guid ? { guid: host_guid } : {}), icon: iconHash(host_raw), ...stats(host_id) } })));
}, { auth: 'optional' });

// Filter options for Discover: tags and costs, each with how many discoverable events match. ?dates=key:from:to,…
// (the browser's own day ranges, e.g. today:2026-11-15:2026-11-15) adds a count for each of those ranges, and
// ?near=lat,lon&radii=km,km,… a count for each of those distances.
route('GET', '/api/discover/filters', async ({ user, query, res }) => {
  const me = user?.id ?? -1;
  const center = nearFilter(query.get('near'), 1);
  const radii = center ? String(query.get('radii') || '').split(',').slice(0, 10).map(Number).filter(k => k > 0 && k <= MAX_RADIUS_KM) : [];
  const located = radii.length ? q(`SELECT t.location FROM events t WHERE ${DISCOVERABLE} AND t.location != ''`).all({ me })
    .map(t => distanceKm(center, t.location)) : [];
  const distances = radii.map(km => ({ km, count: located.filter(d => d <= km).length }));
  const online = q(`SELECT COUNT(*) n FROM events t WHERE ${DISCOVERABLE} AND t.online > 0`).get({ me }).n;
  const ranges = String(query.get('dates') || '').split(',').slice(0, 10).map(x => x.split(':'))
    .map(([key, from, to]) => ({ key, range: dateRange(from, to) })).filter(x => /^[a-z]{1,20}$/.test(x.key || '') && x.range);
  const dated = ranges.length ? q(`SELECT t.when_text FROM events t WHERE ${DISCOVERABLE} AND t.when_text != ''`).all({ me }) : [];
  const dates = ranges.map(({ key, range }) => ({ key, count: dated.filter(t => occursBetween(t.when_text, range.from, range.to)).length }));
  const tags = q(`
    SELECT tt.tag, COUNT(*) AS count FROM event_tags tt JOIN events t ON t.id = tt.event_id
    WHERE ${DISCOVERABLE}
    GROUP BY tt.tag ORDER BY count DESC, tt.tag LIMIT 40`).all({ me });
  const byCost = Object.fromEntries(q(`
    SELECT CASE WHEN t.cost_amount > 0 THEN 'paid' ELSE 'free' END AS cost, COUNT(*) AS count
    FROM events t WHERE ${DISCOVERABLE} GROUP BY 1`).all({ me }).map(r => [r.cost, r.count]));
  send(res, 200, { tags, costs: COST_FILTERS.map(cost => ({ cost, count: byCost[cost] || 0 })), dates, distances, online });
}, { auth: 'optional' });

route('POST', '/api/events/:id/swipe', async ({ user, params, body, res }) => {
  const event = q(`SELECT * FROM events t WHERE t.id = :id AND ${VISIBLE}`).get({ id: params.id, me: user.id });
  if (!event || !['open', 'full'].includes(event.status)) throw new HttpError(404, 'That event is no longer open');
  if (event.host_id === user.id) throw new HttpError(400, "You can't swipe on your own event");
  const yes = body.yes ? 1 : 0;
  const r = q(`INSERT INTO swipes (event_id, attendee_id, yes, note, status) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(event_id, attendee_id) DO NOTHING`)
    .run(event.id, user.id, yes, str(body.note, 280, { field: 'Note' }), yes ? 'pending' : 'declined');
  if (yes && r.changes) notify(event.host_id, { body: `Someone wants to join ${quoted(event.title)}`, tag: 'confirm', open: 'confirm' });
  send(res, 200, { ok: true });
});

// Undo my swipe on an event, as long as the host hasn't matched with me yet. Also how I leave its waitlist.
route('DELETE', '/api/events/:id/swipe', async ({ user, params, res }) => {
  const sw = q('SELECT * FROM swipes WHERE event_id = ? AND attendee_id = ?').get(params.id, user.id);
  if (!sw) throw new HttpError(404, 'Nothing to undo');
  if (sw.yes && !['pending', 'waitlisted'].includes(sw.status))
    throw new HttpError(409, sw.status === 'accepted' || sw.status === 'attended'
      ? "They've already matched with you. Message them in Plans if you need to back out."
      : 'They already responded');
  q('DELETE FROM swipes WHERE id = ?').run(sw.id);
  send(res, 200, { ok: true });
});

// Confirm tab: people who swiped "yes" on my open events, waiting for me to swipe back.
route('GET', '/api/confirm', async ({ user, res }) => {
  const rows = q(`
    SELECT s.id, s.note, s.created_at, t.id AS event_id, t.title, ${TAGS_COL}, t.max_attendees, t.status = 'full' AS full,
           u.id AS attendee_id, u.guid AS raw, CASE WHEN ${MATCHED(':me', 'u.id')} THEN u.guid END AS guid
    FROM swipes s JOIN events t ON t.id = s.event_id JOIN users u ON u.id = s.attendee_id
    WHERE t.host_id = :me AND s.yes = 1 AND s.status = 'pending' AND t.status IN ('open', 'full')
    ORDER BY s.created_at, s.id`).all({ me: user.id });
  send(res, 200, rows.map(({ attendee_id, raw, guid, full, ...r }) =>
    withTags({ ...r, full: Boolean(full), attendee: { ...(guid ? { guid } : {}), icon: iconHash(raw), ...stats(attendee_id) } })));
});

route('POST', '/api/confirm/:id/respond', async ({ user, params, body, res }) => {
  const interest = q(`
    SELECT s.*, t.host_id, t.status AS event_status
    FROM swipes s JOIN events t ON t.id = s.event_id WHERE s.id = ?`).get(params.id);
  if (!interest || interest.host_id !== user.id || interest.status !== 'pending' || !['open', 'full'].includes(interest.event_status))
    throw new HttpError(404, 'Request not found');
  if (!body.yes) {
    q(`UPDATE swipes SET status = 'declined' WHERE id = ?`).run(interest.id);
    return send(res, 200, { match: false });
  }
  // A yes on a full event puts them on the waitlist; they're matched automatically when a spot opens.
  const waitlisted = tx(() => {
    const ev = q('SELECT id, title, max_attendees FROM events WHERE id = ?').get(interest.event_id);
    const full = isFull(ev);
    q(`UPDATE swipes SET status = ? WHERE id = ?`).run(full ? 'waitlisted' : 'accepted', interest.id);
    notify(interest.attendee_id, full
      ? { body: `${quoted(ev.title)} is full, so you're on the waitlist. You'll get the next spot.`, tag: `wait-${interest.id}`, open: 'plans' }
      : { body: `It's on! The host said yes to you for ${quoted(ev.title)}`, tag: `chat-${interest.id}`, open: `chat:${interest.id}` });
    syncEventStatus(interest.event_id);
    return full;
  });
  if (waitlisted) return send(res, 200, { match: false, waitlisted: true });
  // Now that they've matched, the host's browser may know who it is (to add them to contacts).
  send(res, 200, { match: true, matchId: interest.id, other: q('SELECT guid FROM users WHERE id = ?').get(interest.attendee_id).guid });
});

// Undo my response to someone interested: a "no thanks", or a fresh match nobody has messaged on yet.
route('POST', '/api/confirm/:id/undo', async ({ user, params, res }) => {
  const interest = q(`
    SELECT s.*, t.host_id, t.status AS event_status
    FROM swipes s JOIN events t ON t.id = s.event_id WHERE s.id = ?`).get(params.id);
  if (!interest || interest.host_id !== user.id || !interest.yes) throw new HttpError(404, 'Request not found');
  if (!['declined', 'accepted', 'waitlisted'].includes(interest.status) || !['open', 'full'].includes(interest.event_status))
    throw new HttpError(409, 'That can no longer be undone');
  if (interest.status === 'accepted' && q('SELECT 1 FROM messages WHERE swipe_id = ? LIMIT 1').get(interest.id))
    throw new HttpError(409, "You've already started chatting, so this match can't be undone");
  tx(() => {
    q(`UPDATE swipes SET status = 'pending', reconfirm = 0 WHERE id = ?`).run(interest.id);
    syncEventStatus(interest.event_id);
  });
  send(res, 200, { ok: true });
});

route('GET', '/api/matches', async ({ user, res }) => {
  const rows = q(`
    SELECT s.id, s.status, s.note, s.reconfirm, t.id AS event_id, t.title, ${TAGS_COL}, t.location, t.location_name, t.online, t.when_text, t.status AS event_status,
           t.host_id, s.attendee_id, cu.guid AS host_guid, hu.guid AS attendee_guid,
           cu.chat_pubkey AS host_pubkey, hu.chat_pubkey AS attendee_pubkey,
           (SELECT body FROM messages m WHERE m.swipe_id = s.id ORDER BY m.id DESC LIMIT 1) AS last_message,
           (SELECT kind FROM messages m WHERE m.swipe_id = s.id ORDER BY m.id DESC LIMIT 1) AS last_kind,
           CASE WHEN s.status = 'waitlisted' THEN (SELECT COUNT(*) FROM swipes w
             WHERE w.event_id = s.event_id AND w.status = 'waitlisted' AND w.id <= s.id) END AS waitlist_pos,
           s.status = 'waitlisted' AND ${MATCHED(':me', 't.host_id')} AS known_host
    FROM swipes s JOIN events t ON t.id = s.event_id
    JOIN users cu ON cu.id = t.host_id JOIN users hu ON hu.id = s.attendee_id
    WHERE (s.status IN ('accepted', 'attended', 'withdrawn') AND (s.attendee_id = :me OR t.host_id = :me))
       OR (s.status = 'waitlisted' AND s.attendee_id = :me AND t.status IN ('open', 'full'))
    ORDER BY s.status != 'accepted', s.id DESC`).all({ me: user.id });
  // "other" is the GUID of the person on the other side; the browser turns it into the nickname *you* gave them.
  send(res, 200, rows.map(({ host_id, attendee_id, host_guid, attendee_guid, host_pubkey, attendee_pubkey, ...r }) => {
    const mine = host_id === user.id;
    // On a waitlist you haven't matched yet, so the host stays anonymous (unless you matched before).
    const known = r.status !== 'waitlisted' || r.known_host;
    delete r.known_host;
    return withTags({
      ...r,
      role: mine ? 'host' : 'attendee',
      other: known ? (mine ? attendee_guid : host_guid) : null,
      other_pubkey: known ? JSON.parse((mine ? attendee_pubkey : host_pubkey) || 'null') : null,
    });
  }));
});

route('GET', '/api/matches/:id/messages', async ({ user, params, res }) => {
  loadMatch(params.id, user.id);
  send(res, 200, q(`
    SELECT m.id, m.body, m.kind, m.created_at, m.sender_id
    FROM messages m WHERE m.swipe_id = ? ORDER BY m.id`).all(params.id)
    .map(({ sender_id, ...m }) => ({ ...m, mine: sender_id === user.id })));
});

route('POST', '/api/matches/:id/messages', async ({ user, params, body, res }) => {
  const m = loadMatch(params.id, user.id);
  if (m.status === 'withdrawn') throw new HttpError(409, 'This match has ended');
  q('INSERT INTO messages (swipe_id, sender_id, body) VALUES (?, ?, ?)')
    .run(params.id, user.id, sealed(body.body, 'message', 8000)); // E2E ciphertext; the server can't read it
  notify(m.host_id === user.id ? m.attendee_id : m.host_id,
    { body: `New message about ${quoted(m.title)}`, tag: `chat-${m.id}`, open: `chat:${m.id}`, throttle: true });
  send(res, 200, { ok: true });
});

// Host marks that the event happened with this attendee. A full event becomes past once nobody is still accepted-but-not-attended.
route('POST', '/api/matches/:id/happened', async ({ user, params, res }) => {
  const m = loadMatch(params.id, user.id);
  if (m.host_id !== user.id) throw new HttpError(403, 'Only the host can mark this as happened');
  if (m.status === 'attended') return send(res, 200, { ok: true });
  if (m.status !== 'accepted') throw new HttpError(409, 'This match has ended');
  tx(() => {
    q(`UPDATE swipes SET status = 'attended', reconfirm = 0 WHERE id = ?`).run(m.id);
    syncEventStatus(m.event_id);
  });
  send(res, 200, { ok: true });
});

// Attendee answers "still in?" after the host edited the event.
route('POST', '/api/matches/:id/reconfirm', async ({ user, params, body, res }) => {
  const m = loadMatch(params.id, user.id);
  if (m.attendee_id !== user.id) throw new HttpError(403, 'Only the attendee can re-confirm');
  if (m.status !== 'accepted' || !m.reconfirm) throw new HttpError(409, 'Nothing to re-confirm');
  tx(() => {
    if (body.yes) {
      q('UPDATE swipes SET reconfirm = 0 WHERE id = ?').run(m.id);
      systemMessage(m.id, user.id, '✅ Re-confirmed: still in!');
    } else {
      q(`UPDATE swipes SET status = 'withdrawn', reconfirm = 0 WHERE id = ?`).run(m.id);
      systemMessage(m.id, user.id, "🚪 Can't make it after the change, so dropped out.");
      notify(m.host_id, { body: `Someone can't make ${quoted(m.title)} after your change`, tag: `chat-${m.id}`, open: `chat:${m.id}` });
      syncEventStatus(m.event_id);
    }
  });
  send(res, 200, { ok: true, withdrawn: !body.yes });
});

// Attendee can't make it anymore. Frees their spot, which goes to the first person on the waitlist.
route('POST', '/api/matches/:id/leave', async ({ user, params, res }) => {
  const m = loadMatch(params.id, user.id);
  if (m.attendee_id !== user.id) throw new HttpError(403, 'Only the attendee can drop out');
  if (m.status !== 'accepted') throw new HttpError(409, 'This match has ended');
  tx(() => {
    q(`UPDATE swipes SET status = 'withdrawn', reconfirm = 0 WHERE id = ?`).run(m.id);
    systemMessage(m.id, user.id, "🚪 Can't make it anymore, so dropped out.");
    notify(m.host_id, { body: `Someone dropped out of ${quoted(m.title)}`, tag: `chat-${m.id}`, open: `chat:${m.id}` });
    syncEventStatus(m.event_id);
  });
  send(res, 200, { ok: true });
});

route('GET', '/api/events', async ({ user, res }) => {
  send(res, 200, q(`
    SELECT t.*, ${TAGS_COL},
      (SELECT COUNT(*) FROM swipes s WHERE s.event_id = t.id AND s.yes = 1 AND s.status = 'pending') AS pending,
      (SELECT COUNT(*) FROM swipes s WHERE s.event_id = t.id AND s.status IN ('accepted', 'attended')) AS matched,
      (SELECT COUNT(*) FROM swipes s WHERE s.event_id = t.id AND s.status = 'accepted' AND s.reconfirm = 1) AS awaiting,
      (SELECT COUNT(*) FROM swipes s WHERE s.event_id = t.id AND s.status = 'waitlisted') AS waitlisted,
      (SELECT COUNT(*) FROM event_viewers v WHERE v.event_id = t.id) AS viewers
    FROM events t WHERE t.host_id = ? AND t.status != 'cancelled'
    ORDER BY t.status = 'past', t.id DESC`).all(user.id).map(withTags));
});

route('POST', '/api/events', async ({ user, body, res }) => {
  const f = eventFields(body);
  const id = tx(() => {
    const { lastInsertRowid } = q(`
      INSERT INTO events (host_id, title, details, location, location_name, online, when_text, cost_amount, cost_currency, visibility, max_attendees)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(user.id, f.title, f.details, f.location, f.location_name, f.online, f.when_text, f.cost_amount, f.cost_currency, f.visibility, f.max_attendees);
    setEventTags(lastInsertRowid, f.tags);
    setViewers(lastInsertRowid, viewerIds(body.viewers ?? [], user.id));
    return lastInsertRowid;
  });
  send(res, 200, loadEvent(id));
});

// Edit my event. Every matched attendee gets a chat message listing the changes and must re-confirm.
route('PATCH', '/api/events/:id', async ({ user, params, body, res }) => {
  const event = loadEvent(params.id);
  if (!event || event.host_id !== user.id) throw new HttpError(404, 'Event not found');
  if (!['open', 'full'].includes(event.status)) throw new HttpError(409, 'Finished posts can no longer be edited');
  const f = eventFields(body);
  const filled = filledSpots(event.id);
  if (f.max_attendees !== null && f.max_attendees < filled)
    throw new HttpError(400, `${filled} ${filled > 1 ? 'people are' : 'person is'} already matched, so max attendees must be at least ${filled} (or blank for no limit)`);

  const cost = (e) => costLabel(e.cost_amount, e.cost_currency, 'en-US');
  const place = (e) => e.location_name || e.location;
  const where = (e) => (e.online === 1 ? 'Online' : e.online === 2 ? `${place(e) || 'In person'} and online` : place(e));
  const value = (e, k) => (k === 'cost' ? cost(e) : k === 'location' ? `${e.online}|${e.location_name}|${e.location}` : e[k]);
  const changed = Object.keys(FIELD_LABELS).filter(k => JSON.stringify(value(f, k)) !== JSON.stringify(value(event, k)));
  // Who can see it isn't something attendees are told about or asked to re-confirm.
  const viewers = viewerIds(body.viewers, user.id);
  if (!changed.length) { tx(() => setViewers(event.id, viewers)); return send(res, 200, { event, notified: 0 }); }
  const show = (v) => (Array.isArray(v) ? (v.length ? v.join(', ') : '(none)') : v === null ? 'No limit' : v === '' ? '(none)' : String(v));
  const notice = '✏️ The post was updated:\n' +
    changed.map(k => k === 'details' ? '• Details were changed'
      : k === 'cost' ? `• Cost: ${cost(event)} → ${cost(f)}`
      : k === 'visibility' ? (f.visibility === 'public' ? '• Now public' : '• Now private')
      : k === 'location' ? `• Where: ${show(where(event))} → ${show(where(f))}`
      : k === 'when_text' ? `• When: ${show(whenLabel(event.when_text, { locale: 'en-US' }))} → ${show(whenLabel(f.when_text, { locale: 'en-US' }))}`
      : `• ${FIELD_LABELS[k]}: ${show(event[k])} → ${show(f[k])}`).join('\n') +
    '\nPlease re-confirm you can still make it.';

  const notified = tx(() => {
    q(`UPDATE events SET title = ?, details = ?, location = ?, location_name = ?, online = ?, when_text = ?, cost_amount = ?, cost_currency = ?, visibility = ?, max_attendees = ? WHERE id = ?`)
      .run(f.title, f.details, f.location, f.location_name, f.online, f.when_text, f.cost_amount, f.cost_currency, f.visibility, f.max_attendees, event.id);
    setEventTags(event.id, f.tags);
    setViewers(event.id, viewers);
    const attendees = q(`SELECT id, attendee_id FROM swipes WHERE event_id = ? AND status = 'accepted'`).all(event.id);
    for (const a of attendees) {
      q('UPDATE swipes SET reconfirm = 1 WHERE id = ?').run(a.id);
      systemMessage(a.id, user.id, notice);
      notify(a.attendee_id, { body: `${quoted(f.title)} changed. Can you still make it?`, tag: `chat-${a.id}`, open: `chat:${a.id}` });
    }
    syncEventStatus(event.id);
    return attendees.length;
  });
  send(res, 200, { event: loadEvent(event.id), notified });
});

// Replace who may see my private event. The browser calls this when the contacts in a group it was shared with change.
route('PUT', '/api/events/:id/viewers', async ({ user, params, body, res }) => {
  const event = q('SELECT id, host_id FROM events WHERE id = ?').get(params.id);
  if (!event || event.host_id !== user.id) throw new HttpError(404, 'Event not found');
  const ids = viewerIds(body.viewers, user.id) ?? [];
  tx(() => setViewers(event.id, ids));
  send(res, 200, { viewers: ids.length });
});

route('DELETE', '/api/events/:id', async ({ user, params, res }) => {
  const r = q(`UPDATE events SET status = 'cancelled' WHERE id = ? AND host_id = ? AND status != 'past'`).run(params.id, user.id);
  if (!r.changes) throw new HttpError(404, 'Event not found');
  send(res, 200, { ok: true });
});

// How many events I've been to with each person (as host or attendee), by GUID. The browser shows them under the nicknames in my encrypted contacts.
// ---------- invitations to connect ----------
// The link is ${origin}/#invite=<token>. The token stays in the URL fragment, so it never reaches a server's logs;
// we keep only its SHA-256. The owner's browser keeps the token itself (in their encrypted vault) to share it again.
const MAX_INVITES = 20;
const tokenHash = (t) => createHash('sha256').update(String(t)).digest('hex');
function findInvite(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new HttpError(404, 'That invitation link is not valid, or was deleted');
  const inv = q('SELECT * FROM invites WHERE token_hash = ?').get(tokenHash(token));
  if (!inv) throw new HttpError(404, 'That invitation link is not valid, or was deleted');
  return inv;
}
const connected = (x, y) => Boolean(q('SELECT 1 FROM connections WHERE a = ? AND b = ?').get(Math.min(x, y), Math.max(x, y)));

route('GET', '/api/invites', async ({ user, res }) => {
  send(res, 200, q('SELECT id, uses, created_at FROM invites WHERE owner_id = ? ORDER BY id DESC').all(user.id));
});

route('POST', '/api/invites', async ({ user, res }) => {
  if (q('SELECT COUNT(*) n FROM invites WHERE owner_id = ?').get(user.id).n >= MAX_INVITES)
    throw new HttpError(409, `You can have up to ${MAX_INVITES} invitations. Delete one first.`);
  const token = randomBytes(24).toString('base64url');
  const { lastInsertRowid } = q('INSERT INTO invites (owner_id, token_hash) VALUES (?, ?)').run(user.id, tokenHash(token));
  send(res, 200, { id: Number(lastInsertRowid), token, uses: 0 });
});

// Deleting an invitation stops new people using it; people already connected through it stay connected.
route('DELETE', '/api/invites/:id', async ({ user, params, res }) => {
  const r = q('DELETE FROM invites WHERE id = ? AND owner_id = ?').run(params.id, user.id);
  if (!r.changes) throw new HttpError(404, 'Invitation not found');
  send(res, 200, { ok: true });
});

// Before saying yes: the inviter's icon (not their GUID), and whether this is your own link, you're already
// connected, or you've already asked.
const requestOf = (ownerId, requesterId) =>
  q('SELECT * FROM connection_requests WHERE owner_id = ? AND requester_id = ?').get(ownerId, requesterId);
route('POST', '/api/invites/preview', async ({ user, body, res }) => {
  const inv = findInvite(body.token);
  const owner = q('SELECT guid FROM users WHERE id = ?').get(inv.owner_id);
  const asked = user && requestOf(inv.owner_id, user.id);
  send(res, 200, {
    icon: iconHash(owner.guid), mine: user?.id === inv.owner_id,
    connected: Boolean(user && connected(user.id, inv.owner_id)), requested: Boolean(asked && asked.status !== 'accepted'),
  });
}, { auth: 'optional' });

// The invitee says yes: ask the owner to connect, with the nickname they suggest for themselves (body.note, encrypted
// with the link's key, which we never see). Nothing is shared until the owner confirms. Asking again while pending
// updates the nickname; asking again after being declined quietly changes nothing, so a "no" stays a no.
route('POST', '/api/invites/accept', async ({ user, body, res }) => {
  const inv = findInvite(body.token);
  if (inv.owner_id === user.id) throw new HttpError(400, "That's your own invitation. Share it with someone else.");
  if (connected(user.id, inv.owner_id)) return send(res, 200, { status: 'connected' });
  const note = sealed(body.note, 'nickname', 1000);
  const fresh = !requestOf(inv.owner_id, user.id);
  q(`INSERT INTO connection_requests (owner_id, requester_id, invite_id, note) VALUES (?, ?, ?, ?)
     ON CONFLICT (owner_id, requester_id) DO UPDATE SET note = excluded.note, invite_id = excluded.invite_id
     WHERE connection_requests.status = 'pending'`).run(inv.owner_id, user.id, inv.id, note);
  if (fresh) notify(inv.owner_id, { body: 'Someone used your invitation and asked to connect', tag: 'confirm', open: 'confirm' });
  send(res, 200, { status: 'requested' });
});

// Confirm tab: people who used one of my invitation links and are waiting for me. Icon and their encrypted suggested
// nickname (note) only, no GUID until I say yes.
route('GET', '/api/connection-requests', async ({ user, res }) => {
  const rows = q(`
    SELECT r.id, r.created_at, r.requester_id, r.invite_id, r.note, u.guid
    FROM connection_requests r JOIN users u ON u.id = r.requester_id
    WHERE r.owner_id = ? AND r.status = 'pending' ORDER BY r.id`).all(user.id);
  send(res, 200, rows.map(({ requester_id, guid, ...r }) => ({ ...r, requester: { icon: iconHash(guid), ...stats(requester_id) } })));
});

function loadRequest(id, userId) {
  const r = q('SELECT * FROM connection_requests WHERE id = ?').get(id);
  if (!r || r.owner_id !== userId) throw new HttpError(404, 'Request not found');
  return r;
}

route('POST', '/api/connection-requests/:id/respond', async ({ user, params, body, res }) => {
  const r = loadRequest(params.id, user.id);
  if (r.status !== 'pending') throw new HttpError(409, 'You already answered this request');
  if (!body.yes) {
    q(`UPDATE connection_requests SET status = 'declined' WHERE id = ?`).run(r.id);
    return send(res, 200, { connected: false });
  }
  tx(() => {
    q(`UPDATE connection_requests SET status = 'accepted' WHERE id = ?`).run(r.id);
    q('INSERT OR IGNORE INTO connections (a, b) VALUES (?, ?)').run(Math.min(r.owner_id, r.requester_id), Math.max(r.owner_id, r.requester_id));
    if (r.invite_id) q('UPDATE invites SET uses = uses + 1 WHERE id = ?').run(r.invite_id);
    notify(r.requester_id, { body: "You're connected! They confirmed your request.", tag: 'connected', open: 'profile' });
  });
  send(res, 200, { connected: true, guid: q('SELECT guid FROM users WHERE id = ?').get(r.requester_id).guid });
});

// Undo my answer (right after swiping): back to pending, and an accept is disconnected again.
route('POST', '/api/connection-requests/:id/undo', async ({ user, params, res }) => {
  const r = loadRequest(params.id, user.id);
  if (r.status === 'pending') return send(res, 200, { ok: true });
  tx(() => {
    if (r.status === 'accepted') {
      q('DELETE FROM connections WHERE a = ? AND b = ?').run(Math.min(r.owner_id, r.requester_id), Math.max(r.owner_id, r.requester_id));
      if (r.invite_id) q('UPDATE invites SET uses = MAX(uses - 1, 0) WHERE id = ?').run(r.invite_id);
    }
    q(`UPDATE connection_requests SET status = 'pending' WHERE id = ?`).run(r.id);
  });
  send(res, 200, { ok: true });
});

// Everyone I'm connected with through invitations, so my browser can add them to my contacts.
route('GET', '/api/connections', async ({ user, res }) => {
  send(res, 200, q(`SELECT u.guid FROM connections c JOIN users u ON u.id = CASE WHEN c.a = ? THEN c.b ELSE c.a END
    WHERE c.a = ? OR c.b = ?`).all(user.id, user.id, user.id));
});

// ---------- push subscriptions ----------
route('GET', '/api/push/key', async ({ res }) => send(res, 200, { publicKey: vapidPublicKey() }), { auth: false });

// Save this device's subscription for me. The same device signing in as someone else moves it to them.
const MAX_DEVICES = 10;
route('POST', '/api/push/subscribe', async ({ user, body, res }) => {
  const { endpoint, keys = {} } = body;
  if (typeof endpoint !== 'string' || endpoint.length > 1000 || !validEndpoint(endpoint))
    throw new HttpError(400, "This browser's push service isn't supported");
  const p256dh = String(keys.p256dh || ''), auth = String(keys.auth || '');
  if (!/^[A-Za-z0-9_-]{86,88}$/.test(p256dh) || !/^[A-Za-z0-9_-]{21,24}$/.test(auth)) throw new HttpError(400, 'Bad push keys');
  tx(() => {
    q(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
      .run(user.id, endpoint, p256dh, auth);
    // Keep the newest few devices.
    q(`DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN
       (SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT ${MAX_DEVICES})`).run(user.id, user.id);
  });
  send(res, 200, { ok: true });
});

route('POST', '/api/push/unsubscribe', async ({ user, body, res }) => {
  q('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(String(body.endpoint || ''), user.id);
  send(res, 200, { ok: true });
});

route('POST', '/api/push/test', async ({ user, res }) => {
  notify(user.id, { body: "Notifications are on. You'll hear about requests, matches and messages here.", tag: 'test', open: 'profile' });
  send(res, 200, { ok: true });
});

route('GET', '/api/ledger', async ({ user, res }) => {
  const rows = q(`
    SELECT u.guid, COUNT(*) AS together
    FROM swipes s JOIN events t ON t.id = s.event_id
    JOIN users u ON u.id = CASE WHEN s.attendee_id = ? THEN t.host_id ELSE s.attendee_id END
    WHERE s.status = 'attended' AND (s.attendee_id = ? OR t.host_id = ?)
    GROUP BY u.id ORDER BY together DESC`).all(user.id, user.id, user.id);
  send(res, 200, rows);
});


// ---------- server ----------

const STATIC = {
  '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/secure.js': 'secure.js', '/style.css': 'style.css', '/location.js': 'location.js', '/when.js': 'when.js', '/cost.js': 'cost.js', '/ics.js': 'ics.js',
  '/sw.js': 'sw.js', '/manifest.webmanifest': 'manifest.webmanifest', '/icon.svg': 'icon.svg',
  '/fonts/bungee-latin.woff2': 'fonts/bungee-latin.woff2', // Bungee, SIL OFL 1.1 (see public/fonts/Bungee-OFL.txt)
};
// Browser files from npm packages (package.json), served from our own origin like everything else: npm is only
// needed to install them, never while the app runs. Paths are relative to this file.
const VENDOR = {
  '/vendor/jdenticon.js': 'node_modules/jdenticon/dist/jdenticon-module.mjs', // Jdenticon avatars, MIT
};
const MIME = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  woff2: 'font/woff2', webmanifest: 'application/manifest+json', svg: 'image/svg+xml' };

// Everything is served from this origin; a strict CSP keeps injected scripts away from the keys in the page.
// (style-src allows inline style attributes used in the markup; img-src allows OSM tiles for the location picker.)
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://tile.openstreetmap.org; " +
  "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (STATIC[url.pathname] || VENDOR[url.pathname])) {
      const file = STATIC[url.pathname] ? './public/' + STATIC[url.pathname] : './' + VENDOR[url.pathname];
      res.writeHead(200, {
        'Content-Type': MIME[file.split('.').pop()], 'Cache-Control': 'no-cache',
        'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      });
      return res.end(await readFile(new URL(file, import.meta.url)));
    }
    for (const r of routes) {
      const m = r.method === req.method && url.pathname.match(r.re);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, Number(m[i + 1])]));
      let user = null;
      if (r.auth) {
        const { sid } = parseCookies(req.headers.cookie);
        user = (sid && q('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(sid)) || null;
        if (!user && r.auth !== 'optional') throw new HttpError(401, 'Please sign in');
      }
      // Basic CSRF guard: state-changing requests must be same-origin JSON.
      if (req.method !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/json'))
        throw new HttpError(415, 'Expected application/json');
      const body = req.method === 'GET' ? {} : await readJson(req);
      return await r.handler({ req, res, user, params, body, query: url.searchParams });
    }
    throw new HttpError(404, 'Not found');
  } catch (e) {
    if (e instanceof WebAuthnError) e = new HttpError(400, e.message);
    if (!(e instanceof HttpError)) console.error(e);
    send(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'Something went wrong' });
  }
});

server.listen(PORT, () => console.log(`Bored? → http://localhost:${PORT}`));
