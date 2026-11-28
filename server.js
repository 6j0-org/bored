import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash, createHmac, createPublicKey, randomBytes, randomUUID, verify as verifySignature } from 'node:crypto';
import { newChallenge, takeChallenge, verifyRegistration, verifyAssertion, WebAuthnError } from './webauthn.js';
import { verifyIdToken, verifyDeletionToken, IdTokenError } from './idtoken.js';
import { postFields } from './public/postfields.js';
import { REPORT_REASONS as MODERATION_REASONS } from './public/moderation.js';
import { vapidPublicKey, validEndpoint, sendPush } from './push.js';
import { db, DEMO } from './db.js';
import { seedDemo, demoNames, demoSeed, demoBot, pruneVisitors } from './demo.js';
import { createFeedback, FeedbackError } from './feedback.js';

const PORT = Number(process.env.PORT || 3000);
// Passkeys are bound to an origin. Defaults to whatever host the browser used (fine for localhost);
// set ORIGIN (e.g. https://bored.example) and optionally RP_ID in production.
const originOf = (req) => process.env.ORIGIN || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
const rpIdOf = (req) => process.env.RP_ID || new URL(originOf(req)).hostname;
const MAX_SEALED = 200 * 1024; // max size of one encrypted blob (vault, key) in characters

// Who signs people in:
// - AUTH_MODE=local (default): Bored runs its own passkeys (RP ID = RP_ID or the ORIGIN hostname). Standalone.
// - AUTH_MODE=6j0: a 6j0.org identity server at ID_ORIGIN does. The browser comes back with a signed token and
//   this app's key from that server; the local passkey routes are switched off. ID_APP is this app's name in the
//   identity server's APPS list (default "bored"). ID_JWKS_URL overrides where its public keys are fetched from
//   (default ID_ORIGIN + /.well-known/jwks.json), e.g. an in-cluster Service URL.
// The two modes have separate accounts: switching a running instance from one to the other strands existing users.
// - DEMO=1 overrides both with "demo": no sign-in at all. Each browser gets its own throwaway account, filled with
//   demo content (demo.js), in an in-memory database (db.js). For trying the app out, never for real use.
if (DEMO && process.env.AUTH_MODE) console.warn(`DEMO=1: ignoring AUTH_MODE=${process.env.AUTH_MODE}`);
const AUTH_MODE = DEMO ? 'demo' : process.env.AUTH_MODE || 'local';
if (!['local', '6j0', 'demo'].includes(AUTH_MODE)) throw new Error(`AUTH_MODE must be "local" or "6j0", not "${AUTH_MODE}"`);
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

// Sessions last SESSION_DAYS from when they were last used: each day someone uses Bored, the cookie is renewed
// (sessionCookie, from the request handler), so only a browser left unused that long has to sign in again.
const SESSION_DAYS = 30;
const sessionCookie = (token) => `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * SESSION_DAYS}${
  String(process.env.ORIGIN || '').startsWith('https:') ? '; Secure' : ''}`;
function newSession(res, userId) {
  const token = randomBytes(24).toString('hex');
  q("INSERT INTO sessions (token, user_id, seen_at) VALUES (?, ?, datetime('now'))").run(token, userId);
  return { 'Set-Cookie': sessionCookie(token) };
}

// What anyone may learn about an account: its GUID. Never a name, and no activity counts: the server no longer
// knows who did what.
function publicUser(u) {
  return { guid: u.guid };
}

// Encrypted values from the browser look like "iv.ciphertext" in base64url. The server never decrypts them.
function sealed(v, field, max = MAX_SEALED) {
  if (typeof v !== 'string' || v.length > max || !/^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/.test(v)) throw new HttpError(400, `Bad ${field}`);
  return v;
}
function chatPubkey(v, field = 'chat key') {
  if (!v || v.kty !== 'EC' || v.crv !== 'P-256' || typeof v.x !== 'string' || typeof v.y !== 'string' || v.d) throw new HttpError(400, `Bad ${field}`);
  try { createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: v.x, y: v.y }, format: 'jwk' }); } catch { throw new HttpError(400, `Bad ${field}`); }
  return JSON.stringify({ kty: 'EC', crv: 'P-256', x: v.x, y: v.y });
}
// An inbox ID or read token: 32 bytes in base64url.
function inboxField(v, field = 'inbox') {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(v)) throw new HttpError(400, `Bad ${field}`);
  return v;
}
const inboxIdOf = (token) => createHash('sha256').update(token).digest('base64url');

