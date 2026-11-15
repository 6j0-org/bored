// Seed demo accounts and posts so Discover has something in it.
// Demo accounts have no passkeys, so nobody can sign in as them; create your own accounts to try matching and chat.
// They do get a chat public key, so encrypted chats with them work (nobody will read them).
// Event rows: [host, title, details, tags, location, when, max_attendees (null = no limit), cost = 'free', public_event = false]
// Usage: node seed.js
import { generateKeyPairSync } from 'node:crypto';
import { db, setEventTags } from './db.js';

// Demo accounts get fixed, recognizable GUIDs (…-00000000000N) so re-running the seed doesn't duplicate them.
const users = ['maya', 'dev', 'rosa', 'sam']; // handles used only inside this file

const events = [
  ['maya', 'Pick up compost & spread it on my garden', 'About 2 cubic yards from the city yard. Need a truck and a second pair of hands with a wheelbarrow. Lemonade provided!', ['garden', 'hauling', 'outdoors'], 'Elm St', 'Saturday morning', 2],
  ['rosa', 'Walk my dog Biscuit while my hip heals', 'He is a sweet old beagle. 20 minutes around the block, any afternoon this week.', ['pets', 'outdoors'], 'Oak Park', 'Weekday afternoons', 1],
  ['sam', 'Help me move a couch up two flights', 'It is heavy but not huge. Pizza and beer after.', ['moving', 'food'], 'Downtown', 'Sunday 2pm', 2],
  ['dev', 'Fix a wobbly kitchen table', 'One leg is loose. I have glue and clamps but no clue.', ['repair'], 'Northside', 'Any evening', 1],
  ['maya', 'Set up a printer for my mom', 'It is wireless, in theory.', ['tech'], 'Elm St', 'This week', 1],
  ['rosa', 'Jazz in the park', 'Free outdoor concert by the bandstand. Bring a blanket; I will bring snacks.', ['events', 'social', 'outdoors'], 'Oak Park bandstand', 'Friday 6pm', null, 'free', true],
  ['sam', 'Trivia night at the Brass Tap', 'Need a team! Entry is $5 each and drinks are on you.', ['events', 'social', 'food'], 'Brass Tap, Main St', 'Wednesday 8pm', 3, 'low'],
  ['dev', 'Try the new ramen place', 'Heard it is great. Around $25 a bowl.', ['food', 'social'], 'Downtown', 'Thursday dinner', 2, 'medium'],
];

const ids = {};
users.forEach((handle, i) => {
  const guid = `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
  const pub = JSON.stringify(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' }));
  ids[handle] = db.prepare('SELECT id FROM users WHERE guid = ?').get(guid)?.id
    ?? db.prepare('INSERT INTO users (guid, chat_pubkey) VALUES (?, ?)').run(guid, pub).lastInsertRowid;
});
for (const [who, title, details, tags, location, when, maxAttendees, cost = 'free', publicEvent = false] of events) {
  if (db.prepare('SELECT 1 FROM events WHERE host_id = ? AND title = ?').get(ids[who], title)) continue;
  const { lastInsertRowid } = db.prepare('INSERT INTO events (host_id, title, details, location, when_text, max_attendees, cost, public_event) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(ids[who], title, details, location, when, publicEvent ? null : maxAttendees, cost, publicEvent ? 1 : 0);
  setEventTags(lastInsertRowid, tags);
}
console.log(`Seeded ${users.length} demo accounts (no passkeys; they can't sign in) and ${events.length} posts.`);
