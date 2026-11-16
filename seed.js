// Seed demo accounts and posts so Discover has something in it.
// Demo accounts have no passkeys, so nobody can sign in as them; create your own accounts to try matching and chat.
// They do get a chat public key, so encrypted chats with them work (nobody will read them).
// Event rows: [host, title, details, tags, location ("lat,lon"), when ("YYYY-MM-DDTHH:MM", local), max_attendees (null = no limit), cost = 0 (free), currency = 'USD']
// Demo posts are public, so they show up for everyone in Discover.
// Usage: node seed.js
import { generateKeyPairSync } from 'node:crypto';
import { db, setEventTags } from './db.js';
import { repeatOptions } from './public/when.js';

// Demo accounts get fixed, recognizable GUIDs (…-00000000000N) so re-running the seed doesn't duplicate them.
const users = ['maya', 'dev', 'rosa', 'sam']; // handles used only inside this file

// Local date and time `days` from today, as stored in events.when_text.
const at = (days, hh, mm = 0) => {
  const d = new Date(); d.setDate(d.getDate() + days);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(hh)}:${p(mm)}`;
};

// A first occurrence plus one of its repeat choices by kind (public/when.js), e.g. every(at(2, 20), 'weekly').
const every = (start, kind) => `${start};${repeatOptions(start).find(o => o.kind === kind).rule}`;

const events = [
  ['maya', 'Pick up compost & spread it on my garden', 'About 2 cubic yards from the city yard. Need a truck and a second pair of hands with a wheelbarrow. Lemonade provided!', ['garden', 'hauling', 'outdoors'], '32.748310,-117.130630', at(5, 9), 2],
  ['rosa', 'Walk my dog Biscuit while my hip heals', 'He is a sweet old beagle. 20 minutes around the block, any afternoon this week.', ['pets', 'outdoors'], '32.731400,-117.146100', at(1, 15, 30), 1],
  ['sam', 'Help me move a couch up two flights', 'It is heavy but not huge. Pizza and beer after.', ['moving', 'food'], '32.715700,-117.161100', at(6, 14), 2],
  ['dev', 'Fix a wobbly kitchen table', 'One leg is loose. I have glue and clamps but no clue.', ['repair'], '32.755800,-117.208700', at(2, 18, 30), 1],
  ['maya', 'Set up a printer for my mom', 'It is wireless, in theory.', ['tech'], '32.748310,-117.130630', at(3, 17), 1],
  ['rosa', 'Jazz in the park', 'Free outdoor concert by the bandstand. Bring a blanket; I will bring snacks.', ['events', 'social', 'outdoors'], '32.731000,-117.150300', every(at(4, 18), 'nthday'), null],
  ['sam', 'Trivia night at the Brass Tap', 'Need a team! Entry is $5 each and drinks are on you.', ['events', 'social', 'food'], '32.719649,-117.220272', every(at(2, 20), 'weekly'), 3, 5, 'USD'],
  ['dev', 'Try the new ramen place', 'Heard it is great. Around $25 a bowl.', ['food', 'social'], '32.711800,-117.160500', at(3, 19), 2, 25, 'USD'],
];

const ids = {};
users.forEach((handle, i) => {
  const guid = `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
  const pub = JSON.stringify(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' }));
  ids[handle] = db.prepare('SELECT id FROM users WHERE guid = ?').get(guid)?.id
    ?? db.prepare('INSERT INTO users (guid, chat_pubkey) VALUES (?, ?)').run(guid, pub).lastInsertRowid;
});
for (const [who, title, details, tags, location, when, maxAttendees, cost = 0, currency = 'USD'] of events) {
  if (db.prepare('SELECT 1 FROM events WHERE host_id = ? AND title = ?').get(ids[who], title)) continue;
  const { lastInsertRowid } = db.prepare('INSERT INTO events (host_id, title, details, location, when_text, max_attendees, cost_amount, cost_currency, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(ids[who], title, details, location, when, maxAttendees, cost, currency, 'public');
  setEventTags(lastInsertRowid, tags);
}
console.log(`Seeded ${users.length} demo accounts (no passkeys; they can't sign in) and ${events.length} posts.`);
