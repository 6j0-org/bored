// Feedback over the API, against the demo server: posting and its limits, deleting your own, threads (replying;
// only developers close them), authors as icon hashes, badges in /api/me, and (in the demo) each
// visitor seeing only their own posts. feedback.js itself is tested in test/unit/feedback.mjs.
import assert from 'node:assert/strict';
import { BASE, client, person } from '../lib.mjs';

assert.equal((await fetch(BASE + '/api/feedback')).status, 401, 'feedback needs an account');
const a = await person('fb-a'), b = await person('fb-b');

const f1 = await a.api('/api/feedback', { method: 'POST', body: { body: 'Could Discover remember my last filter?' } });
assert.equal(f1.mine, true);
assert.equal(f1.user, undefined, "the author's GUID isn't returned");
const list = await a.api('/api/feedback');
assert.deepEqual([list.items.map(i => i.body), list.maxLength, list.isAdmin, list.demo], [['Could Discover remember my last filter?'], 2048, false, true]);
assert.ok(!JSON.stringify(list).includes(a.guid), 'no GUIDs anywhere in the list');

assert.deepEqual((await b.api('/api/feedback')).items, [], 'another demo visitor sees none of it');
await assert.rejects(b.api(`/api/feedback/${f1.id}`, { method: 'DELETE' }), { status: 404 }, 'and cannot delete it');
await assert.rejects(a.api('/api/feedback', { method: 'POST', body: { body: 'x'.repeat(2049) } }), { status: 400 });
await assert.rejects(a.api('/api/feedback', { method: 'POST', body: { body: '  ' } }), { status: 400 });
// Each post is a thread: its author can reply; only developers (none in the demo) can close it.
let th = await a.api(`/api/feedback/${f1.id}/replies`, { method: 'POST', body: { body: 'Also the date filter.' } });
assert.deepEqual([th.messages.map(m => [m.body, m.mine, m.admin]), th.canReply, th.canClose, th.status], [[['Also the date filter.', true, false]], true, false, 'open']);
assert.deepEqual((await a.api(`/api/feedback/${f1.id}`)).messages.length, 1);
assert.ok(!JSON.stringify(th).includes(a.guid), 'no GUIDs in a thread');
const { createHash } = await import('node:crypto');
const aIcon = createHash('sha1').update(a.guid).digest('hex');
assert.deepEqual([th.author, th.messages[0].author, th.messages[0].op], [aIcon, aIcon, true], "authors are their icon hash");
await assert.rejects(a.api(`/api/feedback/${f1.id}/status`, { method: 'POST', body: { status: 'done' } }), { status: 403 });
await assert.rejects(b.api(`/api/feedback/${f1.id}`), { status: 404 }, "another demo visitor can't open it");
await assert.rejects(b.api(`/api/feedback/${f1.id}/replies`, { method: 'POST', body: { body: 'hi' } }), { status: 404 });
// Editing your own post and replies.
th = await a.api(`/api/feedback/${f1.id}`, { method: 'PUT', body: { body: 'Could Discover remember my filters?' } });
assert.equal(th.body, 'Could Discover remember my filters?');
th = await a.api(`/api/feedback/${f1.id}/replies/${th.messages[0].id}`, { method: 'PUT', body: { body: 'Also the date one.' } });
assert.deepEqual([th.messages[0].body, th.messages[0].edited > 0], ['Also the date one.', true]);
await assert.rejects(b.api(`/api/feedback/${f1.id}`, { method: 'PUT', body: { body: 'x' } }), { status: 404 });
assert.deepEqual((await a.api('/api/me')).badges, { developer: false, tester: 0 });
const raw = await fetch(BASE + `/api/feedback/${f1.id}`, { method: 'DELETE' });
assert.equal(raw.status, 401, 'deleting needs an account too');

// 100 posts, replies, and edits a day per account, deleted ones included (there are 4 above).
for (let i = 5; i <= 100; i++) await a.api('/api/feedback', { method: 'POST', body: { body: `Idea ${i}` } });
await assert.rejects(a.api('/api/feedback', { method: 'POST', body: { body: 'Idea 101' } }), { status: 429 });
await a.api(`/api/feedback/${f1.id}`, { method: 'DELETE' });
assert.equal((await a.api('/api/feedback')).items.length, 96);
await assert.rejects(a.api('/api/feedback', { method: 'POST', body: { body: 'Idea 101' } }), { status: 429 }, 'deleting one does not make room');

// A client without the account's cookie is turned away.
await assert.rejects(client()('/api/feedback'), { status: 401 });
console.log('feedback: ok');
