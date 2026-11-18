// Demo content: a few demo accounts with public posts (seedDemo), and, in demo mode (DEMO=1), a ready-made account
// for each visitor with posts, requests, plans, and chats already in it (seedVisitor).
// Demo accounts have no passkeys, so nobody can sign in as them.
import { createCipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import { db, setEventTags } from './db.js';
import { repeatOptions } from './public/when.js';
import { EXAMPLES, exampleWhen } from './public/examples.js';

const q = (sql) => db.prepare(sql);

// Demo accounts get fixed, recognizable GUIDs (…-00000000000N) so re-running the seed doesn't duplicate them.
// The names are only used inside this file, and as the nicknames a demo visitor starts with.
// New accounts go at the end: the GUID is the position in this list.
const DEMO_USERS = {
  maya: 'Maya', dev: 'Dev', rosa: 'Rosa', sam: 'Sam',
  // Hosts of the life-stage examples in public/examples.js, from teens to seventies.
  jaylen: 'Jaylen', priya: 'Priya', hina: 'Hina', marcus: 'Marcus', ellie: 'Ellie', valeria: 'Valeria',
  nate: 'Nate', aisha: 'Aisha', camille: 'Camille', tom: 'Tom', lena: 'Lena', rodrigo: 'Rodrigo',
  gloria: 'Gloria', craig: 'Craig', jihoon: 'Ji-hoon', hank: 'Hank', linda: 'Linda', wanjiru: 'Wanjiru',
  walt: 'Walt', dottie: 'Dottie', giuseppe: 'Giuseppe',
};
const GUID_PREFIX = '00000000-0000-4000-8000-';
export const isDemoGuid = (guid) => String(guid).startsWith(GUID_PREFIX);

// Local date and time `days` from today, as stored in events.when_text.
const at = (days, hh, mm = 0) => {
  const d = new Date(); d.setDate(d.getDate() + days);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(hh)}:${p(mm)}`;
};

// A first occurrence plus one of its repeat choices by kind (public/when.js), e.g. every(at(2, 20), 'weekly').
const every = (start, kind) => `${start};${repeatOptions(start).find(o => o.kind === kind).rule}`;


const ids = {};         // handle → users.id
const chatKeys = {};    // handle → chat private key (KeyObject), kept in memory so demo accounts can "write" chats

// when is a when_text ("YYYY-MM-DDTHH:MM[;RRULE]"); place is the friendly name shown instead of the coordinates.
function addEvent(hostId, { title, details, tags, location, place = '', when, max = null, cost = 0, currency = 'USD' }, { visibility = 'public', status = 'open' } = {}) {
  const { lastInsertRowid } = q(`INSERT INTO events (host_id, title, details, location, location_name, when_text, max_attendees, cost_amount, cost_currency, visibility, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(hostId, title, details, location, place, when, max, cost, currency, visibility, status);
  setEventTags(lastInsertRowid, tags);
  return Number(lastInsertRowid);
}

// Create the demo accounts (or give existing ones fresh chat keys) and their public posts, the shared examples in
// public/examples.js (also the sample deck on the introduction page). Safe to run again.
export function seedDemo() {
  Object.keys(DEMO_USERS).forEach((handle, i) => {
    const guid = GUID_PREFIX + String(i + 1).padStart(12, '0');
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pub = JSON.stringify(publicKey.export({ format: 'jwk' }));
    chatKeys[handle] = privateKey;
    const existing = q('SELECT id FROM users WHERE guid = ?').get(guid);
    if (existing) q('UPDATE users SET chat_pubkey = ? WHERE id = ?').run(pub, existing.id);
    ids[handle] = existing?.id ?? Number(q('INSERT INTO users (guid, chat_pubkey) VALUES (?, ?)').run(guid, pub).lastInsertRowid);
  });
  for (const e of EXAMPLES) {
    if (q('SELECT 1 FROM events WHERE host_id = ? AND title = ?').get(ids[e.host], e.title)) continue;
    addEvent(ids[e.host], { ...e, when: exampleWhen(e.when) });
  }
  return { users: Object.keys(DEMO_USERS).length, events: EXAMPLES.length };
}

// A chat message between demo account `handle` and the person with chat public key `peerJwk`, encrypted the same
// way the browser does it (public/secure.js): ECDH → HKDF(salt "match:<id>", info "bored-chat-v1") → AES-256-GCM.
// The key is the same in both directions, so this can write the visitor's side of a chat too.
function sealChat(handle, peerJwk, matchId, text) {
  const shared = diffieHellman({ privateKey: chatKeys[handle], publicKey: createPublicKey({ key: JSON.parse(peerJwk), format: 'jwk' }) });
  const key = Buffer.from(hkdfSync('sha256', shared, `match:${matchId}`, 'bored-chat-v1', 32));
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return `${iv.toString('base64url')}.${ct.toString('base64url')}`;
}

// Messages are [from, text]: from is 'them' (the demo account) or 'me' (the visitor).
function addChat(matchId, handle, visitor, lines) {
  lines.forEach(([from, text], i) => {
    q(`INSERT INTO messages (swipe_id, sender_id, body, created_at) VALUES (?, ?, ?, datetime('now', ?))`)
      .run(matchId, from === 'me' ? visitor.id : ids[handle], sealChat(handle, visitor.chat_pubkey, matchId, text), `-${(lines.length - i) * 7} minutes`);
  });
}

const swipe = (eventId, attendeeId, status, note = '') => Number(q(
  `INSERT INTO swipes (event_id, attendee_id, yes, note, status) VALUES (?, ?, 1, ?, ?)`).run(eventId, attendeeId, note, status).lastInsertRowid);

// Fill a new demo visitor's account so every tab has something in it. Returns the nicknames the visitor starts with
// for the demo accounts, { guid: name }, which the browser saves into the visitor's own encrypted vault.
export function seedVisitor(visitorId) {
  const visitor = q('SELECT * FROM users WHERE id = ?').get(visitorId);
  const viewers = (eventId, ...who) => who.forEach(h => q('INSERT INTO event_viewers (event_id, user_id) VALUES (?, ?)').run(eventId, ids[h]));

  // Confirm: two people want to join the visitor's hike.
  const hike = addEvent(visitorId, { title: 'Sunrise hike up Cowles Mountain', details: 'Meet at the main trailhead. About 3 miles round trip, steady climb. Bring water and a headlamp.',
    tags: ['hiking'], location: '32.812600,-117.031200', place: 'Cowles Mountain trailhead', when: at(3, 6), max: 3 }, { visibility: 'private' });
  viewers(hike, 'maya', 'dev');
  swipe(hike, ids.maya, 'pending', 'I have a spare headlamp if anyone needs one.');
  swipe(hike, ids.dev, 'pending');

  // Plans: the visitor is hosting pickup basketball with Sam…
  const hoops = addEvent(visitorId, { title: 'Pickup basketball', details: 'Half court, casual. All skill levels welcome.',
    tags: ['fitness'], location: '32.737300,-117.154200', place: 'Balboa Park', when: every(at(1, 17, 30), 'weekly'), max: 4 }, { visibility: 'private' });
  viewers(hoops, 'sam');
  const hoopsMatch = swipe(hoops, ids.sam, 'accepted', 'I can bring a ball.');
  addChat(hoopsMatch, 'sam', visitor, [
    ['them', 'Hey! Is the court by the rec center or the one by the school?'],
    ['me', 'Rec center. The school one has no nets right now.'],
    ['them', 'Perfect. I will bring a ball and a pump.'],
  ]);

  // …and getting ramen with Dev.
  const ramen = q(`SELECT id FROM events WHERE host_id = ? AND title = 'Get some ramen at Chef Jun'`).get(ids.dev).id;
  const ramenMatch = swipe(ramen, visitorId, 'accepted');
  addChat(ramenMatch, 'dev', visitor, [
    ['them', 'Glad you can come! I will grab a table by the window.'],
    ['me', 'Great. Do they take reservations?'],
    ['them', 'Nope, so I will get there a few minutes early.'],
  ]);

  // History: a beach cleanup that already happened, so Profile shows stats and a contact you've done things with.
  // (Only the visitor attends: each visitor gets their own copy, so every demo attendee would count it again.)
  const cleanup = addEvent(ids.maya, { title: 'Beach cleanup at Ocean Beach', details: 'Gloves and bags provided.',
    tags: ['volunteering'], location: '32.749500,-117.252100', place: 'Ocean Beach', when: at(-9, 9), max: 6 }, { visibility: 'private', status: 'past' });
  q('INSERT INTO event_viewers (event_id, user_id) VALUES (?, ?)').run(cleanup, visitorId);
  swipe(cleanup, visitorId, 'attended');

  return Object.fromEntries(['maya', 'dev', 'sam'].map(h => [q('SELECT guid FROM users WHERE id = ?').get(ids[h]).guid, DEMO_USERS[h]]));
}

// When a demo visitor says yes to a demo account's post, the demo host says yes back with a short hello.
export function demoHostReply(swipeId, visitor, hostGuid) {
  const handle = Object.keys(ids).find(h => q('SELECT guid FROM users WHERE id = ?').get(ids[h]).guid === hostGuid);
  if (!handle || !visitor.chat_pubkey) return;
  addChat(swipeId, handle, visitor, [['them', "Yay, you're in! See you there."]]);
}

// Demo visitors' accounts last a day.
export function pruneVisitors() {
  q(`DELETE FROM users WHERE guid NOT LIKE '${GUID_PREFIX}%' AND created_at < datetime('now', '-1 day')`).run();
}
