// The mail loop: read my inboxes, open and check what's there, and replay it with derive() (public/posts.js) into
// what the app shows. Also everything the app sends: private posts, requests to join, and messages on a request.
//
// Where things are (see "mail" in public/secure.js):
// - My main inbox: private posts shared with me (`share`, `unshare`, signed by the host), requests to join my posts
//   (`join`, anonymous), and `poke`s, which only wake up my devices (the server pushes "New activity" for main inbox
//   mail).
// - Channels: one per request to join. Both sides read both of a channel's inboxes, so either side's devices see
//   the whole conversation. The person who asked keeps the channel secret in their vault (requests); the host gets
//   it again from the join in their main inbox.
// - My own posts are in my vault (posts), with who each is shared with.
// - Public posts are signed records the server keeps (/api/public). Everyone reads them, guests too, and checks
//   each signature here. Requests to join them go to the host's main inbox like any other.
//
// Vault entries (public/secure.js has the rest):
//   posts:    { [pid]: { record, audience: { groups, contacts }, sharedWith: [guid] } }  posts I host
//   requests: { [channel secret]: { pid, join, reply: { chat, inbox }, at } }            my requests to join
//   passed:   [pid]                                                                     posts I swiped no on
//   passedAt: { [pid]: ms }                                    when, for the discard pile's order (older ones lack it)
//   deleted:  [pid]                                   passes I deleted from the discard pile (a subset of passed)
//   invitesSeen: [token]                         invitations to connect sent to me that I've answered (newest last)
//   invitesDeclined: { [token]: { token, key, name, at } }       the ones I said no to, for Confirm's discard pile
//   removedContacts: { [guid]: ms }             contacts I deleted, and when, so an old match doesn't add them back
//   contacts[guid].keys: { chat, sign, inbox }  a contact's keys, saved the first time they're used (so the server
//                                               can't swap them later)
import {
  vault, hasKeys, myPublicKeys, signRecord, openRecord, sealTo, openSealed, channelOf, sealChannel, openChannel, inboxIdOf,
  sign, verify, b64u, helloText,
} from './secure.js';
import { derive, nextMessage, LIVE } from './posts.js';
import { changedFields } from './postfields.js';

let api = null;
export const initMail = (apiFn) => { api = apiFn; };

const randomId = () => b64u.enc(crypto.getRandomValues(new Uint8Array(16)));
const MAIL_BATCH = 100, MAX_PASSED = 1000;

// What's been read so far, in memory. Cleared on sign-out (resetMail).
let box;
export function resetMail() {
  box = {
    cursors: new Map(),      // inbox token → last mail ID read
    posts: [],               // derive() posts entries from my main inbox
    channels: new Map(),     // channel secret → { id, role, opened, messages: Map(id → message) }
    helloChecked: new Map(), // message id → verified hello fields, or null if it didn't check out
    publicSeq: 0,            // where the last public post read stopped
    publicPosts: [],         // derive() posts entries for public posts
    publicAsked: new Set(),  // pids of public posts asked for by ID (ones I've asked to join)
    publicChecked: new Map(),// record signature → the post, or null if it didn't check out
    invites: new Map(),      // invitations to connect mailed to me: token → { token, key, name }
  };
  view = null;
}
let view = null;
resetMail();
export const mailView = () => view;

// ---------- reading ----------