// Check a signature made by public/secure.js sign(): ECDSA P-256, SHA-256, r || s, over "bored-v1 <kind>\n<text>".
function signedBy(jwkJson, kind, text, sig) {
  try {
    const key = createPublicKey({ key: JSON.parse(jwkJson), format: 'jwk' });
    return verifySignature('sha256', Buffer.from(`bored-v1 ${kind}\n${text}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(String(sig), 'base64url'));
  } catch { return false; }
}


// Geocoding for the location picker, from OpenStreetMap's Nominatim: coordinates → a friendly place name (reverse),
// and a typed query → matching places (search). The browser asks us rather than OSM, so it doesn't talk to another
// server. Nominatim's usage policy allows at most one request a second with an identifying User-Agent, so requests
// are spaced out and answers are cached. The policy also forbids search-as-you-type, so the picker searches on submit.
const NOMINATIM = 'https://nominatim.openstreetmap.org';
const placeCache = new Map(); // "lat,lon" (5 decimals, about a metre) → name
const searchCache = new Map(); // query, view, and language → results
let nextNominatim = 0;
// GET a Nominatim endpoint (e.g. 'reverse'), waiting our turn. failMsg is the error shown if OSM doesn't answer.
async function nominatim(path, params, lang, failMsg) {
  const wait = nextNominatim - Date.now();
  nextNominatim = Math.max(Date.now(), nextNominatim) + 1100;
  if (wait > 5000) throw new HttpError(503, 'Too many place lookups right now. Try again shortly.');
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  const r = await fetch(`${NOMINATIM}/${path}?${new URLSearchParams({ format: 'jsonv2', addressdetails: '1', ...params })}`, {
    headers: { 'User-Agent': 'Bored-event-app/0.1 (self-hosted)', ...(lang ? { 'Accept-Language': lang } : {}) },
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  if (!r?.ok) throw new HttpError(502, failMsg);
  return r.json();
}
const cachePut = (cache, key, value) => {
  if (cache.size > 1000) cache.delete(cache.keys().next().value);
  cache.set(key, value);
  return value;
};
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
  const j = await nominatim('reverse', { zoom: '18', lat, lon }, lang, "Couldn't look up a name for that spot. You can type one.");
  const name = placeName(j.address, j.name) || String(j.display_name || '').split(',').slice(0, 3).join(',').trim().slice(0, 100);
  return cachePut(placeCache, key, name);
}
// Up to 6 places matching q, preferring ones inside view ([west, south, east, north], the map's current view) without
// being limited to it, so "Ocean Beach" finds the nearby one first and "Paris" still finds Paris. Each has a name
// (short, for the place name box), detail (the rest of the address, to tell matches apart), lat, lon, and
// bbox ([south, north, west, east], to zoom the map to fit), or null.
async function searchPlaces(q, view, lang) {
  const key = `${q.toLowerCase()}|${view?.join(',') ?? ''}|${lang}`;
  if (searchCache.has(key)) return searchCache.get(key);
  const params = { q, limit: '6', ...(view ? { viewbox: view.join(','), bounded: '0' } : {}) };
  const rows = await nominatim('search', params, lang, "Couldn't search for places right now. Try moving the map instead.");
  const places = (Array.isArray(rows) ? rows : []).map((p) => {
    const name = placeName(p.address, p.name) || String(p.display_name || '').split(',')[0].trim().slice(0, 100);
    const detail = String(p.display_name || '').split(',').map(x => x.trim())
      .filter(x => x && !name.includes(x)).slice(0, 4).join(', ');
    const bbox = (p.boundingbox || []).map(Number);
    return { name, detail, lat: Number(p.lat), lon: Number(p.lon),
      bbox: bbox.length === 4 && bbox.every(Number.isFinite) ? bbox : null };
  }).filter(p => p.name && Number.isFinite(p.lat) && Number.isFinite(p.lon));
  return cachePut(searchCache, key, places);
}


// Everyone's avatar is the Jdenticon of their GUID. Jdenticon draws from the SHA-1 of its input, so sending that hash
// lets any browser draw the same icon without learning the GUID (which a SHA-1 of 122 random bits doesn't reveal).
const iconHash = (guid) => createHash('sha1').update(guid).digest('hex');

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
// ('confirm', 'plans', 'profile', or '' for wherever the app is). With throttle, at most one a minute per tag.
const PUSH_SUBJECT = process.env.VAPID_SUBJECT || (process.env.ORIGIN?.startsWith('https:') ? process.env.ORIGIN : 'mailto:push@bored.invalid');
const lastPush = new Map(); // "userId:tag" → time, for throttling
function notify(userId, { body, tag, open = '', throttle = false }) {
  if (afterCommit) return void afterCommit.push(() => notify(userId, { body, tag, open, throttle }));
  if (throttle) {
    const k = `${userId}:${tag}`, now = Date.now();
    if (now - (lastPush.get(k) || 0) < 60000) return;
    lastPush.set(k, now);
    if (lastPush.size > 10000) lastPush.clear();
  }
  for (const s of q('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId)) {
    sendPush(s, { title: 'Bored', body, tag, open }, { subject: PUSH_SUBJECT, topic: tag }).then((status) => {
      if (status === 404 || status === 410) q('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
      else if (status >= 400) console.warn(`Push to subscription ${s.id} failed with HTTP ${status}`);
    }, (err) => console.warn(`Push to subscription ${s.id} failed: ${err.message}`));
  }
  const nt = q('SELECT * FROM ntfy_topics WHERE user_id = ?').get(userId);
  if (nt) sendNtfy(nt, { body, open }).catch((err) => console.warn(`ntfy for user ${userId} failed: ${err.message}`));
}

// ---------- ntfy ----------
// For phones without Google Play services (e.g. GrapheneOS), where browsers can't get Web Push: the same
// notifications, published to a random topic on an ntfy server (https://ntfy.sh, or a self-hosted one) that the
// person subscribes to in the ntfy app. The text is the same generic text as Web Push, but it isn't encrypted:
// the ntfy server, and anyone who learns the topic, can read it. Bored only publishes to the servers in
// NTFY_SERVERS (comma-separated origins, each optionally "=<access token>"; default https://ntfy.sh), so nobody can
// point it at any other URL. A token goes with every publish to that server, e.g. for a paid ntfy.sh account's
// higher limits: free ntfy.sh limits how much one IP address (this server, for everyone) can publish a day.
const NTFY_SERVERS = new Map(String(process.env.NTFY_SERVERS ?? 'https://ntfy.sh').split(',').map(s => s.trim()).filter(Boolean).map(entry => {
  const i = entry.indexOf('='), origin = i < 0 ? entry : entry.slice(0, i), token = i < 0 ? '' : entry.slice(i + 1);
  const u = new URL(origin);
  if (u.origin !== origin || !['https:', 'http:'].includes(u.protocol)) throw new Error(`NTFY_SERVERS: "${origin}" must be a bare origin like https://ntfy.sh`);
  return [origin, token];
}));
async function sendNtfy(nt, { body, open }) {
  if (!NTFY_SERVERS.has(nt.server)) return; // taken out of NTFY_SERVERS since
  const token = NTFY_SERVERS.get(nt.server);
  const r = await fetch(nt.server + '/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ topic: nt.topic, title: 'Bored', message: body, click: `${nt.click}/${open ? `?open=${encodeURIComponent(open)}` : ''}` }),
    redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) console.warn(`ntfy publish to ${nt.server} failed with HTTP ${r.status}`);
}

// ---------- routes ----------

const routes = [];
// auth: true (must be signed in) | false (no user) | 'optional' (user if signed in, else null)
// mode: only register the route in this AUTH_MODE ('local' | '6j0' | 'demo'); default: always.
const route = (method, pattern, handler, { auth = true, mode } = {}) => {
  if (mode && mode !== AUTH_MODE) return;
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '(\\d+)'; }) + '$');
  routes.push({ method, re, keys, handler, auth });
};

