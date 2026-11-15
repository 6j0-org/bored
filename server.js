import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { newChallenge, verifyRegistration, verifyAssertion, WebAuthnError } from './webauthn.js';
import { db, parseTags, setEventTags, MAX_TAGS, COSTS, COST_LABELS, MAX_ATTENDEES_LIMIT } from './db.js';

const PORT = Number(process.env.PORT || 3000);
// Passkeys are bound to an origin. Defaults to whatever host the browser used (fine for localhost);
// set ORIGIN (e.g. https://bored.example) and optionally RP_ID in production.
const originOf = (req) => process.env.ORIGIN || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
const rpIdOf = (req) => process.env.RP_ID || new URL(originOf(req)).hostname;
const MAX_SEALED = 200 * 1024; // max size of one encrypted blob (vault, key) in characters

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

function eventFields(body) {
  // Open-to-everyone events (public, or ticketed elsewhere) never have a cap.
  const publicEvent = [true, 'on', 'true', '1', 1].includes(body.public_event) ? 1 : 0;
  return {
    public_event: publicEvent,
    title: str(body.title, 100, { required: true, field: 'Title' }),
    details: str(body.details, 1000, { field: 'Details' }),
    tags: tagsField(body.tags),
    cost: COSTS.includes(body.cost) ? body.cost : 'free',
    location: str(body.location, 100, { field: 'Location' }),
    when_text: str(body.when_text, 100, { field: 'When' }),
    max_attendees: publicEvent ? null : maxAttendeesField(body.max_attendees),
  };
}
const FIELD_LABELS = { title: 'Title', details: 'Details', tags: 'Tags', location: 'Where', when_text: 'When', cost: 'Cost', public_event: 'Open to everyone', max_attendees: 'Max attendees' };

// Recompute open/full/past for a live event from its matched attendees. Call inside a transaction.
function syncEventStatus(eventId) {
  const t = q('SELECT status, max_attendees FROM events WHERE id = ?').get(eventId);
  if (!t || !['open', 'full'].includes(t.status)) return;
  const { accepted, attended } = q(`
    SELECT COALESCE(SUM(status = 'accepted'), 0) accepted, COALESCE(SUM(status = 'attended'), 0) attended
    FROM swipes WHERE event_id = ?`).get(eventId);
  // No limit → stays open for more people until the host removes it.
  const status = t.max_attendees === null || accepted + attended < t.max_attendees ? 'open' : accepted === 0 ? 'past' : 'full';
  if (status !== t.status) q('UPDATE events SET status = ? WHERE id = ?').run(status, eventId);
}

function loadEvent(id) {
  const row = q(`SELECT t.*, ${TAGS_COL} FROM events t WHERE t.id = ?`).get(id);
  return row && withTags(row);
}

const systemMessage = (swipeId, senderId, body) =>
  q(`INSERT INTO messages (swipe_id, sender_id, body, kind) VALUES (?, ?, ?, 'system')`).run(swipeId, senderId, body);

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---------- routes ----------

const routes = [];
// auth: true (must be signed in) | false (no user) | 'optional' (user if signed in, else null)
const route = (method, pattern, handler, { auth = true } = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '(\\d+)'; }) + '$');
  routes.push({ method, re, keys, handler, auth });
};

// ---------- passkeys ----------
// Sign-up: the server picks the GUID; the browser creates a passkey (with the PRF extension), derives a vault key,
// encrypts its chat private key and empty vault with it, and sends only ciphertext plus the passkey's public key.

const webauthnCtx = (req, kind) => ({ origin: originOf(req), rpId: rpIdOf(req), kind });
const keyBundle = (user, passkey) => ({
  user: publicUser(user),
  wrappedKey: passkey.wrapped_key,
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
}, { auth: false });

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
}, { auth: false });

route('POST', '/api/passkey/login/options', async ({ req, res }) => {
  send(res, 200, { challenge: newChallenge('login'), rpId: rpIdOf(req) });
}, { auth: false });

