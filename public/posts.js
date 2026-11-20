// Posts, requests, matches, and chat as messages, and derive(), which replays them into what the app shows.
//
// The server only stores mail (see "mail" in public/secure.js), so the rules it used to enforce live here, and every
// browser applies them the same way to the same messages. Anything the rules don't allow is ignored, which is also
// the spam filter. This file is pure: no crypto, no network. The mail loader opens and checks everything first
// (signatures, senders, and the identities in `hello`) and hands derive() plain objects.
//
// Posts are signed by their host: { pid, v, kind: 'public' | 'private', status, title, details, tags, location,
// location_name, online, when_text, max_attendees, cost_amount, cost_currency, reply: { chat, inbox } }.
// - pid is random; v goes up with every change (the newest wins).
// - status: open | full (every spot is taken) | past (it happened) | cancelled (the host removed it).
// - reply is where requests to join go: the host's chat public key and main inbox.
// A private post reaches the people it's shared with as a `share`, and leaves with an `unshare` ({ pid, v }).
//
// Requests to join: someone asking to join opens a channel (secure.js channelOf) with a sealed `join`, and every
// message after that about the request goes over the channel. Two sides, `host` and `attendee`; each message is
// { type, role, n, seen, id, at, ... }:
// - role: who sent it. Messages with the wrong role for their type are ignored.
// - n: the sender's own counter, 1, 2, 3, … (the join is the attendee's 1). A missing n stops that side's messages
//   there (a gap), since later ones may depend on it; the same n twice keeps one, the one with the smaller id.
// - seen: how many of the other side's messages the sender had seen. This gives both sides the same order for
//   the two streams: a message comes after everything it saw, and when neither side saw the other's message
//   (they crossed), the host's goes first.
// - id: random, for telling copies of the same message apart. at: the sender's clock, in ms, for display only.
//
// Message types (sender: what it needs → what it does):
//   join       attendee: first message, { pid, note }                  → pending
//   unjoin     attendee: pending or waitlisted                         → cancelled (take back the request)
//   answer     host: { status: accepted | waitlisted | declined }
//              from pending: any of the three; from waitlisted: accepted (a spot opened) or declined
//   undo       host: declined, waitlisted, or accepted with no chat yet → pending
//   hello      either: accepted or attended, once per side, { guid, chat, sign, inbox } (checked by the loader)
//   update     host: { v }, the post changed                           → accepted people must re-confirm
//   reconfirm  attendee: accepted and asked to, { yes }                → still in, or withdrawn
//   leave      attendee: accepted                                      → withdrawn
//   happened   host: accepted                                          → attended
//   chat       either: accepted or attended, { text }

export const POST_STATUSES = ['open', 'full', 'past', 'cancelled'];
export const LIVE = ['open', 'full'];
export const MAX_NOTE = 500, MAX_CHAT = 4000;

const SENDER = {
  join: 'attendee', unjoin: 'attendee', reconfirm: 'attendee', leave: 'attendee',
  answer: 'host', undo: 'host', update: 'host', happened: 'host',
  hello: 'both', chat: 'both',
};

const sameKey = (a, b) => Boolean(a && b && a.x === b.x && a.y === b.y);
const isPost = (p) => p && typeof p.pid === 'string' && p.pid && Number.isInteger(p.v) && p.v > 0 && POST_STATUSES.includes(p.status);

// ---------- one channel ----------

