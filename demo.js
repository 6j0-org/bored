// Demo mode (DEMO=1): demo accounts with real keys and signed public posts (seedDemo), a small bot that answers
// mail sent to them (demoBot), and a starting point for each visitor's account (demoNames, demoSeed).
//
// The demo accounts have no sign-in, so nobody can sign in as them. Their private keys live only in this process's
// memory, which is what lets the bot read and write their mail. Everything goes through the same message formats and
// rules the browser uses (public/envelope.js and public/posts.js), so a visitor sees exactly what real people would
// send. The database is in memory too, so a restart starts everything over.
//
// Seeding a visitor takes both sides, since only the visitor's browser can sign the visitor's posts:
// 1. The browser registers (/api/demo/register, which returns nicknames for the demo people), sets up its keys, and
//    asks for /api/demo/seed. That shares two past private posts with the visitor (Maya's beach cleanup and Sam's
//    shelves) and returns what the browser should do next: posts to make, and posts to ask to join.
// 2. The browser makes the visitor's posts (a hike shared with Maya and Dev, pickup basketball shared with Sam) and
//    asks to join Dev's ramen, the cleanup, and the shelves.
// 3. The bot answers as it goes (see visitorPosts and HOST_REPLIES): Maya and Dev ask to join the hike, Sam asks to
//    join basketball and they're already chatting, Dev says yes to ramen and chats, and the cleanup and shelves are
//    marked as happened.
// When a visitor asks to join any other demo post, its host says yes on every other post (by the order in
// public/examples.js) and never answers on the rest, so visitors see requests that are still waiting too.
// To fill in a conversation the bot also writes the visitor's side of it on the channel (it knows the channel
// secret, as both sides do). Only chat lines and answers, never a hello: those are signed, by the visitor's browser.
import { db } from './db.js';
import { EXAMPLES, exampleWhen } from './public/examples.js';
import * as env from './public/envelope.js';
import { nextMessage } from './public/posts.js';

const q = (sql) => db.prepare(sql);
const subtle = globalThis.crypto.subtle;

// Demo accounts get fixed, recognizable GUIDs (…-00000000000N). The names are only used inside this file, and as
// the nicknames a demo visitor starts with. New accounts go at the end: the GUID is the position in this list.
// Retired accounts stay as null, so the GUIDs after them don't change.
const DEMO_USERS = {
  maya: 'Maya', dev: 'Dev', rosa: 'Rosa', sam: 'Sam',
  // Retired: their posts sounded like they were by people under 18.
  jaylen: null, priya: null, hina: null,
  // Hosts of the life-stage examples in public/examples.js, from twenties to seventies. Retired (null): the hosts of
  // the examples that weren't in English.
  marcus: 'Marcus', ellie: 'Ellie', valeria: null,
  nate: 'Nate', aisha: 'Aisha', camille: null, tom: 'Tom', lena: 'Lena', rodrigo: null,
  gloria: 'Gloria', craig: 'Craig', jihoon: null, hank: 'Hank', linda: 'Linda', wanjiru: null,
  walt: 'Walt', dottie: 'Dottie', giuseppe: null,
};
const GUID_PREFIX = '00000000-0000-4000-8000-';

// Local date and time `days` from today, as in a post's when_text.
const at = (days, hh, mm = 0) => exampleWhen([days, hh, mm]);

// The visitor's own posts (made by their browser), and what the demo people do when one is shared with them.
// lines: [from, text], from 'them' (the demo person) or 'me' (the visitor). A function, so dates are from today.
const visitorPosts = () => [
  { fields: { title: 'Sunrise hike up Cowles Mountain', details: 'Meet at the main trailhead. About 3 miles round trip, steady climb. Bring water and a headlamp.',
      tags: ['hiking'], location: '32.812600,-117.031200', location_name: 'Cowles Mountain trailhead', when_text: at(3, 6), max_attendees: 3 },
    share: ['maya', 'dev'],
    joins: { maya: { note: 'I have a spare headlamp if anyone needs one.' }, dev: { note: '' } } },
  { fields: { title: 'Pickup basketball', details: 'Half court, casual. All skill levels welcome.',
      tags: ['fitness'], location: '32.737300,-117.154200', location_name: 'Balboa Park', when_text: exampleWhen([1, 17, 30, 'weekly']), max_attendees: 4 },
    share: ['sam'],
    joins: { sam: { note: 'I can bring a ball.', accepted: true, lines: [
      ['them', 'Hey! Is the court by the rec center or the one by the school?'],
      ['me', 'Rec center. The school one has no nets right now.'],
      ['them', 'Perfect. I will bring a ball and a pump.'],
    ] } } },
];