// ---------- feedback ----------
// Signed-in people read everyone's feedback and post their own (feedback.js, first written for Glaze Journal; the
// page is public/feedback.js). Each post is a chat thread anyone signed in can reply to, which developers close as
// done or won't do. It's shared, so it isn't encrypted. Posts are filed under the account's GUID, which is
// never shown with them. It's kept in a JSON Lines file: FEEDBACK_PATH, by default feedback.jsonl next to the database.
// In the demo it goes to a temporary folder that's deleted on exit, and each visitor sees only their own posts, so the
// demo can't turn into an anonymous message board.
// Developers can reply to and close anyone's feedback and delete anyone's posts, and get a "Developer" badge and
// label. They're the accounts in DEVELOPER_GUIDS (each account's GUID is at the bottom of its Profile page), plus
// ADMIN_GUID (an account's GUID, in any mode) and ADMIN_SUB (a 6j0.org identity's sub, with AUTH_MODE=6j0) if set.
const DEVELOPER_GUIDS = [
  '182b0c35-5956-4e64-a881-e852c397c7f5',
];
const FEEDBACK_PATH = DEMO ? (() => {
  const dir = mkdtempSync(join(tmpdir(), 'bored-demo-feedback-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
  return join(dir, 'feedback.jsonl');
})() : process.env.FEEDBACK_PATH || join(dirname(process.env.DB_PATH || new URL('./data.sqlite', import.meta.url).pathname), 'feedback.jsonl');
// Posts and replies carry their author's icon hash (iconHash, below), so browsers draw everyone's avatar and show the
// names they gave their contacts, without learning anyone else's GUID.
const feedback = createFeedback({ file: FEEDBACK_PATH, scope: DEMO ? 'own' : 'all', authorKey: (guid) => iconHash(guid) });
const ADMIN_SUB = process.env.ADMIN_SUB || '', ADMIN_GUID = process.env.ADMIN_GUID || '';
function isDeveloper(user) {
  if (DEVELOPER_GUIDS.includes(user.guid) || (ADMIN_GUID && user.guid === ADMIN_GUID)) return true;
  return Boolean(ADMIN_SUB && AUTH_MODE === '6j0' && q('SELECT sub FROM id_accounts WHERE user_id = ?').get(user.id)?.sub === ADMIN_SUB);
}
const feedbackWho = (user) => ({ user: user.guid, admin: isDeveloper(user) });
function feedbackCall(fn) {
  try { return fn(); } catch (e) { if (e instanceof FeedbackError) throw new HttpError(e.status, e.message); throw e; }
}
// When someone else replies to someone's feedback, or a developer closes it, the person who posted it gets a push
// notification.
function notifyAuthor(user, id, body) {
  const author = feedback.authorOf(id);
  if (!author || author === user.guid) return;
  const to = q('SELECT id FROM users WHERE guid = ?').get(author);
  if (to) notify(to.id, { body, tag: `feedback-${id}`, open: `feedback:${id}` });
}
const STATUS_NEWS = { done: 'A developer marked your feedback as done. Thank you!', wontdo: "A developer closed your feedback as won't do.", open: 'A developer reopened your feedback.' };
route('GET', '/api/feedback', async ({ user, res }) => {
  send(res, 200, { ...feedbackCall(() => feedback.list(feedbackWho(user))), demo: DEMO });
});
route('POST', '/api/feedback', async ({ user, body, res }) => {
  send(res, 201, feedbackCall(() => feedback.post(feedbackWho(user), body.body)));
});
// Feedback IDs aren't numbers, which route()'s :params are, so these have their own patterns.
const feedbackRoute = (method, suffix, handler) => routes.push({
  method, re: new RegExp(`^/api/feedback/([A-Za-z0-9_-]{1,32})${suffix}$`), keys: [], auth: true,
  handler: (ctx) => { const parts = new URL(ctx.req.url, 'http://x').pathname.split('/'); return handler({ ...ctx, id: parts[3], sub: parts[5] }); },
});
feedbackRoute('GET', '', async ({ user, id, res }) => {
  send(res, 200, feedbackCall(() => feedback.thread(feedbackWho(user), id)));
});
// Editing your own post, or one of your replies.
feedbackRoute('PUT', '', async ({ user, id, body, res }) => {
  send(res, 200, feedbackCall(() => feedback.edit(feedbackWho(user), id, body.body)));
});
feedbackRoute('PUT', '/replies/[A-Za-z0-9_-]{1,32}', async ({ user, id, sub, body, res }) => {
  send(res, 200, feedbackCall(() => feedback.edit(feedbackWho(user), id, body.body, sub)));
});
feedbackRoute('DELETE', '', async ({ user, id, res }) => {
  feedbackCall(() => feedback.remove(feedbackWho(user), id));
  send(res, 200, { ok: true });
});
feedbackRoute('POST', '/replies', async ({ user, id, body, res }) => {
  const who = feedbackWho(user), thread = feedbackCall(() => feedback.reply(who, id, body.body));
  notifyAuthor(user, id, who.admin ? 'A developer replied to your feedback.' : 'Someone replied to your feedback.');
  send(res, 201, thread);
});
feedbackRoute('POST', '/status', async ({ user, id, body, res }) => {
  const who = feedbackWho(user), before = who.admin ? feedbackCall(() => feedback.thread(who, id)).status : null;
  const thread = feedbackCall(() => feedback.setStatus(who, id, body.status));
  if (thread.status !== before) notifyAuthor(user, id, STATUS_NEWS[thread.status]);
  send(res, 200, thread);
});

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
    rp: { id: rpIdOf(req), name: 'Bored' },
    user: { id: Buffer.from(guid).toString('base64url'), name: `Bored ${guid.slice(0, 8)}`, displayName: 'Bored account' },
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
  if (!pk) throw new HttpError(401, "This passkey isn't registered with Bored. Was the account created on another site or deleted?");
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
    rp: { id: rpIdOf(req), name: 'Bored' },
    user: { id: Buffer.from(user.guid).toString('base64url'), name: `Bored ${user.guid.slice(0, 8)}`, displayName: 'Bored account' },
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
  // saved: false means the identity was made with "Just start" and its account key isn't saved (see /api/me).
  const saved = claims.saved === false ? 0 : 1;
  const acct = q('SELECT * FROM id_accounts WHERE sub = ?').get(claims.sub);
  if (!acct) return send(res, 200, { setup: newChallenge('id-setup', { sub: claims.sub, saved }) });
  q(`UPDATE id_accounts SET id_saved = ?, checked_at = datetime('now') WHERE user_id = ?`).run(saved, acct.user_id);
  const user = q('SELECT * FROM users WHERE id = ?').get(acct.user_id);
  send(res, 200, keyBundle(user, acct.wrapped_key), newSession(res, user.id));
}, { auth: false, mode: '6j0' });

// An identity made with "Just start" lives only in the browser that made it, until its account key is saved at the
// identity server. idUnsaved: the page warns on every screen and links to ID_ORIGIN/#save. idRecheck: it's been a
// week since sign-in last said so, so the page signs in again (an instant redirect) to notice a save. That also
// counts as using the identity, which the identity server deletes if unsaved and unused for UNSAVED_TTL_DAYS.
function idUnsaved(user) {
  if (AUTH_MODE !== '6j0') return {};
  const a = q(`SELECT id_saved, checked_at IS NULL OR checked_at < datetime('now', '-7 days') AS stale FROM id_accounts WHERE user_id = ?`).get(user.id);
  return a?.id_saved === 0 ? { idUnsaved: true, idRecheck: Boolean(a.stale) } : {};
}

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
    q(`INSERT INTO id_accounts (user_id, sub, wrapped_key, id_saved, checked_at) VALUES (?, ?, ?, ?, datetime('now'))`)
      .run(lastInsertRowid, data.sub, fields.wrapped, data.saved ?? 1);
    return lastInsertRowid;
  });
  const user = q('SELECT * FROM users WHERE id = ?').get(userId);
  send(res, 200, { user: publicUser(user) }, newSession(res, userId));
}, { auth: false, mode: '6j0' });

