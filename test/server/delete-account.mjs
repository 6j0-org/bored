// Deleting an account over the API, against the demo server: the confirmation, and that everything tied to the
// account is erased (its main inbox, the channel inboxes it names, its public posts and the reports it filed,
// invitations, feedback, keys, and sessions) while other people's mail and reports stay.
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { BASE, person } from '../lib.mjs';

const a = await person('del-a'), b = await person('del-b');
const token = () => randomBytes(32).toString('base64url');
const idOf = (t) => createHash('sha256').update(t).digest('base64url');
const read = async (t) => (await (await fetch(BASE + '/api/mail/read', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inboxes: [{ token: t, after: 0 }] }),
})).json()).mail[0];

const aMain = a.sec.vault.data.inbox, aSide = token(), bSide = token();
await b.api('/api/mail', { method: 'POST', body: { batch: [
  { inbox: idOf(aMain), body: 'aaaa.bbbb' }, { inbox: idOf(aSide), body: 'cccc.dddd' }, { inbox: idOf(bSide), body: 'eeee.ffff' },
] } });
assert.deepEqual([(await read(aMain)).length, (await read(aSide)).length, (await read(bSide)).length], [1, 1, 1]);
await a.api('/api/invites', { method: 'POST' });
// a reports one of b's public posts, and b reports one of a's.
const fields = { title: 'Account deletion test', details: 'Reported in test/server/delete-account.mjs', tags: ['help'], cost_amount: 0, cost_currency: 'USD',
  location: '32.7157,-117.1611', location_name: 'My street', online: 0, when_text: '2030-03-01T09:00', max_attendees: null };
const bPid = (await b.mail.savePost({ kind: 'public', fields })).post.pid, aPid = (await a.mail.savePost({ kind: 'public', fields })).post.pid;
const counts = async (pids) => (await (await fetch(BASE + '/api/public/reports', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pids }) })).json()).reports;
const third = await person('del-c');
await a.api('/api/public/report', { method: 'POST', body: { pid: bPid, reasons: ['spam'] } });
await third.api('/api/public/report', { method: 'POST', body: { pid: bPid, reasons: ['spam'] } });
await b.api('/api/public/report', { method: 'POST', body: { pid: aPid, reasons: ['spam'] } });
assert.deepEqual(await counts([bPid, aPid]), { [bPid]: { spam: 2 }, [aPid]: { spam: 1 } });
await a.api('/api/feedback', { method: 'POST', body: { body: 'Delete me with my account' } });

await assert.rejects(a.api('/api/account/delete', { method: 'POST', body: { confirm: 'zzzz', inboxes: [aSide] } }), { status: 400 },
  'the wrong confirmation is turned away');
if (a.guid.slice(-4) !== b.guid.slice(-4))
  await assert.rejects(b.api('/api/account/delete', { method: 'POST', body: { confirm: a.guid.slice(-4) } }), { status: 400 }, "another account's ending doesn't work");
assert.ok((await a.api('/api/me')).guid, 'nothing happened yet');

await a.api('/api/account/delete', { method: 'POST', body: { confirm: a.guid.slice(-4).toUpperCase(), inboxes: [aMain, aSide] } });
await assert.rejects(a.api('/api/me'), { status: 401 }, 'signed out: the session is gone');
assert.deepEqual([(await read(aMain)).length, (await read(aSide)).length], [0, 0], "the account's inboxes are empty");
assert.equal((await read(bSide)).length, 1, "other people's mail stays");
assert.deepEqual(await b.api('/api/keys', { method: 'POST', body: { guids: [a.guid] } }), {}, 'its keys are gone');
assert.ok((await b.api('/api/me')).guid, 'the other account is fine');
assert.deepEqual(await counts([bPid, aPid]), { [bPid]: { spam: 1 } }, "its reports and its public post are gone; others' reports stay");
await assert.rejects(a.api('/api/account/delete', { method: 'POST', body: { confirm: a.guid.slice(-4) } }), { status: 401 });
console.log('delete account: ok');