route('POST', '/api/passkey/login/verify', async ({ req, body, res }) => {
  const pk = q('SELECT * FROM passkeys WHERE credential_id = ?').get(String(body.credentialId || ''));
  if (!pk) throw new HttpError(401, "This passkey isn't registered with Bored?. Was the account created on another site or deleted?");
  const { signCount } = verifyAssertion(body, pk, webauthnCtx(req, 'login'));
  const user = q('SELECT * FROM users WHERE id = ?').get(pk.user_id);
  if (body.userHandle && Buffer.from(body.userHandle, 'base64url').toString() !== user.guid) throw new HttpError(401, 'Passkey user mismatch');
  q(`UPDATE passkeys SET sign_count = ?, last_used_at = datetime('now') WHERE id = ?`).run(signCount, pk.id);
  send(res, 200, keyBundle(user, pk), newSession(res, user.id));
}, { auth: false });

// Add another passkey to my account (e.g. a phone, a security key, or a password manager like Bitwarden).
// The browser unlocks the vault key with an existing passkey, then wraps it for the new one.
route('POST', '/api/passkey/add/options', async ({ req, user, res }) => {
  const mine = q('SELECT credential_id, wrapped_key FROM passkeys WHERE user_id = ?').all(user.id);
  send(res, 200, {
    challenge: newChallenge('add', { userId: user.id }),
    rp: { id: rpIdOf(req), name: 'Bored?' },
    user: { id: Buffer.from(user.guid).toString('base64url'), name: `Bored? ${user.guid.slice(0, 8)}`, displayName: 'Bored? account' },
    existing: mine.map(p => ({ credentialId: p.credential_id, wrappedKey: p.wrapped_key })),
  });
});

route('POST', '/api/passkey/add/verify', async ({ req, user, body, res }) => {
  const reg = verifyRegistration(body, webauthnCtx(req, 'add'));
  if (reg.data.userId !== user.id) throw new HttpError(403, 'Passkey request was for a different account');
  q(`INSERT INTO passkeys (user_id, credential_id, public_key, alg, sign_count, wrapped_key) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(user.id, reg.credentialId, reg.publicKey, reg.alg, reg.signCount, sealed(body.wrappedKey, 'wrapped key'));
  send(res, 200, { ok: true });
});

route('GET', '/api/passkeys', async ({ user, res }) => {
  send(res, 200, q('SELECT id, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY id').all(user.id));
});

route('DELETE', '/api/passkeys/:id', async ({ user, params, res }) => {
  const n = q('SELECT COUNT(*) n FROM passkeys WHERE user_id = ?').get(user.id).n;
  if (n <= 1) throw new HttpError(409, "That's your only passkey. Add another one before removing it, or you'll lose your account.");
  const r = q('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(params.id, user.id);
  if (!r.changes) throw new HttpError(404, 'Passkey not found');
  send(res, 200, { ok: true });
});

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
               WHERE t.host_id = ? AND s.yes = 1 AND s.status = 'pending' AND t.status = 'open'`).get(user.id).n,
    plans: q(`SELECT COUNT(*) n FROM swipes s JOIN events t ON t.id = s.event_id
                WHERE s.status = 'accepted' AND (s.attendee_id = ? OR t.host_id = ?)`).get(user.id, user.id).n,
  };
  send(res, 200, { ...publicUser(user), counts });
});

// Open events from other people that I haven't swiped on yet.
const DISCOVERABLE = `t.status = 'open' AND t.host_id != :me
  AND NOT EXISTS (SELECT 1 FROM swipes s WHERE s.event_id = t.id AND s.attendee_id = :me)`;