// ---------- demo mode (DEMO=1) ----------
// No sign-in: the browser makes its keys and vault as usual (public/secure.js), and gets a fresh account plus
// nicknames for the demo accounts to save in its vault. Then, with its keys set up, it asks for /api/demo/seed to
// fill the account with demo posts, requests, plans, and chats (see demo.js).
const MAX_DEMO_VISITORS = 5000;
route('POST', '/api/demo/register', async ({ body, res }) => {
  const fields = { pub: chatPubkey(body.chatPubkey), priv: sealed(body.chatPrivkey, 'chat key'), vault: sealed(body.vault, 'vault') };
  if (q('SELECT COUNT(*) n FROM users').get().n > MAX_DEMO_VISITORS) throw new HttpError(503, 'The demo is full right now. Please try again later.');
  const userId = Number(q('INSERT INTO users (guid, chat_pubkey, chat_privkey, vault) VALUES (?, ?, ?, ?)')
    .run(randomUUID(), fields.pub, fields.priv, fields.vault).lastInsertRowid);
  const user = q('SELECT * FROM users WHERE id = ?').get(userId);
  send(res, 200, { user: publicUser(user), names: demoNames() }, newSession(res, userId));
}, { auth: false, mode: 'demo' });

route('POST', '/api/demo/seed', async ({ user, res }) => {
  if (!user.inbox_id || !user.chat_pubkey) throw new HttpError(400, 'Set up encryption first');
  send(res, 200, await demoSeed(user));
}, { mode: 'demo' });

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

// ---------- deleting an account ----------
// { confirm, inboxes } → everything this server holds for the account is erased, at once and for good: the users row
// and everything that cascades from it (keys, the encrypted vault, passkeys, sessions, public posts and the reports on
// them, invitations, connections, connection requests, and push subscriptions), the mail in its main inbox, the
// reports it filed, and its feedback posts and replies. confirm is the last 4 characters of the account's GUID (shown
// at the bottom of Profile), so a stray request can't do it. inboxes are read tokens for the inboxes the account
// writes to, which only its browser knows: its side of every channel (and its main inbox, which the server knows
// anyway). The server can't check that a channel inbox is the caller's side rather than the other person's, so
// someone deleting their account could erase the other side of their own chats too; nobody else's.
// With a 6j0.org identity the account is deleted there instead, with all of that identity's apps, and the identity
// server tells us (/api/id/deleted, below).
const MAX_ERASE_INBOXES = 10000;
// Erases an account: everything above, plus the mail in `inboxes` (inbox IDs).
function eraseAccount(user, inboxes = new Set()) {
  if (user.inbox_id) inboxes.add(user.inbox_id);
  tx(() => {
    const delMail = q('DELETE FROM mail WHERE inbox = ?'), delReport = q('DELETE FROM post_reports WHERE pid = ? AND who = ?');
    for (const inbox of inboxes) delMail.run(inbox);
    for (const { pid } of q('SELECT DISTINCT pid FROM post_reports').all()) delReport.run(pid, reporterOf(user, pid));
    q('DELETE FROM users WHERE id = ?').run(user.id);
  });
  feedback.eraseUser(user.guid);
}
route('POST', '/api/account/delete', async ({ user, body, res }) => {
  if (ID) throw new HttpError(400, `Your account belongs to your 6j0.org identity: delete it at ${ID.origin}`);
  if (String(body.confirm || '').trim().toLowerCase() !== user.guid.slice(-4).toLowerCase())
    throw new HttpError(400, "That isn't the end of your Account ID. It's at the bottom of your Profile page.");
  const tokens = Array.isArray(body.inboxes) ? body.inboxes : [];
  if (tokens.length > MAX_ERASE_INBOXES) throw new HttpError(400, `Up to ${MAX_ERASE_INBOXES} inboxes`);
  eraseAccount(user, new Set(tokens.map(t => inboxIdOf(inboxField(t, 'inbox token')))));
  send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
});

// AUTH_MODE=6j0: the identity server says an identity was deleted ({ token }, a signed deletion notice; see
// idtoken.js), so its account here is erased like above. Without the browser, the server doesn't know the account's
// channel inboxes, so its side of each chat stays (ciphertext only the other person can read, no longer tied to any
// account), and posts still on aren't cancelled first. Answers 200 also when there's no such account, so the identity
// server stops retrying.
route('POST', '/api/id/deleted', async ({ body, res }) => {
  try {
    const { sub } = await verifyDeletionToken(body.token, { issuer: ID.origin, audience: ID.app, jwksUrl: ID.jwksUrl });
    const acct = q('SELECT user_id FROM id_accounts WHERE sub = ?').get(sub);
    const user = acct && q('SELECT * FROM users WHERE id = ?').get(acct.user_id);
    if (user) eraseAccount(user);
  } catch (e) {
    if (e instanceof IdTokenError) throw new HttpError(401, e.message);
    throw e;
  }
  send(res, 200, { ok: true });
}, { auth: false, mode: '6j0' });

route('GET', '/api/me', async ({ user, res }) => {
  // Only connection requests: everything about posts is in encrypted mail, which the browser counts itself.
  const counts = { confirm: q(`SELECT COUNT(*) n FROM connection_requests WHERE owner_id = ? AND status = 'pending'`).get(user.id).n };
  // Badges: Developer (see DEVELOPER_GUIDS; every demo visitor gets the badge too, but not a developer's feedback
  // powers, which would let them see every visitor's feedback), and Tester with how many of their feedback posts
  // developers marked done.
  const badges = { developer: DEMO || isDeveloper(user), tester: feedback.doneCount(user.guid) };
  // Discover news (see "Discover news" below): perDay is 0 when this server doesn't send them.
  const discoverNews = { on: Boolean(user.discover_news), perDay: DISCOVER_NEWS_HOURS.length };
  send(res, 200, { ...publicUser(user), counts, badges, discoverNews, ...idUnsaved(user) });
});

// ---------- keys and mail ----------
// See "mail" in public/secure.js. The server stores mail by inbox ID and never learns who sent it. It does see which
// account sends each message as it arrives, for rate limits, which are kept in memory only.

// My keys, for this browser's ensureKeys(): the public ones, the encrypted signing key, and my main inbox ID.
route('GET', '/api/me/keys', async ({ user, res }) => {
  send(res, 200, {
    chatPubkey: user.chat_pubkey && JSON.parse(user.chat_pubkey),
    signPubkey: user.sign_pubkey && JSON.parse(user.sign_pubkey),
    signPrivkey: user.sign_privkey, inboxId: user.inbox_id,
  });
});