// POST /api/mail/read without cookies, so reads can't be tied to my session.
async function readInboxes(tokens) {
  const res = await fetch('/api/mail/read', {
    method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inboxes: tokens.map(token => ({ token, after: box.cursors.get(token) || 0 })) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Couldn't check for new messages");
  tokens.forEach((t, i) => { const rows = data.mail[i]; if (rows.length) box.cursors.set(t, rows[rows.length - 1].id); });
  return { mail: data.mail, more: data.more };
}

function addChannel(id, role, opened, first) {
  if (!box.channels.has(id)) box.channels.set(id, { id, role, opened, messages: new Map() });
  const c = box.channels.get(id);
  if (first) c.messages.set(first.id, first);
  return c;
}

// A contact's keys: saved ones first, otherwise asked from the server and saved (first use wins).
async function keysFor(guids) {
  const out = {}, missing = [];
  for (const g of new Set(guids)) { const k = vault.data.contacts[g]?.keys; if (k) out[g] = k; else missing.push(g); }
  for (let i = 0; i < missing.length; i += 200) {
    const got = await api('/api/keys', { method: 'POST', body: { guids: missing.slice(i, i + 200) } });
    Object.assign(out, got);
  }
  const save = Object.keys(out).filter(g => vault.data.contacts[g] && !vault.data.contacts[g].keys);
  if (save.length) await vault.update(api, (d) => { for (const g of save) if (d.contacts[g] && !d.contacts[g].keys) d.contacts[g].keys = out[g]; });
  return out;
}
// A sender is who they say if their keys match the ones saved for them (or there are none saved yet).
const knownKeysMatch = (guid, sender) => {
  const k = vault.data.contacts[guid]?.keys;
  return !k || (k.sign.x === sender.sign.x && k.sign.y === sender.sign.y && k.chat.x === sender.chat.x && k.chat.y === sender.chat.y);
};

async function readMainInbox(rows) {
  const me = myPublicKeys();
  for (const row of rows) {
    const opened = await openSealed(row.body, me.inbox);
    if (!opened) continue;
    const { msg, sender, channel } = opened;
    if ((msg.type === 'share' || msg.type === 'unshare') && sender && knownKeysMatch(sender.guid, sender)) {
      if (msg.type === 'unshare') { box.posts.push({ unshare: { pid: String(msg.pid), v: Number(msg.v) }, signer: sender.sign }); continue; }
      const post = await openRecord('post', msg.record, sender.sign);
      if (post?.kind === 'private') box.posts.push({ post, signer: sender.sign, shared: true, host: sender.guid });
    } else if (msg.type === 'invite' && [msg.token, msg.key].every(x => typeof x === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(x))) {
      // An invitation to connect, sent straight to me instead of shared as a link (see sendInvite). Anonymous: who it's
      // from shows only as their icon, from the server, and the name they suggest for themselves.
      box.invites.set(msg.token, { token: msg.token, key: msg.key, name: String(msg.name || '').slice(0, 60) });
    } else if (msg.type === 'join' && vault.data.posts?.[msg.pid]) {
      // A join says who it's from only when the person asking has me as a contact (see requestJoin). I show who it
      // is only if they're in my contacts too, with the keys I saved for them; otherwise it's anonymous like any other.
      const c = addChannel(channel, 'host', row.id, msg);
      c.from = sender && vault.data.contacts[sender.guid] && knownKeysMatch(sender.guid, sender) ? sender.guid : null;
    }
  }
}


// Hellos say who someone is: check the signature with the keys saved for (or the server has for) that GUID, and
// hand derive() those keys. A hello that doesn't check out is dropped.
async function checkHellos() {
  for (const c of box.channels.values()) {
    for (const [id, m] of c.messages) {
      if (m.type !== 'hello') continue;
      if (!box.helloChecked.has(id)) {
        let ok = null;
        try {
          const keys = (await keysFor([String(m.guid)]))[m.guid];
          if (keys && await verify(keys.sign, 'hello', await helloText(c.id, m.guid), m.sig)) ok = { guid: m.guid, ...keys };
        } catch {}
        box.helloChecked.set(id, ok);
      }
      const ok = box.helloChecked.get(id);
      if (ok) Object.assign(m, ok); else c.messages.delete(id);
    }
  }
}

// Read everything new and replay it. One at a time: a call while one is running waits for it and gets its result.
let loading = null;
export function loadMail({ act = true } = {}) {
  loading ||= (async () => {
    try { await read(); view = replay(); if (act && hasKeys() && await act_()) view = replay(); }
    finally { loading = null; }
    return view;
  })();
  return loading;
}

// Public posts that changed since the last read, plus the ones I've asked to join (which may have ended).
async function readPublic() {
  const pids = hasKeys() ? Object.values(vault.data.requests || {}).map(r => r.pid).filter(p => !box.publicAsked.has(p)) : [];
  for (let page = 0; page < 20; page++) {
    const res = await fetch('/api/public/read', {
      method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ after: box.publicSeq, pids: page ? [] : pids }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Couldn't load public posts");
    pids.forEach(p => box.publicAsked.add(p));
    for (const record of data.posts || []) {
      if (!box.publicChecked.has(record.sig)) {
        const post = await openRecord('post', record);
        box.publicChecked.set(record.sig, post?.kind === 'public' ? post : null);
        if (post?.kind === 'public') box.publicPosts.push({ post, signer: record.signer });
      }
    }
    box.publicSeq = Math.max(box.publicSeq, Number(data.seq) || 0);
    if (!data.more) break;
  }
}

async function read() {
  await readPublic();
  if (!hasKeys()) return;
  const me = myPublicKeys();
  if (!me.inbox || !vault.data.inbox) return;
  for (const [ch, r] of Object.entries(vault.data.requests || {})) addChannel(ch, 'attendee', r.at || 0, r.join);
  // Main inbox first (it can bring new channels), then every channel's two inboxes, until nothing new.
  for (let round = 0; round < 10; round++) {
    const chans = [...box.channels.values()];
    const tokens = [vault.data.inbox];
    for (const c of chans) { const x = await channelOf(c.id); tokens.push(x.openerInbox, x.recipientInbox); }
    const before = box.channels.size;
    const { mail, more } = await readInboxes(tokens);
    await readMainInbox(mail[0]);
    for (let i = 0; i < chans.length; i++) {
      for (const row of [...mail[1 + 2 * i], ...mail[2 + 2 * i]]) {
        const m = await openChannel(chans[i].id, row.body);
        if (m && typeof m.id === 'string' && !chans[i].messages.has(m.id)) chans[i].messages.set(m.id, m);
      }
    }
    if (!more && box.channels.size === before) break;
  }
  await checkHellos();
}

function myPostEntries() {
  if (!hasKeys()) return [];
  const me = myPublicKeys();
  return Object.values(vault.data.posts || {}).map(p => {
    try { return { post: JSON.parse(p.record.body), signer: me.sign }; } catch { return null; }
  }).filter(Boolean);
}

// Mine first, then shares, then public posts: the first signer seen for a pid owns it, so a public post can't take
// over the ID of a post someone shared with me. This is also the deck's order: shares, then public posts, the most
// recently published or changed first.
function replay() {
  return derive({
    me: hasKeys() ? myPublicKeys() : null,
    posts: [...myPostEntries(), ...box.posts, ...box.publicPosts.toReversed()],
    channels: [...box.channels.values()].map(c => ({ ...c, messages: [...c.messages.values()] })),
    passed: hasKeys() ? vault.data.passed || [] : [],
    passedAt: hasKeys() ? vault.data.passedAt || {} : {},
    deleted: hasKeys() ? vault.data.deleted || [] : [],
  });
}

// What happens on its own after reading: say hello after a match, add the other person to contacts, and (as host)
// move people off the waitlist and keep each post's status right. True if anything was sent.
async function act_() {
  let sent = false;
  const hellos = [], contacts = {};
  const each = (r, role) => {
    const other = role === 'host' ? 'attendee' : 'host';
    if ((r.status === 'accepted' || r.status === 'attended') && !r.hello[role]) hellos.push(r.id);
    const h = r.hello[other];
    // Not someone I deleted, unless this is a new match since (their hello came after).
    const gone = h && vault.data.removedContacts?.[h.guid];
    if (h && !vault.data.contacts[h.guid] && !(gone && h.at <= gone)) contacts[h.guid] = h;
  };
  view.requests.forEach(r => each(r, 'attendee'));
  view.hosting.forEach(h => h.requests.forEach(r => each(r, 'host')));
  const me = myPublicKeys();
  for (const ch of hellos) {
    try { await sendOn(ch, { type: 'hello', guid: me.guid, sig: await sign('hello', await helloText(ch, me.guid)) }, { poke: false }); sent = true; }
    catch (e) { console.warn('hello', e); }
  }
  const add = Object.keys(contacts);
  if (add.length) {
    await vault.update(api, (d) => {
      for (const g of add) {
        const { chat, sign: s, inbox } = contacts[g];
        d.contacts[g] ||= { nickname: '', tags: [], added: new Date().toISOString(), keys: { chat, sign: s, inbox } };
      }
    }).catch(e => console.warn('contacts', e));
  }
  for (const t of view.todo) {
    try {
      if (t.type === 'promote') await sendOn(t.ch, { type: 'answer', status: 'accepted' });
      else if (t.type === 'status') await setPostStatus(t.pid, t.status);
      sent = true;
    } catch (e) { console.warn('todo', e); }
  }
  return sent;
}

// ---------- sending ----------

async function postMail(items) {
  for (let i = 0; i < items.length; i += MAIL_BATCH) await api('/api/mail', { method: 'POST', body: { batch: items.slice(i, i + MAIL_BATCH) } });
}

// The other side of a channel, for pokes: the host (from the post I asked to join) or, once they've said hello, the
// attendee.
function peerOf(ch) {
  const c = box.channels.get(ch);
  if (c?.role === 'attendee') return vault.data.requests?.[ch]?.reply || null;
  const hello = [...(c?.messages.values() || [])].find(m => m.type === 'hello' && m.role === 'attendee' && m.inbox);
  return hello ? { chat: hello.chat, inbox: hello.inbox } : null;
}

// Send a message on a channel, as whichever side I am on it. poke: also wake up the other side's devices.
export async function sendOn(ch, fields, { poke = true } = {}) {
  const c = box.channels.get(ch);
  if (!c) throw new Error('That request is gone. Try reloading.');
  const msg = nextMessage([...c.messages.values()], c.role, fields);
  const x = await channelOf(ch);
  const items = [{ inbox: await inboxIdOf(c.role === 'attendee' ? x.recipientInbox : x.openerInbox), body: await sealChannel(ch, msg) }];
  const peer = poke && peerOf(ch);
  if (peer) items.push({ inbox: peer.inbox, body: (await sealTo(peer.chat, peer.inbox, { type: 'poke' })).body });
  await postMail(items);
  // My own hello is already checked: give it my keys, like checkHellos does for the ones read back.
  if (msg.type === 'hello') { const me = myPublicKeys(); box.helloChecked.set(msg.id, { guid: me.guid, chat: me.chat, sign: me.sign, inbox: me.inbox }); }
  c.messages.set(msg.id, { ...msg, ...(box.helloChecked.get(msg.id) || {}) });
  view = replay();
  return msg;
}

// The host of a post, if they're one of my contacts: who shared it with me, or the contact whose signing key signed
// it (for a public post). Otherwise null.
export function hostContact(post) {
  const contacts = hasKeys() ? vault.data.contacts : {};
  if (post?.host && contacts[post.host]) return post.host;
  const k = post?.signer;
  return (k && Object.keys(contacts).find(g => contacts[g].keys?.sign?.x === k.x && contacts[g].keys?.sign?.y === k.y)) || null;
}

// Ask to join a post. The channel secret goes into my vault before anything is sent, so it can't be lost.
// To a contact, the request says who it's from (signed), so they see my name; to anyone else it's anonymous.
export async function requestJoin(post, note = '') {
  if (!post.reply?.chat || !post.reply?.inbox) throw new Error("This post can't take requests.");
  const join = nextMessage([], 'attendee', { type: 'join', pid: post.pid, note: String(note).slice(0, 280) });
  const { body, channel } = await sealTo(post.reply.chat, post.reply.inbox, join, { identify: Boolean(hostContact(post)) });
  await vault.update(api, (d) => { d.requests ||= {}; d.requests[channel] = { pid: post.pid, join, reply: post.reply, at: join.at }; });
  try { await postMail([{ inbox: post.reply.inbox, body }]); }
  catch (e) { await vault.update(api, (d) => { delete d.requests?.[channel]; }).catch(() => {}); throw e; }
  addChannel(channel, 'attendee', join.at, join);
  view = replay();
  return channel;
}

// Invitations to connect mailed to me that I haven't answered yet, and marking one answered.
export const invitesForMe = () => {
  const seen = new Set(hasKeys() ? vault.data.invitesSeen || [] : []);
  return [...box.invites.values()].filter(i => !seen.has(i.token));
};
// declined: the invitation, kept so I can change my mind from the discard pile.
export const answerInvite = (token, { declined = null } = {}) => vault.update(api, (d) => {
  d.invitesSeen = [...(d.invitesSeen || []).filter(t => t !== token), token].slice(-500);
  d.invitesDeclined ||= {};
  if (declined) d.invitesDeclined[token] = { token, key: declined.key, name: declined.name, at: Date.now() };
  else delete d.invitesDeclined[token];
  const keep = Object.values(d.invitesDeclined).sort((a, b) => b.at - a.at).slice(0, 100);
  d.invitesDeclined = Object.fromEntries(keep.map(i => [i.token, i]));
});
export const declinedInvites = () => Object.values((hasKeys() && vault.data.invitesDeclined) || {}).sort((a, b) => b.at - a.at);
// Send an invitation to connect straight to the host of a post (their main inbox, from the post's reply address),
// sealed with no sender, like a request to join. invite: { token, key, name } (the vault entry).
export async function sendInvite(post, invite) {
  if (!post.reply?.chat || !post.reply?.inbox) throw new Error("This post's host can't be reached.");
  const { body } = await sealTo(post.reply.chat, post.reply.inbox, { type: 'invite', token: invite.token, key: invite.key, name: invite.name });
  await postMail([{ inbox: post.reply.inbox, body }]);
}

// Swiping no, and undoing it.
export const pass = (pid) => vault.update(api, (d) => {
  d.passed = [...(d.passed || []).filter(p => p !== pid), pid].slice(-MAX_PASSED);
  const keep = new Set(d.passed);
  d.passedAt = Object.fromEntries(Object.entries(d.passedAt || {}).filter(([p]) => keep.has(p)));
  d.passedAt[pid] = Date.now();
  d.deleted = (d.deleted || []).filter(p => keep.has(p));
}).then(() => { view = replay(); });
export const unpass = (pid) => vault.update(api, (d) => {
  d.passed = (d.passed || []).filter(p => p !== pid);
  if (d.passedAt) delete d.passedAt[pid];
  d.deleted = (d.deleted || []).filter(p => p !== pid);
}).then(() => { view = replay(); });
// Delete a pass from the discard pile: it stays passed (out of the deck), and leaves the pile for good.
export const deletePassed = (pid) => vault.update(api, (d) => {
  d.passed = [...(d.passed || []).filter(p => p !== pid), pid].slice(-MAX_PASSED);
  const keep = new Set(d.passed);
  d.deleted = [...(d.deleted || []).filter(p => p !== pid && keep.has(p)), pid];
}).then(() => { view = replay(); });

// Create or change a post I host. Each save is a new, signed version.
// - kind 'public': published to /api/public for everyone.
// - kind 'private': shared with `guids` (my contacts in its audience); people taken out of it get an unshare.
// A post keeps its kind: an edit can't turn a private post public or the other way round.
// When fields people care about changed, everyone already matched is asked to re-confirm. Returns { post, shared,
// missing, notified }: missing counts people who couldn't be reached (their account hasn't been opened since
// encryption arrived).
export async function savePost({ pid, kind, fields, audience, guids = [], status }) {
  const prev = pid && vault.data.posts?.[pid];
  const before = prev ? JSON.parse(prev.record.body) : null;
  kind = before?.kind || kind;
  if (kind !== 'public' && kind !== 'private') throw new Error('Pick who can see it');
  if (kind === 'public') guids = [];
  const me = myPublicKeys();
  const post = {
    ...(before || {}), ...fields, pid: pid || randomId(), v: (before?.v || 0) + 1, kind,
    status: status || before?.status || 'open', reply: { chat: me.chat, inbox: me.inbox },
  };
  const record = await signRecord('post', post);
  // Publishing goes first for a public post: the server checks it, and nothing is saved if it says no.
  if (kind === 'public') await api('/api/public', { method: 'PUT', body: { record } });
  const keys = await keysFor(guids);
  const reach = guids.filter(g => keys[g]);
  const removed = (prev?.sharedWith || []).filter(g => !reach.includes(g));
  await vault.update(api, (d) => {
    d.posts ||= {};
    d.posts[post.pid] = { record, audience: kind === 'public' ? null : audience || d.posts[post.pid]?.audience || { groups: [], contacts: [] }, sharedWith: reach };
  });
  const items = [];
  for (const g of reach) items.push({ inbox: keys[g].inbox, body: (await sealTo(keys[g].chat, keys[g].inbox, { type: 'share', record }, { identify: true })).body });
  const gone = await keysFor(removed);
  for (const g of removed) if (gone[g]) items.push({ inbox: gone[g].inbox, body: (await sealTo(gone[g].chat, gone[g].inbox, { type: 'unshare', pid: post.pid, v: post.v }, { identify: true })).body });
  if (items.length) await postMail(items);

  let notified = 0;
  const changes = before ? changedFields(before, post) : [];
  if (changes.length) {
    view = replay();
    const h = view.hosting.find(x => x.post.pid === post.pid);
    for (const r of h?.requests.filter(x => x.status === 'accepted') || []) {
      try { await sendOn(r.id, { type: 'update', v: post.v, changes }); notified++; } catch (e) { console.warn('update', e); }
    }
  }
  view = replay();
  return { post, shared: reach.length, missing: guids.length - reach.length, notified };
}

// A new status for a post I host (full, open, past, or cancelled to remove it), to the same audience.
export async function setPostStatus(pid, status) {
  const p = vault.data.posts?.[pid];
  if (!p) return;
  return savePost({ pid, fields: {}, audience: p.audience, guids: p.sharedWith, status });
}

// Re-share a post after its audience changed (e.g. contacts were added to a group it's shared with).
export async function reshare(pid, guids) {
  const p = vault.data.posts?.[pid];
  const post = p && JSON.parse(p.record.body);
  if (!post || post.kind !== 'private' || !LIVE.includes(post.status)) return;
  const keys = await keysFor(guids), reach = guids.filter(g => keys[g]);
  const same = reach.length === p.sharedWith.length && reach.every(g => p.sharedWith.includes(g));
  if (!same) await savePost({ pid, fields: {}, audience: p.audience, guids });
}