// The Discover deck (also shown to signed-out guests). ?tags=a,b keeps events with ANY of those tags;
// ?cost=free,low keeps events at ANY of those costs. When both are given, an event must match both.
route('GET', '/api/discover', async ({ user, query, res }) => {
  const tags = parseTags(query.get('tags'));
  const costs = String(query.get('cost') || '').split(',').filter(c => COSTS.includes(c));
  const rows = q(`
    SELECT t.*, u.guid AS host_guid, ${TAGS_COL}
    FROM events t JOIN users u ON u.id = t.host_id
    WHERE ${DISCOVERABLE}
      AND (:tags = '[]' OR EXISTS (SELECT 1 FROM event_tags tt WHERE tt.event_id = t.id AND tt.tag IN (SELECT value FROM json_each(:tags))))
      AND (:costs = '[]' OR t.cost IN (SELECT value FROM json_each(:costs)))
    ORDER BY t.created_at DESC, t.id DESC
    LIMIT 30`).all({ me: user?.id ?? -1, tags: JSON.stringify(tags), costs: JSON.stringify(costs) });
  send(res, 200, rows.map(({ host_id, host_guid, ...t }) =>
    withTags({ ...t, host: { guid: host_guid, ...stats(host_id) } })));
}, { auth: 'optional' });

// Filter options for Discover: tags and costs, each with how many discoverable events match.
route('GET', '/api/discover/filters', async ({ user, res }) => {
  const me = user?.id ?? -1;
  const tags = q(`
    SELECT tt.tag, COUNT(*) AS count FROM event_tags tt JOIN events t ON t.id = tt.event_id
    WHERE ${DISCOVERABLE}
    GROUP BY tt.tag ORDER BY count DESC, tt.tag LIMIT 40`).all({ me });
  const byCost = Object.fromEntries(q(`SELECT t.cost, COUNT(*) AS count FROM events t WHERE ${DISCOVERABLE} GROUP BY t.cost`)
    .all({ me }).map(r => [r.cost, r.count]));
  send(res, 200, { tags, costs: COSTS.map(cost => ({ cost, count: byCost[cost] || 0 })) });
}, { auth: 'optional' });

route('POST', '/api/events/:id/swipe', async ({ user, params, body, res }) => {
  const event = q('SELECT * FROM events WHERE id = ?').get(params.id);
  if (!event || event.status !== 'open') throw new HttpError(404, 'That event is no longer open');
  if (event.host_id === user.id) throw new HttpError(400, "You can't swipe on your own event");
  const yes = body.yes ? 1 : 0;
  q(`INSERT INTO swipes (event_id, attendee_id, yes, note, status) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(event_id, attendee_id) DO NOTHING`)
    .run(event.id, user.id, yes, str(body.note, 280, { field: 'Note' }), yes ? 'pending' : 'declined');
  send(res, 200, { ok: true });
});

// Undo my swipe on an event, as long as the host hasn't matched with me yet.
route('DELETE', '/api/events/:id/swipe', async ({ user, params, res }) => {
  const sw = q('SELECT * FROM swipes WHERE event_id = ? AND attendee_id = ?').get(params.id, user.id);
  if (!sw) throw new HttpError(404, 'Nothing to undo');
  if (sw.yes && sw.status !== 'pending')
    throw new HttpError(409, sw.status === 'accepted' || sw.status === 'attended'
      ? "They've already matched with you. Message them in Plans if you need to back out."
      : 'They already responded');
  q('DELETE FROM swipes WHERE id = ?').run(sw.id);
  send(res, 200, { ok: true });
});

// Confirm tab: people who swiped "yes" on my open events, waiting for me to swipe back.
route('GET', '/api/confirm', async ({ user, res }) => {
  const rows = q(`
    SELECT s.id, s.note, s.created_at, t.id AS event_id, t.title, ${TAGS_COL}, t.max_attendees,
           u.id AS attendee_id, u.guid
    FROM swipes s JOIN events t ON t.id = s.event_id JOIN users u ON u.id = s.attendee_id
    WHERE t.host_id = ? AND s.yes = 1 AND s.status = 'pending' AND t.status = 'open'
    ORDER BY s.created_at, s.id`).all(user.id);
  send(res, 200, rows.map(({ attendee_id, guid, ...r }) => withTags({ ...r, attendee: { guid, ...stats(attendee_id) } })));
});

