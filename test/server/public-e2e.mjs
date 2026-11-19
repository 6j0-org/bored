// Public posts: publish, guests and strangers read them, a stranger joins anonymously, the server's checks, and
// ended posts.
import assert from 'node:assert/strict';
import { realFetch, BASE, person, copyApp } from '../lib.mjs';
const rejects = async (fn, status, re) => {
  try { await fn(); } catch (e) { assert.equal(e.status, status, e.message); if (re) assert.match(e.message, re); return; }
  assert.fail('expected an error');
};

// Only Dave's posts: other tests may have left public posts on the same server.
const RUN = String(Date.now() % 100000), own = (v) => v.deck.filter(p => p.details === `Bring a game ${RUN}`);
const dave = await person('dave'), erin = await person('erin');
const guest = await copyApp('guest'); guest.mail.initMail(guest.api);
const fields = { title: 'Board games', details: `Bring a game ${RUN}`, tags: ['games'], cost_amount: 0, cost_currency: 'USD',
  location: '32.715700,-117.161100', location_name: 'Library', online: 0, when_text: '2030-02-01T18:00;FREQ=WEEKLY;BYDAY=FR', max_attendees: 4 };

// Dave publishes; a guest and a stranger both see it, with its signature checked.
const { post } = await dave.mail.savePost({ kind: 'public', fields });
assert.equal(post.kind, 'public'); assert.equal(post.v, 1);
let gv = await guest.mail.loadMail();
assert.equal(own(gv).length, 1); assert.equal(own(gv)[0].title, 'Board games'); assert.equal(own(gv)[0].host, null);
let ev = await erin.mail.loadMail();
assert.equal(own(ev).length, 1);
let dv = await dave.mail.loadMail();
assert.equal(own(dv).length, 0, 'not in my own deck'); assert.equal(dv.hosting.length, 1);

// The server's checks.
const me = dave.sec.myPublicKeys();
const signed = (o) => dave.sec.signRecord('post', { ...post, ...o });
const put = (who, record) => who.api('/api/public', { method: 'PUT', body: { record } });
await rejects(async () => put(dave, { ...(await signed({ v: 9 })), body: JSON.stringify({ ...post, v: 9, title: 'Changed' }) }), 400, /signed/);
await rejects(async () => put(dave, await signed({})), 409, /newer/);
await rejects(async () => put(dave, await signed({ v: 2, reply: { ...post.reply, inbox: 'A'.repeat(43) } })), 400, /own inbox/);
await rejects(async () => put(dave, await signed({ v: 2, title: 'Call 619-555-0123' })), 400);
await rejects(async () => put(dave, await signed({ v: 2, kind: 'private' })), 400);
await rejects(async () => put(erin, await signed({ v: 2 })), 400, /your key/);
const erinMe = erin.sec.myPublicKeys();
await rejects(async () => put(erin, await erin.sec.signRecord('post', { ...post, v: 5, reply: { chat: erinMe.chat, inbox: erinMe.inbox } })), 409, /taken/);
await rejects(async () => realFetch(BASE + '/api/public', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ record: await signed({ v: 2 }) }) })
  .then(r => { if (!r.ok) throw Object.assign(new Error('no'), { status: r.status }); }), 401);

// Erin asks to join, anonymously; Dave accepts; they say hello and Erin becomes Dave's contact.
const ch = await erin.mail.requestJoin(own(ev)[0], 'I bring Catan');
dv = await dave.mail.loadMail();
const req = dv.hosting[0].requests[0];
assert.equal(req.note, 'I bring Catan'); assert.equal(req.hello.attendee, null);
await dave.mail.sendOn(req.id, { type: 'answer', status: 'accepted' });
await dave.mail.loadMail();
ev = await erin.mail.loadMail();
assert.equal(ev.requests[0].status, 'accepted'); assert.equal(ev.requests[0].hello.host.guid, dave.guid);
dv = await dave.mail.loadMail();
assert.equal(dv.hosting[0].requests[0].hello.attendee.guid, erin.guid);
assert.ok(dave.sec.vault.data.contacts[erin.guid]?.keys, 'Erin is a contact, keys saved');
assert.ok(erin.sec.vault.data.contacts[dave.guid]?.keys, 'Dave is a contact, keys saved');

// An edit: a new version everyone sees, and Erin is asked to re-confirm.
const edit = await dave.mail.savePost({ pid: post.pid, fields: { ...fields, title: 'Board games night' } });
assert.equal(edit.post.v, 2); assert.equal(edit.post.kind, 'public', 'keeps its kind'); assert.equal(edit.notified, 1);
gv = await guest.mail.loadMail();
assert.equal(own(gv)[0].title, 'Board games night');
ev = await erin.mail.loadMail();
assert.equal(ev.requests[0].reconfirm, true); assert.equal(ev.requests[0].post.title, 'Board games night');

// Dave removes it: guests see it go (incremental read and a fresh one), and Erin's request still knows the post.
await dave.mail.setPostStatus(post.pid, 'cancelled');
gv = await guest.mail.loadMail();
assert.equal(own(gv).length, 0, 'gone on the next read');
guest.mail.resetMail();
gv = await guest.mail.loadMail();
assert.equal(own(gv).length, 0); assert.ok(!gv.posts.has(post.pid), 'a first read only gets live posts');
erin.mail.resetMail();
ev = await erin.mail.loadMail();
assert.equal(ev.requests[0].post?.status, 'cancelled', 'asked for by ID'); assert.equal(ev.requests[0].closed, true);
assert.ok(!own(ev).length);

// The server stores the signed record, nothing else about who's involved.
const raw = await (await realFetch(BASE + '/api/public/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ after: 0, pids: [post.pid] }) })).json();
assert.deepEqual(Object.keys(raw.posts[0]).sort(), ['body', 'sig', 'signer']);
console.log('public e2e: ok');