// Posts the demo people share with each visitor: ones that already happened, which the visitor's browser asks to
// join, so Profile shows people the visitor has done things with (and, for the shelves, one person helped).
const pastPosts = () => [
  { host: 'maya', fields: { title: 'Beach cleanup at Ocean Beach', details: 'Gloves and bags provided.',
      tags: ['volunteering'], location: '32.749500,-117.252100', location_name: 'Ocean Beach', when_text: at(-9, 9), max_attendees: 6 } },
  { host: 'sam', fields: { title: 'Hang some shelves', details: 'I have the shelves, the brackets, and the anchors. I do not have a level.',
      tags: ['fixing', 'help'], location: '32.768300,-117.149800', location_name: 'Mission Valley', when_text: at(-4, 11), max_attendees: 1 } },
];

// What a demo host says after saying yes, by post title. Anything else gets DEFAULT_REPLY.
const HOST_REPLIES = {
  'Get some ramen at Chef Jun': [
    ['them', 'Glad you can come! I will grab a table by the window.'],
    ['me', 'Great. Do they take reservations?'],
    ['them', 'Nope, so I will get there a few minutes early.'],
  ],
};
const DEFAULT_REPLY = [['them', "Yay, you're in! See you there."]];
const SEED_JOINS = ['Get some ramen at Chef Jun'];

const ids = {};        // handle → users.id
const people = {};     // handle → identity (public/envelope.js), with the private keys
const byInbox = new Map(); // main inbox ID → handle
// pid → { host: handle, post, to?: { chat, inbox } (whom a private post was shared with), past?, at }
const posts = new Map();

const randomId = () => env.b64u.enc(globalThis.crypto.getRandomValues(new Uint8Array(16)));
const drop = (inbox, body) => q('INSERT INTO mail (inbox, body) VALUES (?, ?)').run(inbox, body);
const fullFields = (f) => ({ cost_amount: 0, cost_currency: 'USD', online: 0, max_attendees: null, ...f });

async function newIdentity(guid) {
  const chat = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const sign = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const inboxToken = env.newInboxToken();
  return {
    guid, inboxToken, inbox: await env.inboxIdOf(inboxToken), chatKey: chat.privateKey, signKey: sign.privateKey,
    chat: env.publicJwk(await subtle.exportKey('jwk', chat.publicKey)), sign: env.publicJwk(await subtle.exportKey('jwk', sign.publicKey)),
  };
}

// Create the demo accounts with fresh keys, and publish their posts (the shared examples in public/examples.js, also
// the sample deck on the introduction page) as signed public posts.
export async function seedDemo() {
  for (const [i, handle] of Object.keys(DEMO_USERS).entries()) {
    if (DEMO_USERS[handle] === null) continue;
    const p = people[handle] = await newIdentity(GUID_PREFIX + String(i + 1).padStart(12, '0'));
    byInbox.set(p.inbox, handle);
    ids[handle] = Number(q('INSERT INTO users (guid, chat_pubkey, sign_pubkey, inbox_id) VALUES (?, ?, ?, ?)')
      .run(p.guid, JSON.stringify(p.chat), JSON.stringify(p.sign), p.inbox).lastInsertRowid);
  }
  for (const [i, e] of EXAMPLES.entries()) {
    const host = people[e.host];
    const post = { ...fullFields({ title: e.title, details: e.details, tags: e.tags, location: e.location, location_name: e.place || '',
      when_text: exampleWhen(e.when), max_attendees: e.max ?? null, cost_amount: e.cost || 0, cost_currency: e.currency || 'USD' }),
      pid: randomId(), v: 1, kind: 'public', status: 'open', reply: { chat: host.chat, inbox: host.inbox } };
    const record = await env.signRecord(host, 'post', post);
    q('INSERT INTO public_posts (pid, host_id, v, body, seq) VALUES (?, ?, ?, ?, ?)').run(post.pid, ids[e.host], 1, JSON.stringify(record), i + 1);
    posts.set(post.pid, { host: e.host, post, at: Infinity, autoAccept: i % 2 === 0 || SEED_JOINS.includes(e.title) });
  }
  return { users: Object.keys(people).length, posts: EXAMPLES.length };
}

// The nicknames a new visitor starts with for the demo people they'll meet: { guid: name }.
export const demoNames = () => Object.fromEntries(['maya', 'dev', 'sam'].map(h => [people[h].guid, DEMO_USERS[h]]));