// Set my signing key and main inbox, once each: 409 if they're already set (another device was first).
route('PUT', '/api/me/keys', async ({ user, body, res }) => {
  if (body.signPubkey !== undefined) {
    const pub = chatPubkey(body.signPubkey, 'signing key'), priv = sealed(body.signPrivkey, 'signing key');
    if (!q('UPDATE users SET sign_pubkey = ?, sign_privkey = ? WHERE id = ? AND sign_pubkey IS NULL').run(pub, priv, user.id).changes)
      throw new HttpError(409, 'This account already has a signing key');
  }
  if (body.inboxId !== undefined) {
    const inbox = inboxField(body.inboxId);
    if (!q('UPDATE users SET inbox_id = ? WHERE id = ? AND inbox_id IS NULL').run(inbox, user.id).changes)
      throw new HttpError(409, 'This account already has an inbox');
  }
  send(res, 200, { ok: true });
});

// Public keys and main inboxes for GUIDs I know (my contacts). GUIDs can't be guessed. { guids } → { guid: keys }
const MAX_KEY_LOOKUPS = 200;
route('POST', '/api/keys', async ({ body, res }) => {
  const guids = Array.isArray(body.guids) ? [...new Set(body.guids.map(String))] : [];
  if (guids.length > MAX_KEY_LOOKUPS) throw new HttpError(400, `Up to ${MAX_KEY_LOOKUPS} at a time, please`);
  const out = {};
  for (const guid of guids) {
    const u = q('SELECT chat_pubkey, sign_pubkey, inbox_id FROM users WHERE guid = ?').get(guid);
    if (u?.chat_pubkey && u.sign_pubkey && u.inbox_id)
      out[guid] = { chat: JSON.parse(u.chat_pubkey), sign: JSON.parse(u.sign_pubkey), inbox: u.inbox_id };
  }
  send(res, 200, out);
});

// Send mail: { inbox, body } or { batch: [{ inbox, body }, …] }. Bodies are ciphertext: base64url parts and dots.
// Limits per sending account, in memory: so many messages an hour, and fewer to any one inbox. Someone's main inbox
// gets a "New activity" push (at most one a minute), unless it's the sender's own.
const MAX_MAIL = 64 * 1024, MAIL_PER_HOUR = 600, MAIL_PER_INBOX_HOUR = 60, MAX_BATCH = 100;
const mailCounts = new Map(); // `${userId}` or `${userId}:${inbox}` → { n, until }
function countMail(key, max) {
  const now = Date.now();
  let c = mailCounts.get(key);
  if (!c || c.until < now) { c = { n: 0, until: now + 3600_000 }; mailCounts.set(key, c); }
  if (++c.n > max) throw new HttpError(429, "You're sending a lot right now. Please wait a while and try again.");
  if (mailCounts.size > 100_000) for (const [k, v] of mailCounts) if (v.until < now) mailCounts.delete(k);
}
route('POST', '/api/mail', async ({ user, body, res }) => {
  const items = (body.batch !== undefined ? (Array.isArray(body.batch) ? body.batch : []) : [body]).map(m => {
    const b = m?.body;
    if (typeof b !== 'string' || b.length > MAX_MAIL || !/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/.test(b)) throw new HttpError(400, 'Bad mail');
    return { inbox: inboxField(m.inbox), body: b };
  });
  if (!items.length || items.length > MAX_BATCH) throw new HttpError(400, `Send 1 to ${MAX_BATCH} messages at a time`);
  for (const m of items) { countMail(String(user.id), MAIL_PER_HOUR); countMail(`${user.id}:${m.inbox}`, MAIL_PER_INBOX_HOUR); }
  const ids = tx(() => items.map(m => Number(q('INSERT INTO mail (inbox, body) VALUES (?, ?)').run(m.inbox, m.body).lastInsertRowid)));
  // Demo mode: the demo people answer before this returns, so the sender sees their replies on its next read.
  if (DEMO) await demoBot(items).catch(e => console.warn('demo bot:', e));
  for (const inbox of new Set(items.map(m => m.inbox))) {
    const owner = q('SELECT id FROM users WHERE inbox_id = ?').get(inbox);
    if (owner && owner.id !== user.id) notify(owner.id, { body: 'New activity', tag: 'mail', open: 'mail', throttle: true }); // the browser works out where
  }
  send(res, 200, { ids });
});

// Read mail: { inboxes: [{ token, after }] } → { mail: [[{ id, body, at }, …], …] } in the same order, up to
// MAIL_PAGE per inbox after the given mail ID (more: true if there's more). No sign-in: the browser calls this
// without cookies, so reading a channel inbox can't be tied to an account by the session.
const MAX_READ_INBOXES = 500, MAIL_PAGE = 200;
route('POST', '/api/mail/read', async ({ body, res }) => {
  const list = Array.isArray(body.inboxes) ? body.inboxes : [];
  if (list.length > MAX_READ_INBOXES) throw new HttpError(400, `Up to ${MAX_READ_INBOXES} inboxes at a time`);
  let more = false;
  const mail = list.map(({ token, after } = {}) => {
    const rows = q('SELECT id, body, created_at AS at FROM mail WHERE inbox = ? AND id > ? ORDER BY id LIMIT ?')
      .all(inboxIdOf(inboxField(token, 'inbox token')), Math.max(0, Number(after) || 0), MAIL_PAGE + 1);
    if (rows.length > MAIL_PAGE) { more = true; rows.pop(); }
    return rows;
  });
  send(res, 200, { mail, more });
}, { auth: false });

// ---------- public posts ----------
// A public post is a record signed by its host (public/secure.js signRecord): { body, sig, signer }, where body is
// the post's JSON (public/posts.js). Anyone can read them, guests too. Only the host can publish one or change it,
// and the server checks the signature, so it can't forge or change one itself; it can still take one down.

const MAX_PUBLIC_POST = 16 * 1024, PUBLIC_PER_HOUR = 120, PUBLIC_PAGE = 1000, MAX_PUBLIC_PIDS = 500;
const PID_RE = /^[A-Za-z0-9_-]{16,43}$/;
const POST_STATUSES = ['open', 'full', 'past', 'cancelled'];
const sameJwk = (json, jwk) => { try { const k = JSON.parse(json); return k.x === jwk?.x && k.y === jwk?.y; } catch { return false; } };

