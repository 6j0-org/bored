// Two "browsers" (separate secure.js module instances) against a real server in demo mode.
import assert from 'node:assert/strict';
import { PUBLIC, client } from '../lib.mjs';
const APP = `${PUBLIC}secure.js`;

async function person(tag) {
  const s = await import(`${APP}?${tag}`), api = client();
  await s.createDemoAccount(api);
  await s.vault.load(api);
  await s.ensureKeys(api);
  return { s, api, pub: s.myPublicKeys() };
}
const read = (api, tokens) => api('/api/mail/read', { method: 'POST', credentials: 'omit', body: { inboxes: tokens.map(token => ({ token, after: 0 })) } });

const host = await person('host'), guest = await person('guest');
assert.ok(host.pub.sign && host.pub.chat && host.pub.inbox, 'host has keys and inbox');
assert.notEqual(host.pub.inbox, guest.pub.inbox);

// ensureKeys again is a no-op; the server keeps the first key (PUT again → 409).
await host.s.ensureKeys(host.api);
await assert.rejects(host.api('/api/me/keys', { method: 'PUT', body: { inboxId: guest.pub.inbox } }), e => e.status === 409);
// Key lookup by GUID.
const looked = await guest.api('/api/keys', { method: 'POST', body: { guids: [host.pub.guid] } });
assert.deepEqual(looked[host.pub.guid], { chat: host.pub.chat, sign: host.pub.sign, inbox: host.pub.inbox });

// Signed public record: good, tampered, and wrong signer.
const rec = await host.s.signRecord('post', { pid: 'p1', title: 'Hike' });
assert.deepEqual(await guest.s.openRecord('post', rec, host.pub.sign), { pid: 'p1', title: 'Hike' });
assert.equal(await guest.s.openRecord('post', { ...rec, body: rec.body.replace('Hike', 'Heist') }), null, 'tampered');
assert.equal(await guest.s.openRecord('post', rec, guest.pub.sign), null, 'wrong signer');
assert.equal(await guest.s.openRecord('share', rec), null, 'wrong kind');

// Anonymous join: guest → host's main inbox. The server stores no sender.
const join = await guest.s.sealTo(host.pub.chat, host.pub.inbox, { type: 'join', pid: 'p1', note: 'hi' });
await guest.api('/api/mail', { method: 'POST', body: { inbox: host.pub.inbox, body: join.body } });
const hostToken = host.s.vault.data.inbox;
const got = (await read(host.api, [hostToken])).mail[0];
assert.equal(got.length, 1);
assert.deepEqual(Object.keys(got[0]).sort(), ['at', 'body', 'id']);
const opened = await host.s.openSealed(got[0].body, host.pub.inbox);
assert.deepEqual(opened.msg, { type: 'join', pid: 'p1', note: 'hi' });
assert.equal(opened.sender, null, 'anonymous');
assert.equal(opened.channel, join.channel, 'both sides get the same channel secret');
assert.equal(await guest.s.openSealed(got[0].body, guest.pub.inbox), null, 'not for the guest');
assert.equal(await host.s.openSealed(got[0].body, guest.pub.inbox), null, 'filed under another inbox');

// Channel: host answers to the opener's inbox; guest reads it without cookies.
const ch = await host.s.channelOf(opened.channel), chG = await guest.s.channelOf(join.channel);
assert.deepEqual([ch.openerInbox, ch.recipientInbox], [chG.openerInbox, chG.recipientInbox]);
const answer = await host.s.sealChannel(opened.channel, { type: 'answer', status: 'accepted', role: 'host', n: 1 });
await host.api('/api/mail', { method: 'POST', body: { inbox: await host.s.inboxIdOf(ch.openerInbox), body: answer } });
const back = (await read(guest.api, [chG.openerInbox])).mail[0];
assert.deepEqual(await guest.s.openChannel(join.channel, back[0].body), { type: 'answer', status: 'accepted', role: 'host', n: 1 });
assert.equal(await guest.s.openChannel(guest.pub.inbox.replace(/./, 'A'), back[0].body), null, 'wrong channel');

// Identified envelope: the sender is checked, and can't be forwarded to someone else.
const hello = await guest.s.sealTo(host.pub.chat, host.pub.inbox, { type: 'hello' }, { identify: true });
const h = await host.s.openSealed(hello.body, host.pub.inbox);
assert.equal(h.sender.guid, guest.pub.guid);
assert.deepEqual(h.sender.sign, guest.pub.sign);

// Server checks: bad bodies, bad inbox IDs, no sign-in for sending, and the rate limit.
await assert.rejects(guest.api('/api/mail', { method: 'POST', body: { inbox: host.pub.inbox, body: '<script>' } }), e => e.status === 400);
await assert.rejects(guest.api('/api/mail', { method: 'POST', body: { inbox: 'nope', body: 'a.b' } }), e => e.status === 400);
await assert.rejects(client()('/api/mail', { method: 'POST', body: { inbox: host.pub.inbox, body: 'a.b' } }), e => e.status === 401);
const batch = Array.from({ length: 60 }, () => ({ inbox: host.pub.inbox, body: 'a.b' }));
await assert.rejects(guest.api('/api/mail', { method: 'POST', body: { batch } }), e => e.status === 429, 'per-inbox limit');
console.log('mail round trip: ok');