route('POST', '/api/confirm/:id/respond', async ({ user, params, body, res }) => {
  const interest = q(`
    SELECT s.*, t.host_id, t.status AS event_status
    FROM swipes s JOIN events t ON t.id = s.event_id WHERE s.id = ?`).get(params.id);
  if (!interest || interest.host_id !== user.id || interest.status !== 'pending' || interest.event_status !== 'open')
    throw new HttpError(404, 'Request not found');
  if (!body.yes) {
    q(`UPDATE swipes SET status = 'declined' WHERE id = ?`).run(interest.id);
    return send(res, 200, { match: false });
  }
  tx(() => {
    q(`UPDATE swipes SET status = 'accepted' WHERE id = ?`).run(interest.id);
    syncEventStatus(interest.event_id);
  });
  send(res, 200, { match: true, matchId: interest.id });
});

// Undo my response to someone interested: a "no thanks", or a fresh match nobody has messaged on yet.
route('POST', '/api/confirm/:id/undo', async ({ user, params, res }) => {
  const interest = q(`
    SELECT s.*, t.host_id, t.status AS event_status
    FROM swipes s JOIN events t ON t.id = s.event_id WHERE s.id = ?`).get(params.id);
  if (!interest || interest.host_id !== user.id || !interest.yes) throw new HttpError(404, 'Request not found');
  if (!['declined', 'accepted'].includes(interest.status) || !['open', 'full'].includes(interest.event_status))
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
    SELECT s.id, s.status, s.note, s.reconfirm, t.id AS event_id, t.title, ${TAGS_COL}, t.location, t.when_text, t.status AS event_status,
           t.host_id, s.attendee_id, cu.guid AS host_guid, hu.guid AS attendee_guid,
           cu.chat_pubkey AS host_pubkey, hu.chat_pubkey AS attendee_pubkey,
           (SELECT body FROM messages m WHERE m.swipe_id = s.id ORDER BY m.id DESC LIMIT 1) AS last_message,
           (SELECT kind FROM messages m WHERE m.swipe_id = s.id ORDER BY m.id DESC LIMIT 1) AS last_kind
    FROM swipes s JOIN events t ON t.id = s.event_id
    JOIN users cu ON cu.id = t.host_id JOIN users hu ON hu.id = s.attendee_id
    WHERE s.status IN ('accepted', 'attended', 'withdrawn') AND (s.attendee_id = ? OR t.host_id = ?)
    ORDER BY s.status != 'accepted', s.id DESC`).all(user.id, user.id);
  // "other" is the GUID of the person on the other side; the browser turns it into the nickname *you* gave them.
  send(res, 200, rows.map(({ host_id, attendee_id, host_guid, attendee_guid, host_pubkey, attendee_pubkey, ...r }) => {
    const mine = host_id === user.id;
    return withTags({
      ...r,
      role: mine ? 'host' : 'attendee',
      other: mine ? attendee_guid : host_guid,
      other_pubkey: JSON.parse((mine ? attendee_pubkey : host_pubkey) || 'null'),
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
  if (loadMatch(params.id, user.id).status === 'withdrawn') throw new HttpError(409, 'This match has ended');
  q('INSERT INTO messages (swipe_id, sender_id, body) VALUES (?, ?, ?)')
    .run(params.id, user.id, sealed(body.body, 'message', 8000)); // E2E ciphertext; the server can't read it
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
      syncEventStatus(m.event_id);
    }
  });
  send(res, 200, { ok: true, withdrawn: !body.yes });
});

route('GET', '/api/events', async ({ user, res }) => {
  send(res, 200, q(`
    SELECT t.*, ${TAGS_COL},
      (SELECT COUNT(*) FROM swipes s WHERE s.event_id = t.id AND s.yes = 1 AND s.status = 'pending') AS pending,
      (SELECT COUNT(*) FROM swipes s WHERE s.event_id = t.id AND s.status IN ('accepted', 'attended')) AS matched,
      (SELECT COUNT(*) FROM swipes s WHERE s.event_id = t.id AND s.status = 'accepted' AND s.reconfirm = 1) AS awaiting
    FROM events t WHERE t.host_id = ? AND t.status != 'cancelled'
    ORDER BY t.status = 'past', t.id DESC`).all(user.id).map(withTags));
});

route('POST', '/api/events', async ({ user, body, res }) => {
  const f = eventFields(body);
  const id = tx(() => {
    const { lastInsertRowid } = q(`
      INSERT INTO events (host_id, title, details, location, when_text, cost, public_event, max_attendees)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(user.id, f.title, f.details, f.location, f.when_text, f.cost, f.public_event, f.max_attendees);
    setEventTags(lastInsertRowid, f.tags);
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
  const filled = q(`SELECT COUNT(*) n FROM swipes WHERE event_id = ? AND status IN ('accepted', 'attended')`).get(event.id).n;
  if (f.max_attendees !== null && f.max_attendees < filled)
    throw new HttpError(400, `${filled} ${filled > 1 ? 'people are' : 'person is'} already matched, so max attendees must be at least ${filled} (or blank for no limit)`);

  const changed = Object.keys(FIELD_LABELS).filter(k => JSON.stringify(f[k]) !== JSON.stringify(event[k]));
  if (!changed.length) return send(res, 200, { event, notified: 0 });
  const show = (v) => (Array.isArray(v) ? (v.length ? v.join(', ') : '(none)') : v === null ? 'No limit' : v === '' ? '(none)' : String(v));
  const notice = '✏️ The post was updated:\n' +
    changed.map(k => k === 'details' ? '• Details were changed'
      : k === 'cost' ? `• Cost: ${COST_LABELS[event.cost]} → ${COST_LABELS[f.cost]}`
      : k === 'public_event' ? (f.public_event ? '• Now open to everyone' : '• No longer open to everyone')
      : `• ${FIELD_LABELS[k]}: ${show(event[k])} → ${show(f[k])}`).join('\n') +
    '\nPlease re-confirm you can still make it.';

  const notified = tx(() => {
    q(`UPDATE events SET title = ?, details = ?, location = ?, when_text = ?, cost = ?, public_event = ?, max_attendees = ? WHERE id = ?`)
      .run(f.title, f.details, f.location, f.when_text, f.cost, f.public_event, f.max_attendees, event.id);
    setEventTags(event.id, f.tags);
    const attendees = q(`SELECT id FROM swipes WHERE event_id = ? AND status = 'accepted'`).all(event.id);
    for (const a of attendees) {
      q('UPDATE swipes SET reconfirm = 1 WHERE id = ?').run(a.id);
      systemMessage(a.id, user.id, notice);
    }
    syncEventStatus(event.id);
    return attendees.length;
  });
  send(res, 200, { event: loadEvent(event.id), notified });
});

route('DELETE', '/api/events/:id', async ({ user, params, res }) => {
  const r = q(`UPDATE events SET status = 'cancelled' WHERE id = ? AND host_id = ? AND status != 'past'`).run(params.id, user.id);
  if (!r.changes) throw new HttpError(404, 'Event not found');
  send(res, 200, { ok: true });
});

// How many events I've been to with each person (as host or attendee), by GUID. The browser shows them under the nicknames in my encrypted contacts.
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
  '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/secure.js': 'secure.js', '/style.css': 'style.css',
  '/fonts/bungee-latin.woff2': 'fonts/bungee-latin.woff2', // Bungee, SIL OFL 1.1 (see public/fonts/Bungee-OFL.txt)
};
const MIME = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', woff2: 'font/woff2' };

// Everything is served from this origin; a strict CSP keeps injected scripts away from the keys in the page.
// (style-src allows inline style attributes used in the markup.)
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const file = STATIC[url.pathname];
      res.writeHead(200, {
        'Content-Type': MIME[file.split('.').pop()], 'Cache-Control': 'no-cache',
        'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      });
      return res.end(await readFile(new URL('./public/' + file, import.meta.url)));
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
