// Feedback over the API, against the demo server: posting and its limits, deleting your own, and (in the demo) each
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
const raw = await fetch(BASE + `/api/feedback/${f1.id}`, { method: 'DELETE' });
assert.equal(raw.status, 401, 'deleting needs an account too');

// 5 posts a day per account, deleted ones included.
for (let i = 2; i <= 5; i++) await a.api('/api/feedback', { method: 'POST', body: { body: `Idea ${i}` } });
await assert.rejects(a.api('/api/feedback', { method: 'POST', body: { body: 'Idea 6' } }), { status: 429 });
await a.api(`/api/feedback/${f1.id}`, { method: 'DELETE' });
assert.equal((await a.api('/api/feedback')).items.length, 4);
await assert.rejects(a.api('/api/feedback', { method: 'POST', body: { body: 'Idea 6' } }), { status: 429 }, 'deleting one does not make room');

// A client without the account's cookie is turned away.
await assert.rejects(client()('/api/feedback'), { status: 401 });
console.log('feedback: ok');
