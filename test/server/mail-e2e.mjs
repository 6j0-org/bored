// Three people (separate copies of public/, so separate module state) against a real demo-mode server.
import assert from 'node:assert/strict';
import { person } from '../lib.mjs';
const befriend = async (a, b) => {
  await a.sec.vault.update(a.api, d => { d.contacts[b.guid] = { nickname: b.name, tags: ['friends'], added: '' }; });
  await b.sec.vault.update(b.api, d => { d.contacts[a.guid] = { nickname: a.name, tags: [], added: '' }; });
};
// Only private posts: other tests may have left public posts on the same server.
const own = (v) => v.deck.filter(p => p.kind === 'private');
const alice = await person('alice'), bob = await person('bob'), carol = await person('carol');
await befriend(alice, bob); await befriend(alice, carol);
const fields = { title: 'Sunrise hike', details: 'Bring water', tags: ['hiking'], cost_amount: 0, cost_currency: 'USD',
  location: '32.812600,-117.031200', location_name: 'Trailhead', online: 0, when_text: '2030-01-05T06:00', max_attendees: 1 };

// Alice shares a private post with Bob and Carol.
const audience = { groups: [], contacts: [bob.guid, carol.guid] };
const saved = await alice.mail.savePost({ kind: 'private', fields, audience, guids: [bob.guid, carol.guid] });
assert.equal(saved.shared, 2); assert.equal(saved.missing, 0);
const pid = saved.post.pid;

let bv = await bob.mail.loadMail();
assert.equal(own(bv).length, 1); assert.equal(own(bv)[0].title, 'Sunrise hike'); assert.equal(own(bv)[0].host, alice.guid);

// Bob asks to join; Alice sees an anonymous request and says yes.
const bobCh = await bob.mail.requestJoin(own(bv)[0], 'I have a headlamp');
assert.equal(own(await bob.mail.loadMail()).length, 0, 'asked: gone from the deck');
let av = await alice.mail.loadMail();
assert.equal(av.badges.confirm, 1);
const req = av.hosting[0].requests[0];
assert.equal(req.note, 'I have a headlamp'); assert.equal(req.hello.attendee, null, 'anonymous');
await alice.mail.sendOn(req.id, { type: 'answer', status: 'accepted' });
av = await alice.mail.loadMail(); // sends Alice's hello, and the post's status (full)
assert.equal(av.hosting[0].status, 'full');

bv = await bob.mail.loadMail(); // Bob sees the match and the host's hello, and says hello back
assert.equal(bv.requests[0].status, 'accepted');
assert.equal(bv.requests[0].hello.host.guid, alice.guid);
assert.equal(bv.requests[0].post.status, 'full', 'the status change reached Bob');
av = await alice.mail.loadMail();
assert.equal(av.hosting[0].requests[0].hello.attendee.guid, bob.guid, 'Bob revealed after the match');

// Chat both ways.
await bob.mail.sendOn(bobCh, { type: 'chat', text: 'see you there' });
await alice.mail.sendOn(req.id, { type: 'chat', text: 'great' });
bv = await bob.mail.loadMail(); av = await alice.mail.loadMail();
// Alice hadn't read Bob's message when she wrote hers, so they crossed: host first, the same on both sides.
const chatOf = (st) => st.timeline.filter(t => t.event === 'chat').map(t => [t.text, t.role]);
assert.deepEqual(chatOf(av.hosting[0].requests[0]), [['great', 'host'], ['see you there', 'attendee']]);
assert.deepEqual(chatOf(bv.requests[0]), chatOf(av.hosting[0].requests[0]));
// A reply written after reading comes after.
await bob.mail.sendOn(bobCh, { type: 'chat', text: 'bringing snacks' });
av = await alice.mail.loadMail(); bv = await bob.mail.loadMail();
assert.deepEqual(chatOf(av.hosting[0].requests[0]).at(-1), ['bringing snacks', 'attendee']);
assert.deepEqual(chatOf(bv.requests[0]), chatOf(av.hosting[0].requests[0]));

// Carol asks while it's full: waitlist. Bob drops out: Carol gets the spot on Alice's next load.
let cv = await carol.mail.loadMail();
const carolCh = await carol.mail.requestJoin(own(cv)[0]);
av = await alice.mail.loadMail();
const carolReq = av.hosting[0].requests.find(r => r.status === 'pending');
await alice.mail.sendOn(carolReq.id, { type: 'answer', status: 'waitlisted' });
cv = await carol.mail.loadMail();
assert.equal(cv.requests[0].status, 'waitlisted'); assert.equal(cv.requests[0].hello.host, null, 'no hello on the waitlist');
await bob.mail.sendOn(bobCh, { type: 'leave' });
av = await alice.mail.loadMail();
assert.equal(av.hosting[0].requests.find(r => r.id === carolReq.id).status, 'accepted', 'promoted off the waitlist');
cv = await carol.mail.loadMail();
assert.equal(cv.requests[0].status, 'accepted');
assert.equal(cv.requests[0].timeline[0].event, 'promoted');

// Alice changes the time: Carol is asked to re-confirm, and says yes. Bob (withdrawn) isn't asked.
const edit = await alice.mail.savePost({ kind: 'private', pid, fields: { ...fields, when_text: '2030-01-06T06:00' }, audience, guids: [bob.guid, carol.guid] });
assert.equal(edit.notified, 1);
cv = await carol.mail.loadMail();
assert.equal(cv.requests[0].reconfirm, true);
assert.equal(cv.requests[0].post.when_text, '2030-01-06T06:00');
await carol.mail.sendOn(carolCh, { type: 'reconfirm', yes: true });
av = await alice.mail.loadMail();
assert.equal(av.hosting[0].counts.reconfirm, 0);

// It happened: past, and "done together".
await alice.mail.sendOn(carolReq.id, { type: 'happened' });
av = await alice.mail.loadMail();
assert.equal(av.hosting[0].status, 'past');
assert.deepEqual(av.together, { [carol.guid]: 1 });

// Alice takes Carol out of the audience of a new post: Carol never sees it; then unshare hides one she had.
const p2 = await alice.mail.savePost({ kind: 'private', fields: { ...fields, title: 'Second' }, audience, guids: [bob.guid, carol.guid] });
cv = await carol.mail.loadMail();
assert.ok(cv.deck.some(p => p.title === 'Second'));
await alice.mail.savePost({ kind: 'private', pid: p2.post.pid, fields: {}, audience: { groups: [], contacts: [bob.guid] }, guids: [bob.guid] });
cv = await carol.mail.loadMail();
assert.ok(!cv.deck.some(p => p.title === 'Second'), 'unshared');
assert.ok((await bob.mail.loadMail()).deck.some(p => p.title === 'Second'));

// Alice's other device (a fresh module copy, same account) sees the same state from the vault and mail alone.
// Simulate it by resetting Alice's in-memory mail and reloading.
alice.mail.resetMail();
av = await alice.mail.loadMail();
assert.equal(av.hosting.find(h => h.post.pid === pid).status, 'past');
assert.equal(av.hosting.find(h => h.post.pid === pid).requests.length, 2);
console.log('mail e2e: ok');