// The two sides' messages, checked and in the order both sides agree on.
export function orderChannel(messages) {
  const sides = { host: new Map(), attendee: new Map() };
  for (const m of messages) {
    if (!m || !(m.role in sides) || !Number.isInteger(m.n) || m.n < 1 || !Number.isInteger(m.seen) || m.seen < 0) continue;
    if (!SENDER[m.type] || (SENDER[m.type] !== 'both' && SENDER[m.type] !== m.role)) continue;
    const prev = sides[m.role].get(m.n);
    if (!prev || String(m.id) < String(prev.id)) sides[m.role].set(m.n, m);
  }
  // Each side's messages up to the first missing n.
  const run = (map) => { const out = []; for (let n = 1; map.has(n); n++) out.push(map.get(n)); return out; };
  const H = run(sides.host), A = run(sides.attendee);
  const gap = { host: sides.host.size > H.length, attendee: sides.attendee.size > A.length };
  const out = [];
  let h = 0, a = 0;
  while (h < H.length || a < A.length) {
    if (a >= A.length) out.push(H[h++]);
    else if (h >= H.length) out.push(A[a++]);
    else if (H[h].seen >= A[a].n) out.push(A[a++]);      // the host's message saw this one
    else if (A[a].seen >= H[h].n) out.push(H[h++]);      // the attendee's message saw this one
    else out.push(H[h++]);                                // crossed: host first
  }
  return { ordered: out, gap, counts: { host: H.length, attendee: A.length } };
}

// Replay one channel. Returns its state, or null if it doesn't start with a proper join.
export function replayChannel(messages) {
  const { ordered, gap, counts } = orderChannel(messages);
  const join = ordered[0];
  if (!join || join.type !== 'join' || join.role !== 'attendee' || join.n !== 1 || typeof join.pid !== 'string') return null;
  const st = {
    pid: join.pid, note: String(join.note || '').slice(0, MAX_NOTE), status: 'pending', reconfirm: false,
    hello: { host: null, attendee: null }, timeline: [], chatted: false, gap, counts,
    joinedAt: Number(join.at) || 0, updatedAt: Number(join.at) || 0,
  };
  for (const m of ordered.slice(1)) {
    if (apply(st, m)) st.updatedAt = Math.max(st.updatedAt, Number(m.at) || 0);
  }
  return st;
}

// Apply one message to a channel's state; false (and no change) if the rules don't allow it.
function apply(st, m) {
  const s = st.status, line = (event, extra = {}) => st.timeline.push({ event, role: m.role, at: Number(m.at) || 0, ...extra });
  switch (m.type) {
    case 'join': return false; // only as the first message
    case 'unjoin':
      if (s !== 'pending' && s !== 'waitlisted') return false;
      st.status = 'cancelled'; return true;
    case 'answer':
      if (!(s === 'pending' && ['accepted', 'waitlisted', 'declined'].includes(m.status)) &&
          !(s === 'waitlisted' && ['accepted', 'declined'].includes(m.status))) return false;
      if (s === 'waitlisted' && m.status === 'accepted') line('promoted');
      st.status = m.status; st.reconfirm = false; return true;
    case 'undo':
      if (!['declined', 'waitlisted', 'accepted'].includes(s) || (s === 'accepted' && st.chatted)) return false;
      st.status = 'pending'; st.reconfirm = false; return true;
    case 'hello': {
      if (s !== 'accepted' && s !== 'attended') return false;
      if (st.hello[m.role] || typeof m.guid !== 'string' || !m.chat || !m.sign) return false;
      st.hello[m.role] = { guid: m.guid, chat: m.chat, sign: m.sign, inbox: m.inbox || null, at: Number(m.at) || 0 };
      return true;
    }
    case 'update':
      if (s !== 'accepted' || !Number.isInteger(m.v)) return false;
      st.reconfirm = true; line('updated', { v: m.v, changes: Array.isArray(m.changes) ? m.changes.map(String) : [] });
      return true;
    case 'reconfirm':
      if (s !== 'accepted' || !st.reconfirm) return false;
      st.reconfirm = false;
      if (m.yes) line('reconfirmed'); else { st.status = 'withdrawn'; line('reconfirm-no'); }
      return true;
    case 'leave':
      if (s !== 'accepted') return false;
      st.status = 'withdrawn'; st.reconfirm = false; line('left'); return true;
    case 'happened':
      if (s !== 'accepted') return false;
      st.status = 'attended'; st.reconfirm = false; line('happened'); return true;
    case 'chat':
      if ((s !== 'accepted' && s !== 'attended') || typeof m.text !== 'string' || !m.text.trim()) return false;
      st.chatted = true; line('chat', { text: m.text.slice(0, MAX_CHAT) }); return true;
  }
  return false;
}

