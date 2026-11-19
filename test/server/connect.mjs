// Invitations to connect: ask, decline, the declined list (Confirm's discard pile), and changing the answer to yes.
import assert from 'node:assert/strict';
import { person } from '../lib.mjs';
const dave = await person('dave-c'), erin = await person('erin-c');
const reqs = (answered = false) => dave.api(`/api/connection-requests${answered ? '?answered=1' : ''}`);

// Erin uses Dave's invitation; Dave says no.
const inv = await dave.api('/api/invites', { method: 'POST' });
const note = await erin.sec.sealForInvite(erin.sec.newInviteKey(), 'Erin');
assert.equal((await erin.api('/api/invites/accept', { method: 'POST', body: { token: inv.token, note } })).status, 'requested');
const [r] = await reqs();
assert.ok(r, 'pending for Dave');
await dave.api(`/api/connection-requests/${r.id}/respond`, { method: 'POST', body: { yes: false } });
assert.equal((await reqs()).length, 0, 'not pending any more');
const declined = await reqs(true);
assert.deepEqual(declined.map(x => x.id), [r.id], 'in the declined list');
assert.ok(declined[0].requester.icon && !declined[0].guid, 'icon only, no GUID');

// Dave changes his mind: back to pending, then yes.
await dave.api(`/api/connection-requests/${r.id}/undo`, { method: 'POST' });
const yes = await dave.api(`/api/connection-requests/${r.id}/respond`, { method: 'POST', body: { yes: true } });
assert.equal(yes.connected, true); assert.equal(yes.guid, erin.guid);
assert.equal((await reqs(true)).length, 0, 'not declined any more');
assert.deepEqual((await erin.api('/api/connections')).map(c => c.guid), [dave.guid]);
console.log('connect: ok');