// Publish or update one of my public posts: { record }. The record must be signed with my signing key, say it's
// public, have a newer version than the one stored, and send requests to join to my own inbox and chat key. Its
// fields go through the same checks as the post form (postFields, including the personal info check).
route('PUT', '/api/public', async ({ user, body, res }) => {
  const record = body.record;
  if (!user.sign_pubkey || !user.inbox_id) throw new HttpError(400, 'Open Bored again to finish setting up encryption first');
  if (!record || typeof record.body !== 'string' || record.body.length > MAX_PUBLIC_POST || typeof record.sig !== 'string')
    throw new HttpError(400, 'Bad post');
  if (!sameJwk(user.sign_pubkey, record.signer) || !signedBy(user.sign_pubkey, 'post', record.body, record.sig))
    throw new HttpError(400, "That post isn't signed with your key");
  let post;
  try { post = JSON.parse(record.body); } catch { throw new HttpError(400, 'Bad post'); }
  if (post?.kind !== 'public' || !PID_RE.test(post.pid || '') || !Number.isInteger(post.v) || post.v < 1 || !POST_STATUSES.includes(post.status))
    throw new HttpError(400, 'Bad post');
  if (post.reply?.inbox !== user.inbox_id || !sameJwk(user.chat_pubkey, post.reply?.chat))
    throw new HttpError(400, 'Requests to join must go to your own inbox');
  const [start, ...rule] = String(post.when_text ?? '').split(';');
  // The same checks the post form makes (public/postfields.js); throws on anything a post can't have.
  await postFields({ ...post, when_text: start, when_repeat: rule.join(';') }).catch(e => { throw new HttpError(400, e.message); });
  countMail(`public:${user.id}`, PUBLIC_PER_HOUR);
  const live = ['open', 'full'].includes(post.status) ? 1 : 0;
  tx(() => {
    const cur = q('SELECT host_id, v FROM public_posts WHERE pid = ?').get(post.pid);
    if (cur && cur.host_id !== user.id) throw new HttpError(409, 'That post ID is taken');
    if (cur && cur.v >= post.v) throw new HttpError(409, 'A newer version of this post is already published');
    const seq = q('SELECT COALESCE(MAX(seq), 0) + 1 n FROM public_posts').get().n;
    q(`INSERT INTO public_posts (pid, host_id, v, body, live, seq, first_seq) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (pid) DO UPDATE SET v = excluded.v, body = excluded.body, live = excluded.live, seq = excluded.seq,
         updated_at = datetime('now')`)
      .run(post.pid, user.id, post.v, JSON.stringify({ body: record.body, sig: record.sig, signer: record.signer }), live, seq, seq);
  });
  send(res, 200, { ok: true });
});

// Read public posts: { after, pids } → { posts: [record], seq, more }. after: the seq from the last read; 0 (the
// first read) gets every live post, later reads get everything that changed since, including posts that ended. pids
// also gets those posts whatever their state (the ones I've asked to join). The browser calls this without cookies.
route('POST', '/api/public/read', async ({ body, res }) => {
  const after = Math.max(0, Number(body.after) || 0);
  const pids = Array.isArray(body.pids) ? [...new Set(body.pids.map(String))].filter(p => PID_RE.test(p)) : [];
  if (pids.length > MAX_PUBLIC_PIDS) throw new HttpError(400, `Up to ${MAX_PUBLIC_PIDS} posts at a time`);
  const rows = q(`SELECT seq, body FROM public_posts WHERE seq > ? AND (live = 1 OR ? > 0) ORDER BY seq LIMIT ?`)
    .all(after, after, PUBLIC_PAGE + 1);
  const more = rows.length > PUBLIC_PAGE;
  if (more) rows.pop();
  const seen = new Set(rows.map(r => r.seq));
  for (const pid of pids) {
    const r = q('SELECT seq, body FROM public_posts WHERE pid = ?').get(pid);
    if (r && !seen.has(r.seq)) { rows.push({ seq: 0, body: r.body }); seen.add(r.seq); }
  }
  const seq = rows.reduce((n, r) => Math.max(n, r.seq), after);
  send(res, 200, { posts: rows.map(r => JSON.parse(r.body)), seq, more });
}, { auth: false });

// ---------- reports on public posts ----------
// Signed-in people report public posts (spam, offensive, …). The server only counts: each browser decides what to
// hide from its own person's settings (public/moderation.js). One report per reason per account and post. Rows are
// filed under a keyed hash of the account and the post, not the account, so the table alone doesn't say who reported
// what. The server still sees who sends each report as it arrives, and it holds the key, so this keeps the table from
// being an easy list, not a secret.
const REPORT_REASONS = Object.keys(MODERATION_REASONS);
const REPORTS_PER_HOUR = 60;
const reportKey = (() => {
  let k = q(`SELECT value FROM app_settings WHERE key = 'report_key'`).get()?.value;
  if (!k) { k = randomBytes(32).toString('base64url'); q(`INSERT INTO app_settings (key, value) VALUES ('report_key', ?)`).run(k); }
  return k;
})();
const reporterOf = (user, pid) => createHmac('sha256', reportKey).update(`${user.guid}:${pid}`).digest('base64url').slice(0, 22);

// Report a public post: { pid, reasons }. The reasons replace my earlier ones for that post, so [] takes my report
// back.
route('POST', '/api/public/report', async ({ user, body, res }) => {
  const pid = String(body.pid || '');
  const reasons = Array.isArray(body.reasons) ? [...new Set(body.reasons.map(String))] : null;
  if (!PID_RE.test(pid) || !reasons || reasons.some(r => !REPORT_REASONS.includes(r))) throw new HttpError(400, 'Bad report');
  const post = q('SELECT host_id FROM public_posts WHERE pid = ?').get(pid);
  if (!post) throw new HttpError(404, 'That post is gone');
  if (post.host_id === user.id) throw new HttpError(400, "That's your own post");
  countMail(`report:${user.id}`, REPORTS_PER_HOUR);
  const who = reporterOf(user, pid);
  tx(() => {
    q('DELETE FROM post_reports WHERE pid = ? AND who = ?').run(pid, who);
    for (const r of reasons) q('INSERT INTO post_reports (pid, who, reason) VALUES (?, ?, ?)').run(pid, who, r);
  });
  send(res, 200, { ok: true });
});

// The report counts for some public posts: { pids } → { reports: { [pid]: { reason: n } } }, only for posts someone
// reported. Anyone can ask, guests too; the browser asks without cookies, like reading the posts.
route('POST', '/api/public/reports', async ({ body, res }) => {
  const pids = Array.isArray(body.pids) ? [...new Set(body.pids.map(String))].filter(p => PID_RE.test(p)) : [];
  if (pids.length > MAX_PUBLIC_PIDS) throw new HttpError(400, `Up to ${MAX_PUBLIC_PIDS} posts at a time`);
  const counts = q('SELECT reason, COUNT(*) n FROM post_reports WHERE pid = ? GROUP BY reason');
  const reports = {};
  for (const pid of pids) {
    const rows = counts.all(pid);
    if (rows.length) reports[pid] = Object.fromEntries(rows.map(r => [r.reason, r.n]));
  }
  send(res, 200, { reports });
}, { auth: false });

