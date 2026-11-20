// Moderation on the server: reporting public posts, the counts anyone can read, and deleting a contact
// (the invitation connection goes, and an old match doesn't add them back).
import assert from 'node:assert/strict';
import { realFetch, BASE, person } from '../lib.mjs';
const rejects = async (fn, status, re) => {
  try { await fn(); } catch (e) { assert.equal(e.status, status, e.message); if (re) assert.match(e.message, re); return; }
  assert.fail('expected an error');
};
const counts = async (pids) => (await (await realFetch(BASE + '/api/public/reports', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pids }) })).json()).reports;

const host = await person('mod-host'), a = await person('mod-a'), b = await person('mod-b'), c = await person('mod-c');
const fields = { title: 'Yard sale', details: 'Everything must go', tags: ['help'], cost_amount: 0, cost_currency: 'USD',
  location: '32.7157,-117.1611', location_name: 'My street', online: 0, when_text: '2030-03-01T09:00', max_attendees: null };
const { post } = await host.mail.savePost({ kind: 'public', fields });
const pid = post.pid;
const report = (who, reasons, p = pid) => who.api('/api/public/report', { method: 'POST', body: { pid: p, reasons } });

// Nothing reported yet: no counts.
assert.deepEqual(await counts([pid]), {});

// Checks: signed in, a real reason, a post that exists, and not your own.
await rejects(() => realFetch(BASE + '/api/public/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid, reasons: ['spam'] }) })
  .then(r => { if (!r.ok) throw Object.assign(new Error('no'), { status: r.status }); }), 401);
await rejects(() => report(a, ['nonsense']), 400);
await rejects(() => report(a, ['spam'], 'x'.repeat(22)), 404);
await rejects(() => report(host, ['spam']), 400, /your own/);

// Three people report it; one of them twice for the same reason, which still counts once.
await report(a, ['spam']);
await report(a, ['spam']);
await report(b, ['spam', 'scam']);
await report(c, ['offensive']);
assert.deepEqual((await counts([pid]))[pid], { spam: 2, scam: 1, offensive: 1 });

// Changing a report replaces it; [] takes it back.
await report(b, ['scam']);
await report(c, []);
assert.deepEqual((await counts([pid]))[pid], { spam: 1, scam: 1 });
await rejects(() => realFetch(BASE + '/api/public/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ pids: Array.from({ length: 501 }, (_, i) => `p${String(i).padStart(20, '0')}`) }) })
  .then(r => { if (!r.ok) throw Object.assign(new Error('no'), { status: r.status }); }), 400);

// ---------- deleting a contact ----------
// Two people connected by an invitation: deleting removes the connection for both, so neither browser adds the
// other back, and either can use an invitation again.
const inv = await host.api('/api/invites', { method: 'POST' });
const note = await a.sec.sealForInvite(a.sec.newInviteKey(), 'A');
await a.api('/api/invites/accept', { method: 'POST', body: { token: inv.token, note } });
const [r] = await host.api('/api/connection-requests');
await host.api(`/api/connection-requests/${r.id}/respond`, { method: 'POST', body: { yes: true } });
assert.deepEqual((await a.api('/api/connections')).map(x => x.guid), [host.guid]);
await a.api('/api/connections/remove', { method: 'POST', body: { guid: host.guid } });
assert.deepEqual(await a.api('/api/connections'), []);
assert.deepEqual(await host.api('/api/connections'), []);
assert.equal((await a.api('/api/invites/accept', { method: 'POST', body: { token: inv.token, note } })).status, 'requested', 'can ask again');
await a.api('/api/connections/remove', { method: 'POST', body: { guid: 'not-a-guid' } }); // nothing to remove: fine

// A contact from a match: after deleting them, reading the old match again doesn't add them back (mail.js act_).
const { post: picnic } = await host.mail.savePost({ kind: 'public', fields: { ...fields, title: 'Picnic', details: 'Bring a blanket' } });
let bv = await b.mail.loadMail();
await b.mail.requestJoin(bv.posts.get(picnic.pid));
let hv = await host.mail.loadMail();
const req = hv.hosting.find(h => h.post.pid === picnic.pid).requests[0];
await host.mail.sendOn(req.id, { type: 'answer', status: 'accepted' });
await host.mail.loadMail(); await b.mail.loadMail(); await host.mail.loadMail();
assert.ok(host.sec.vault.data.contacts[b.guid], 'matched: B is a contact');
await host.sec.vault.update(host.api, (v) => { delete v.contacts[b.guid]; v.removedContacts = { [b.guid]: Date.now() + 1 }; });
await host.mail.loadMail();
assert.equal(host.sec.vault.data.contacts[b.guid], undefined, 'not added back from the old match');

console.log('moderation: ok');