// The next message for my side of a channel: fills in n, seen, id, and at.
export function nextMessage(channelMessages, role, fields) {
  const { counts } = orderChannel(channelMessages);
  const other = role === 'host' ? 'attendee' : 'host';
  return {
    ...fields, role, n: counts[role] + 1, seen: counts[other],
    id: Array.from(globalThis.crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join(''),
    at: Date.now(),
  };
}

// ---------- everything ----------

// input:
//   me:       { sign } my signing public key (JWK), to tell which posts are mine
//   posts:    [{ post, signer, shared?: true, host?: guid } | { unshare: { pid, v }, signer }], every version
//             seen, signatures already checked (public posts, shares and unshares from my inbox, and my own from the
//             vault). host is the host's GUID when known (a share says who it's from).
//   channels: [{ id, role: 'host' | 'attendee', opened, messages }], id is the channel secret, opened sorts
//             requests first come, first served (when the join arrived)
//   passed:   pids I swiped no on
//
// Returns { posts, deck, requests, hosting, todo, badges, together }:
//   posts:    Map pid → newest version, with .signer and .hidden (unshared from me)
//   deck:     posts to swipe on: live, not mine, not hidden, not passed, and not already asked about (a request I
//             took back doesn't count, so the post comes back)
//   swiped:   the discard pile: live posts (not mine, not hidden) I passed on or am waiting to hear back about, most
//             recently swiped first: { ...post, swipe: 'in' | 'pass', ch (my request's channel, for 'in'), request
//             status }. Matched, declined, and other answered requests aren't in it: they can't be re-swiped.
//   requests: my requests to join (I'm the attendee), newest first: channel state plus post and channel id
//   hosting:  my posts, each with its requests ({ ...channel state, id, from }), counts, and the status it should have;
//             from is the GUID of a contact who said who they are when they asked (the loader checks it), else null
//   todo:     what the host's browser should send: { type: 'promote', ch } and { type: 'status', pid, status }
//   badges:   { confirm: requests waiting for my answer, plans: accepted matches on either side }
//   together: { guid: times we've done something together } (attended, either side)
//   stats:    { hosted: my posts that happened with someone, attended: posts I went to, helped: different hosts of
//             posts tagged "help" I went to }
export function derive({ me, posts = [], channels = [], passed = [], passedAt = {} }) {
  // Posts: per pid, the first signer seen owns it (mine always wins), and the newest version counts.
  const owner = new Map(), latest = new Map(), unshared = new Map();
  for (const e of posts) {
    const pid = e.post?.pid ?? e.unshare?.pid;
    if (!pid || !e.signer) continue;
    if (!owner.has(pid) || (sameKey(e.signer, me?.sign) && !sameKey(owner.get(pid), me?.sign))) owner.set(pid, e.signer);
  }
  for (const e of posts) {
    const pid = e.post?.pid ?? e.unshare?.pid;
    if (!pid || !sameKey(e.signer, owner.get(pid))) continue;
    if (e.unshare) { if (Number.isInteger(e.unshare.v)) unshared.set(pid, Math.max(unshared.get(pid) || 0, e.unshare.v)); continue; }
    if (!isPost(e.post)) continue;
    const cur = latest.get(pid);
    if (!cur || e.post.v > cur.v) latest.set(pid, { ...e.post, signer: e.signer, shared: Boolean(e.shared), host: e.host ?? cur?.host ?? null });
  }
  for (const [pid, p] of latest) p.hidden = (unshared.get(pid) || 0) >= p.v;

  const replayed = channels.map(c => ({ c, st: replayChannel(c.messages || []) })).filter(x => x.st);
  const mine = (p) => sameKey(p.signer, me?.sign);
  const together = {};
  const count = (guid) => { if (guid) together[guid] = (together[guid] || 0) + 1; };

  // My requests (I'm the attendee).
  const asked = new Set();
  const requests = replayed.filter(x => x.c.role === 'attendee').map(({ c, st }) => {
    if (st.status !== 'cancelled') asked.add(st.pid);
    const post = latest.get(st.pid) || null;
    if (st.status === 'attended') count(st.hello.host?.guid);
    return { ...st, id: c.id, post, closed: !post || !LIVE.includes(post.status) };
  }).sort((a, b) => b.updatedAt - a.updatedAt);

  // Posts I host, with their requests.
  const todo = [];
  const hosting = [...latest.values()].filter(mine).map(post => {
    const reqs = replayed.filter(x => x.c.role === 'host' && x.st.pid === post.pid)
      .sort((a, b) => (a.c.opened ?? 0) - (b.c.opened ?? 0) || String(a.c.id).localeCompare(String(b.c.id)))
      .map(({ c, st }) => ({ ...st, id: c.id, from: c.from || null }));
    for (const r of reqs) if (r.status === 'attended') count(r.hello.attendee?.guid);
    const n = (s) => reqs.filter(r => r.status === s).length;
    const accepted = n('accepted'), attended = n('attended');
    let status = post.status;
    if (LIVE.includes(post.status)) {
      // First come, first served off the waitlist into open spots, then open or full (or past, once everyone
      // who matched has been marked as there), the same rule the server used.
      const max = post.max_attendees ?? null;
      let room = max === null ? Infinity : max - accepted - attended;
      for (const r of reqs) if (room > 0 && r.status === 'waitlisted') { todo.push({ type: 'promote', ch: r.id, pid: post.pid }); room--; }
      const filled = accepted + attended + todo.filter(t => t.pid === post.pid).length;
      status = max === null || filled < max ? 'open' : filled - attended === 0 ? 'past' : 'full';
      if (status !== post.status) todo.push({ type: 'status', pid: post.pid, status });
    }
    return {
      post, requests: reqs, status,
      counts: { pending: n('pending'), accepted, attended, waitlisted: n('waitlisted'), reconfirm: reqs.filter(r => r.reconfirm).length },
    };
  });

  const passedSet = new Set(passed);
  const deck = [...latest.values()].filter(p =>
    LIVE.includes(p.status) && !mine(p) && !p.hidden && !passedSet.has(p.pid) && !asked.has(p.pid));
  const swipeable = (p) => p && LIVE.includes(p.status) && !mine(p) && !p.hidden;
  const swiped = [
    ...requests.filter(r => ['pending', 'waitlisted'].includes(r.status) && swipeable(r.post))
      .map(r => ({ ...r.post, swipe: 'in', ch: r.id, request: r.status, at: r.joinedAt })),
    // A request counts over a pass for the same post (asked after passing, from a share link or a second device).
    ...passed.map(pid => latest.get(pid)).filter(p => swipeable(p) && !asked.has(p.pid))
      .map(p => ({ ...p, swipe: 'pass', ch: null, request: null, at: Number(passedAt[p.pid]) || 0 })),
  ].sort((a, b) => b.at - a.at);

  const badges = {
    confirm: hosting.filter(h => LIVE.includes(h.post.status)).reduce((n, h) => n + h.counts.pending, 0),
    plans: requests.filter(r => r.status === 'accepted').length + hosting.reduce((n, h) => n + h.counts.accepted, 0),
  };
  const went = requests.filter(r => r.status === 'attended');
  const stats = {
    hosted: hosting.filter(h => h.counts.attended > 0).length,
    attended: went.length,
    helped: new Set(went.filter(r => (r.post?.tags || []).includes('help')).map(r => r.hello.host?.guid || r.post.signer?.x)).size,
  };
  return { posts: latest, deck, swiped, requests, hosting, todo, badges, together, stats };
}