const placesLang = (req) => String(req.headers['accept-language'] || '').split(',')[0].trim().slice(0, 20).replace(/[^\w-]/g, '');

// Location picker: a friendly name for a spot (signed-in users only). ?lat=&lon=
route('GET', '/api/places/reverse', async ({ req, query, res }) => {
  const lat = Number(query.get('lat')), lon = Number(query.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    throw new HttpError(400, 'Bad coordinates');
  send(res, 200, { name: await reverseGeocode(lat, lon, placesLang(req)) });
});

// Location picker: places matching a typed search (signed-in users only). ?q=&view=west,south,east,north
// The view only ranks results. It's rounded to 2 decimals (about a kilometre) so nearby views share cached answers.
route('GET', '/api/places/search', async ({ req, query, res }) => {
  const q = String(query.get('q') || '').replace(/\s+/g, ' ').trim();
  if (q.length < 2) throw new HttpError(400, 'Type at least 2 letters to search');
  if (q.length > 200) throw new HttpError(400, 'That search is too long');
  const v = String(query.get('view') || '').split(',').map(Number);
  const view = v.length === 4 && v.every(Number.isFinite) && Math.abs(v[1]) <= 90 && Math.abs(v[3]) <= 90
    ? v.map(n => Math.max(-180, Math.min(180, n)).toFixed(2)) : null;
  send(res, 200, { places: await searchPlaces(q, view, placesLang(req)) });
});


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

// Confirm tab: people who used one of my invitation links and are waiting for me (or, with ?answered=1, the ones I
// said no to, for the discard pile). Icon and their encrypted suggested nickname (note) only, no GUID until I say yes.
route('GET', '/api/connection-requests', async ({ user, query, res }) => {
  const status = query.get('answered') === '1' ? 'declined' : 'pending';
  const rows = q(`
    SELECT r.id, r.created_at, r.requester_id, r.invite_id, r.note, u.guid
    FROM connection_requests r JOIN users u ON u.id = r.requester_id
    WHERE r.owner_id = ? AND r.status = ? ORDER BY r.id DESC LIMIT 200`).all(user.id, status);
  send(res, 200, rows.map(({ requester_id: _, guid, ...r }) => ({ ...r, requester: { icon: iconHash(guid) } })));
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

// Deleting a contact: { guid }. Removes our invitation connection, if there is one, so my browser doesn't add them
// back, and the requests behind it, so either of us can use an invitation again later. Matches aren't stored here
// (they're in mail), so a contact from a match has nothing to remove.
route('POST', '/api/connections/remove', async ({ user, body, res }) => {
  const other = typeof body.guid === 'string' && q('SELECT id FROM users WHERE guid = ?').get(body.guid);
  if (other) tx(() => {
    q('DELETE FROM connections WHERE a = ? AND b = ?').run(Math.min(user.id, other.id), Math.max(user.id, other.id));
    q(`DELETE FROM connection_requests WHERE (owner_id = ? AND requester_id = ?) OR (owner_id = ? AND requester_id = ?)`)
      .run(user.id, other.id, other.id, user.id);
  });
  send(res, 200, { ok: true });
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

// ntfy: the servers on offer, and my topic if I have one.
const ntfyView = (user) => {
  const nt = q('SELECT server, topic FROM ntfy_topics WHERE user_id = ?').get(user.id);
  return { servers: [...NTFY_SERVERS.keys()], topic: nt && NTFY_SERVERS.has(nt.server) ? { server: nt.server, topic: nt.topic } : null };
};
route('GET', '/api/ntfy', async ({ user, res }) => send(res, 200, ntfyView(user)));
// Turn ntfy on with a new random topic ({ server }), replacing any old one (e.g. if the topic got out).
route('POST', '/api/ntfy', async ({ req, user, body, res }) => {
  const server = String(body.server || '');
  if (!NTFY_SERVERS.has(server)) throw new HttpError(400, "That ntfy server isn't offered here");
  const topic = `bored_${randomBytes(24).toString('base64url')}`;
  q(`INSERT INTO ntfy_topics (user_id, server, topic, click) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET server = excluded.server, topic = excluded.topic, click = excluded.click, created_at = datetime('now')`)
    .run(user.id, server, topic, originOf(req));
  send(res, 200, ntfyView(user));
});
route('POST', '/api/ntfy/off', async ({ user, res }) => {
  q('DELETE FROM ntfy_topics WHERE user_id = ?').run(user.id);
  send(res, 200, ntfyView(user));
});

route('POST', '/api/push/test', async ({ user, res }) => {
  notify(user.id, { body: "Notifications are on. You'll hear about requests, matches, and messages here.", tag: 'test', open: 'profile' });
  send(res, 200, { ok: true });
});

// ---------- Discover news ----------
// "New posts in Discover", at most a few times a day: at each hour in DISCOVER_NEWS_HOURS (comma-separated, 0-23,
// in the server's time zone, TZ; default 10 and 16; empty turns it off), everyone who has notifications on (Web Push
// or ntfy) and hasn't turned these off hears about it if a public post went up since the last round, other than their
// own, and is still live. The text is generic: Discover's filters (where, tags, cost, and when) live in each browser,
// so the server can't tell whether the new posts are ones a person would see. kill -USR2 runs a round now.
const DISCOVER_NEWS_HOURS = [...new Set(String(process.env.DISCOVER_NEWS_HOURS ?? '10,16').split(',').map(h => h.trim()).filter(Boolean).map(h => {
  if (!/^\d{1,2}$/.test(h) || Number(h) > 23) throw new Error(`DISCOVER_NEWS_HOURS: "${h}" isn't an hour from 0 to 23`);
  return Number(h);
}))].sort((a, b) => a - b);
const newsSeq = {
  get: () => Number(q(`SELECT value FROM app_settings WHERE key = 'discover_news_seq'`).get()?.value ?? NaN),
  set: (n) => q(`INSERT INTO app_settings (key, value) VALUES ('discover_news_seq', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(String(n)),
};
const newestPost = () => q('SELECT COALESCE(MAX(first_seq), 0) n FROM public_posts').get().n;
// The first time, only posts from then on count, not everything already there.
if (Number.isNaN(newsSeq.get())) newsSeq.set(newestPost());

function discoverNews() {
  const since = newsSeq.get(), newest = newestPost();
  if (newest <= since) return;
  const who = q(`SELECT u.id FROM users u WHERE u.discover_news = 1
    AND (EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id = u.id) OR EXISTS (SELECT 1 FROM ntfy_topics t WHERE t.user_id = u.id))
    AND EXISTS (SELECT 1 FROM public_posts p WHERE p.first_seq > ? AND p.live = 1 AND p.host_id != u.id)`).all(since);
  newsSeq.set(newest);
  for (const { id } of who) notify(id, { body: 'New posts in Discover', tag: 'discover', open: 'discover' });
}
function scheduleDiscoverNews() {
  if (!DISCOVER_NEWS_HOURS.length) return;
  const now = new Date();
  const next = Math.min(...DISCOVER_NEWS_HOURS.map(h => {
    const d = new Date(now); d.setHours(h, 0, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }));
  setTimeout(() => {
    try { discoverNews(); } catch (e) { console.error('Discover news failed:', e); }
    scheduleDiscoverNews();
  }, next - now.getTime()).unref();
}
scheduleDiscoverNews();
process.on('SIGUSR2', () => { try { discoverNews(); } catch (e) { console.error('Discover news failed:', e); } });

// Turn Discover news on or off for my account: { on }.
route('PUT', '/api/me/discover-news', async ({ user, body, res }) => {
  if (typeof body.on !== 'boolean') throw new HttpError(400, 'Expected { on: true or false }');
  q('UPDATE users SET discover_news = ? WHERE id = ?').run(body.on ? 1 : 0, user.id);
  send(res, 200, { discoverNews: { on: body.on, perDay: DISCOVER_NEWS_HOURS.length } });
});


// ---------- server ----------

const STATIC = {
  '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/secure.js': 'secure.js', '/hpke.js': 'hpke.js', '/envelope.js': 'envelope.js', '/posts.js': 'posts.js', '/mail.js': 'mail.js', '/postfields.js': 'postfields.js', '/style.css': 'style.css', '/location.js': 'location.js', '/when.js': 'when.js', '/cost.js': 'cost.js', '/ics.js': 'ics.js', '/pointer.js': 'pointer.js', '/html.js': 'html.js', '/instagram.js': 'instagram.js',
  '/feedback.js': 'feedback.js', '/moderation.js': 'moderation.js',
  '/pii.js': 'pii.js', '/libphonenumber.js': 'libphonenumber.js',
  '/about': 'about.html', '/about.html': 'about.html', '/privacy': 'privacy.html', '/privacy.html': 'privacy.html', '/landing.js': 'landing.js', '/about.js': 'about.js', '/examples.js': 'examples.js',
  '/sw.js': 'sw.js', '/theme.js': 'theme.js', '/manifest.webmanifest': 'manifest.webmanifest', '/icon.svg': 'icon.svg', '/board.webp': 'board.webp', '/board-surf.svg': 'board-surf.svg', '/board-planed.svg': 'board-planed.svg', '/boards.css': 'boards.css',
  // National Park, SIL OFL 1.1 (see public/fonts/NationalPark-OFL.txt)
  '/fonts/national-park-latin.woff2': 'fonts/national-park-latin.woff2', '/fonts/national-park-latin-ext.woff2': 'fonts/national-park-latin-ext.woff2',
};
// Browser files from npm packages (package.json), served from our own origin like everything else: npm is only
// needed to install them, never while the app runs. Paths are relative to this file.
const VENDOR = {
  '/vendor/jdenticon.js': 'node_modules/jdenticon/dist/jdenticon-module.mjs', // Jdenticon avatars, MIT
  '/vendor/eat-the-pii.js': 'node_modules/@devopscoop/eat-the-pii/src/index.js', // personal info in posts, MIT
  '/vendor/libphonenumber-min.js': 'node_modules/libphonenumber-js/bundle/libphonenumber-min.js', // phone numbers, MIT
  '/vendor/profanity-en.json': 'node_modules/@dsojevic/profanity-list/en.json', // the built-in word list, MIT
};
const MIME = { html: 'text/html; charset=utf-8', json: 'application/json; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  woff2: 'font/woff2', webmanifest: 'application/manifest+json', svg: 'image/svg+xml', webp: 'image/webp' };

// Everything is served from this origin; a strict CSP keeps injected scripts away from the keys in the page.
// (style-src allows inline style attributes used in the markup; img-src allows OSM tiles for the location picker.)
// The one inline script, the import map in index.html, is allowed by its hash, worked out from the file itself.
const IMPORT_MAP = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8').match(/<script type="importmap">([\s\S]*?)<\/script>/)[1];
const CSP = `default-src 'self'; script-src 'self' 'sha256-${createHash('sha256').update(IMPORT_MAP).digest('base64')}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://tile.openstreetmap.org; ` +
  "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    // First visit: "/" shows the introduction. Its links go to "/?start", which remembers that with a "seen=1"
    // cookie (no ID, nothing about the person) and sends them on to the app at "/". Signed-in browsers always get
    // the app. URL fragments (invites, sign-in tokens) never reach the server: public/landing.js forwards those.
    if (req.method === 'GET' && url.pathname === '/') {
      if (url.searchParams.has('start')) {
        url.searchParams.delete('start');
        const secure = String(process.env.ORIGIN || '').startsWith('https:') ? '; Secure' : '';
        res.writeHead(302, {
          Location: '/' + url.search, 'Cache-Control': 'no-store',
          'Set-Cookie': `seen=1; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 365}${secure}`,
        });
        return res.end();
      }
      const { sid, seen } = parseCookies(req.headers.cookie);
      if (!sid && !seen) url.pathname = '/about';
    }
    if (req.method === 'GET' && (STATIC[url.pathname] || VENDOR[url.pathname])) {
      const file = STATIC[url.pathname] ? './public/' + STATIC[url.pathname] : './' + VENDOR[url.pathname];
      res.writeHead(200, {
        'Content-Type': MIME[file.split('.').pop()], 'Cache-Control': 'no-cache', 'Vary': 'Cookie',
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
        const s = sid && q(`SELECT s.user_id, s.seen_at < datetime('now', '-${SESSION_DAYS} days') AS expired,
          s.seen_at < datetime('now', '-1 day') AS stale FROM sessions s WHERE s.token = ?`).get(sid);
        if (s?.expired) q('DELETE FROM sessions WHERE token = ?').run(sid);
        else if (s) {
          user = q('SELECT * FROM users WHERE id = ?').get(s.user_id) || null;
          // Renew a session last renewed over a day ago. A route that sets its own cookie (sign out) replaces this one.
          if (user && s.stale) { q("UPDATE sessions SET seen_at = datetime('now') WHERE token = ?").run(sid); res.setHeader('Set-Cookie', sessionCookie(sid)); }
        }
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

if (DEMO) {
  await seedDemo();
  setInterval(pruneVisitors, 60 * 60 * 1000).unref();
}
server.listen(PORT, () => console.log(`Bored → http://localhost:${PORT}${DEMO ? ' (demo: no sign-in, nothing is saved)' : ''}`));
