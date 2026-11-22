// Demo seeding: a visitor's browser does what app.js seedDemo() does, and the demo bot fills in the rest.
import assert from 'node:assert/strict';
import { person } from '../lib.mjs';

const v = await person('visitor');
// What startDemo does: nicknames from register are saved first (createDemoAccount returned them; ask again).
const plan = await v.api('/api/demo/seed', { method: 'POST' });
assert.equal(plan.posts.length, 2); assert.equal(plan.join.length, 3);
const guids = [...new Set(plan.posts.flatMap(p => p.share))];
await v.sec.vault.update(v.api, d => { for (const g of guids) d.contacts[g] = { nickname: g.slice(-2), tags: [], added: '' }; });
for (const p of plan.posts) await v.mail.savePost({ kind: 'private', fields: p.fields, audience: { groups: [], contacts: p.share }, guids: p.share });
let view = await v.mail.loadMail({ act: false });
for (const pid of plan.join) { const post = view.posts.get(pid); assert.ok(post, 'post to join is visible'); await v.mail.requestJoin(post); }
await v.mail.loadMail(); view = await v.mail.loadMail();

const hosted = (title) => view.hosting.find(h => h.post.title === title);
const asked = (title) => view.requests.find(r => r.post?.title === title);
const chat = (st) => st.timeline.filter(t => t.event === 'chat').map(t => `${t.role}: ${t.text}`);
const hike = hosted('Sunrise hike up Cowles Mountain');
assert.deepEqual(hike.requests.map(r => [r.status, r.note]), [['pending', 'I have a spare headlamp if anyone needs one.'], ['pending', '']]);
const hoops = hosted('Pickup basketball');
assert.equal(hoops.requests.length, 1); assert.equal(hoops.requests[0].status, 'accepted');
assert.equal(hoops.requests[0].hello.attendee?.guid.endsWith('000000000004'), true, 'Sam said hello');
assert.ok(hoops.requests[0].hello.host, 'visitor said hello');
assert.deepEqual(chat(hoops.requests[0]), ['attendee: Hey! Is the court by the rec center or the one by the school?', 'host: Rec center. The school one has no nets right now.', 'attendee: Perfect. I will bring a ball and a pump.']);
const ramen = asked('Get some ramen at Chef Jun');
assert.equal(ramen.status, 'accepted'); assert.ok(ramen.hello.host?.guid.endsWith('000000000002'));
assert.equal(chat(ramen).length, 3);
for (const t of ['Beach cleanup at Ocean Beach', 'Hang some shelves']) {
  const r = asked(t); assert.equal(r.status, 'attended', t); assert.equal(r.post.status, 'past', t);
}
assert.equal(view.badges.confirm, 2); assert.equal(view.badges.plans, 2);
assert.deepEqual(view.stats, { hosted: 0, attended: 2, helped: 1 });
assert.equal(Object.keys(view.together).length, 2);
assert.ok(!view.deck.some(p => p.title === 'Beach cleanup at Ocean Beach'), 'past posts left the deck');
assert.ok(view.deck.length >= 30, 'demo public posts are in the deck');

// Saying yes to any other demo post: every other one is accepted, with a hello and a reply; the rest wait.
const trivia = view.deck.find(p => p.title === 'Trivia night at the Brass Tap');
await v.mail.requestJoin(trivia);
view = await v.mail.loadMail();
const tr = asked('Trivia night at the Brass Tap');
assert.equal(tr.status, 'accepted'); assert.deepEqual(chat(tr), ["host: Yay, you're in! See you there."]);
const couch = view.deck.find(p => p.title === 'Help me move a couch up two flights');
await v.mail.requestJoin(couch);
view = await v.mail.loadMail();
assert.equal(asked('Help me move a couch up two flights').status, 'pending', 'the next post leaves the request waiting');
console.log('demo seed: ok');