// Step 1 above, for a visitor whose browser has set up its keys: share the past posts with them, and say what their
// browser should do next. → { posts: [{ fields, share: [guid] }], join: [pid] }
export async function demoSeed(visitor) {
  const to = { chat: JSON.parse(visitor.chat_pubkey), inbox: visitor.inbox_id };
  const join = [...posts.values()].filter(x => x.post.kind === 'public' && SEED_JOINS.includes(x.post.title)).map(x => x.post.pid);
  for (const { host, fields } of pastPosts()) {
    const h = people[host];
    const post = { ...fullFields(fields), pid: randomId(), v: 1, kind: 'private', status: 'open', reply: { chat: h.chat, inbox: h.inbox } };
    posts.set(post.pid, { host, post, to, past: true, at: Date.now() });
    await share(host, post, to);
    join.push(post.pid);
  }
  return { posts: visitorPosts().map(p => ({ fields: fullFields(p.fields), share: p.share.map(h => people[h].guid) })), join };
}

async function share(host, post, to) {
  const record = await env.signRecord(people[host], 'post', post);
  drop(to.inbox, (await env.sealTo(to.chat, to.inbox, { type: 'share', record }, people[host])).body);
}

// Write messages on a channel: `list` is the channel so far (to number them), `steps` are [role, fields].
async function write(channel, list, steps) {
  const x = await env.channelOf(channel);
  for (const [role, fields] of steps) {
    const m = nextMessage(list, role, fields);
    list.push(m);
    drop(await env.inboxIdOf(role === 'attendee' ? x.recipientInbox : x.openerInbox), await env.sealChannel(channel, m));
  }
}
const hello = async (who, channel) => ({ type: 'hello', guid: people[who].guid, sig: await env.sign(people[who].signKey, 'hello', await env.helloText(channel, people[who].guid)) });
const chatSteps = (lines, them) => lines.map(([from, text]) => [from === 'them' ? them : them === 'host' ? 'attendee' : 'host', { type: 'chat', text }]);

// Mail that just arrived (POST /api/mail), for whichever of it went to a demo person's main inbox.
export async function demoBot(items) {
  for (const { inbox, body } of items) {
    const handle = byInbox.get(inbox);
    if (!handle) continue;
    const opened = await env.openSealed(body, inbox, people[handle]);
    if (!opened) continue;
    const { msg, sender, channel } = opened;
    if (msg.type === 'join') await answerJoin(handle, msg, channel); // anonymous, or from a contact who says who they are
    else if (msg.type === 'share' && sender) await joinShared(handle, msg, sender);
  }
}

// Someone asked to join a demo person's post: say yes, say hello, and chat (or, for a past post, mark it as having
// happened and share its final version).
async function answerJoin(handle, join, channel) {
  const p = posts.get(join.pid);
  if (!p || p.host !== handle) return;
  if (!p.past && !p.autoAccept) return; // left waiting (see the top of this file)
  const list = [join];
  await write(channel, list, [['host', { type: 'answer', status: 'accepted' }], ['host', await hello(handle, channel)]]);
  if (p.past) {
    await write(channel, list, [['host', { type: 'happened' }]]);
    p.post = { ...p.post, v: p.post.v + 1, status: 'past' };
    await share(handle, p.post, p.to);
  } else {
    await write(channel, list, chatSteps(HOST_REPLIES[p.post.title] || DEFAULT_REPLY, 'host'));
  }
}

// A visitor shared one of their posts with a demo person: ask to join it, if the script says to.
async function joinShared(handle, msg, sender) {
  const post = await env.openRecord('post', msg.record, sender.sign);
  const script = post?.kind === 'private' && post.v === 1 && visitorPosts().find(p => p.fields.title === post.title)?.joins[handle];
  if (!script || !post.reply?.chat || !post.reply?.inbox) return;
  const join = nextMessage([], 'attendee', { type: 'join', pid: post.pid, note: script.note });
  // The visitor is a contact (they shared the post), so the request says who it's from, as the app's would.
  const { body, channel } = await env.sealTo(post.reply.chat, post.reply.inbox, join, people[handle]);
  drop(post.reply.inbox, body);
  if (!script.accepted) return;
  const list = [join];
  await write(channel, list, [['host', { type: 'answer', status: 'accepted' }], ['attendee', await hello(handle, channel)]]);
  await write(channel, list, chatSteps(script.lines || [], 'attendee'));
}

// Demo visitors' accounts, and their mail and shared posts, last a day.
export function pruneVisitors() {
  q(`DELETE FROM users WHERE guid NOT LIKE '${GUID_PREFIX}%' AND created_at < datetime('now', '-1 day')`).run();
  q(`DELETE FROM mail WHERE created_at < datetime('now', '-1 day')`).run();
  const old = Date.now() - 86400_000;
  for (const [pid, p] of posts) if (p.at < old) posts.delete(pid);
}
