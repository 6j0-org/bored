import assert from 'node:assert/strict';
import { derive, replayChannel, orderChannel, nextMessage } from '../../public/posts.js';

const HOST = { x: 'hx', y: 'hy' }, GUEST = { x: 'gx', y: 'gy' }, OTHER = { x: 'ox', y: 'oy' };
const post = (pid, v, extra = {}) => ({ pid, v, kind: 'public', status: 'open', title: pid, max_attendees: null, ...extra });
let clock = 1;
// A channel both sides append to, through nextMessage (as the app will).
function channel(pid, note = '') {
  const msgs = [];
  const send = (role, fields) => { const m = { ...nextMessage(msgs, role, fields), at: clock++ }; msgs.push(m); return m; };
  send('attendee', { type: 'join', pid, note });
  return { msgs, send, state: () => replayChannel(msgs) };
}
const ID = (id) => ({ guid: id, chat: { x: id }, sign: { x: id }, inbox: id + '-inbox' });

// 1. join → accept → hello both ways → chat → happened.
{
  const c = channel('p1', 'hi');
  assert.equal(c.state().status, 'pending');
  c.send('host', { type: 'answer', status: 'accepted' });
  c.send('host', { type: 'hello', ...ID('host-guid') });
  c.send('attendee', { type: 'hello', ...ID('guest-guid') });
  c.send('attendee', { type: 'chat', text: 'see you' });
  c.send('host', { type: 'happened' });
  const s = c.state();
  assert.equal(s.status, 'attended');
  assert.equal(s.hello.host.guid, 'host-guid');
  assert.equal(s.hello.attendee.guid, 'guest-guid');
  assert.deepEqual(s.timeline.map(t => t.event), ['chat', 'happened']);
  assert.equal(s.note, 'hi');
}

// 2. Messages that the rules don't allow are ignored.
{
  const c = channel('p1');
  c.send('attendee', { type: 'chat', text: 'not matched yet' });   // chat before accepted
  c.send('attendee', { type: 'answer', status: 'accepted' });       // wrong role (dropped before ordering)
  c.send('host', { type: 'hello', ...ID('h') });                    // hello before accepted
  c.send('host', { type: 'happened' });                             // happened before accepted
  assert.equal(c.state().status, 'pending');
  assert.equal(c.state().timeline.length, 0);
  // Ignored messages still count for n, so they leave no gap, and later messages apply.
  c.send('host', { type: 'answer', status: 'accepted' });
  c.send('attendee', { type: 'chat', text: 'after' });
  let s = c.state();
  assert.equal(s.status, 'accepted');
  assert.deepEqual(s.gap, { host: false, attendee: false });
  assert.deepEqual(s.timeline.map(t => t.text), ['after']);
  // A lost message is a gap: that side's later messages wait until it turns up.
  const lost = c.send('attendee', { type: 'chat', text: 'lost' });
  c.send('attendee', { type: 'chat', text: 'later' });
  c.msgs.splice(c.msgs.indexOf(lost), 1);
  s = c.state();
  assert.equal(s.gap.attendee, true);
  assert.deepEqual(s.timeline.map(t => t.text), ['after']);
  c.msgs.push(lost);
  assert.deepEqual(c.state().timeline.map(t => t.text), ['after', 'lost', 'later']);
}

// 3. Duplicates and replays: the same message twice counts once; reflected messages change nothing.
{
  const c = channel('p1');
  const a = c.send('host', { type: 'answer', status: 'accepted' });
  const chat = c.send('attendee', { type: 'chat', text: 'once' });
  c.msgs.push({ ...chat }, { ...a }); // replayed copies
  assert.deepEqual(c.state().timeline.map(t => t.text), ['once']);
  // Two different messages with the same n: the smaller id wins, the same on every device.
  const forged = { ...chat, id: '0', text: 'other' };
  assert.equal(replayChannel([...c.msgs, forged]).timeline[0].text, 'other');
  assert.equal(replayChannel([forged, ...c.msgs]).timeline[0].text, 'other');
}

// 4. Crossed messages: unjoin and accept sent at the same time. Host first, so the unjoin no longer applies,
//    and both sides get the same result whatever order the mail arrived in.
{
  const join = { type: 'join', role: 'attendee', n: 1, seen: 0, id: 'j', pid: 'p1', at: 1 };
  const accept = { type: 'answer', role: 'host', n: 1, seen: 1, id: 'a', status: 'accepted', at: 2 };
  const unjoin = { type: 'unjoin', role: 'attendee', n: 2, seen: 0, id: 'u', at: 2 };
  assert.equal(replayChannel([join, accept, unjoin]).status, 'accepted');
  assert.equal(replayChannel([unjoin, join, accept]).status, 'accepted');
  // If the unjoin had been seen by the host, the host's later accept would come after it, and not apply.
  const accept2 = { ...accept, seen: 2 };
  assert.equal(replayChannel([join, accept2, unjoin]).status, 'cancelled');
  assert.deepEqual(orderChannel([accept2, unjoin, join]).ordered.map(m => m.id), ['j', 'u', 'a']);
}

// 5. undo: allowed until there's a chat.
{
  const c = channel('p1');
  c.send('host', { type: 'answer', status: 'declined' });
  c.send('host', { type: 'undo' });
  assert.equal(c.state().status, 'pending');
  c.send('host', { type: 'answer', status: 'accepted' });
  c.send('attendee', { type: 'chat', text: 'yay' });
  c.send('host', { type: 'undo' });
  assert.equal(c.state().status, 'accepted', 'no undo after chatting');
}

// 6. Edit → re-confirm: yes keeps them in, no withdraws them; re-confirm without being asked is ignored.
{
  const c = channel('p1');
  c.send('host', { type: 'answer', status: 'accepted' });
  c.send('attendee', { type: 'reconfirm', yes: true });
  assert.equal(c.state().timeline.length, 0);
  c.send('host', { type: 'update', v: 2, changes: ['when_text'] });
  assert.equal(c.state().reconfirm, true);
  c.send('attendee', { type: 'reconfirm', yes: true });
  assert.equal(c.state().reconfirm, false);
  c.send('host', { type: 'update', v: 3, changes: ['location'] });
  c.send('attendee', { type: 'reconfirm', yes: false });
  assert.equal(c.state().status, 'withdrawn');
  assert.deepEqual(c.state().timeline.map(t => t.event), ['updated', 'reconfirmed', 'updated', 'reconfirm-no']);
}

// 7. derive: fullness, the waitlist, leaving, and moving off the waitlist, from the host's side.
{
  const p = post('hike', 1, { max_attendees: 2 });
  const chans = [];
  const join = (opened) => { const c = channel('hike'); chans.push({ id: 'ch' + opened, role: 'host', opened, c }); return c; };
  const a = join(1), b = join(2), c = join(3), d = join(4);
  const run = () => derive({ me: { sign: HOST }, posts: [{ post: p, signer: HOST }], channels: chans.map(x => ({ ...x, messages: x.c.msgs })) });

  let r = run();
  assert.equal(r.badges.confirm, 4);
  a.send('host', { type: 'answer', status: 'accepted' });
  b.send('host', { type: 'answer', status: 'accepted' });
  r = run();
  assert.equal(r.hosting[0].status, 'full');
  assert.deepEqual(r.todo, [{ type: 'status', pid: 'hike', status: 'full' }]);
  // Full: yes means the waitlist. d asked after c but is answered first; first come, first served is by join.
  d.send('host', { type: 'answer', status: 'waitlisted' });
  c.send('host', { type: 'answer', status: 'waitlisted' });
  p.status = 'full';
  assert.deepEqual(run().todo, []);
  // a leaves: c (joined before d) gets the spot.
  a.send('attendee', { type: 'leave' });
  r = run();
  assert.deepEqual(r.todo, [{ type: 'promote', ch: 'ch3', pid: 'hike' }]);
  assert.equal(r.hosting[0].status, 'full', 'still full once c is in');
  c.send('host', { type: 'answer', status: 'accepted' });
  r = run();
  assert.deepEqual(r.todo, []);
  assert.equal(r.badges.plans, 2);
  assert.equal(r.hosting[0].requests.find(x => x.id === 'ch3').timeline[0].event, 'promoted');
  // Everyone who matched went: past.
  b.send('host', { type: 'happened' }); c.send('host', { type: 'happened' });
  r = run();
  assert.deepEqual(r.todo, [{ type: 'status', pid: 'hike', status: 'past' }]);
}

// 8. derive: the deck and my requests, from the attendee's side.
{
  const pub = post('pub', 1), priv = post('priv', 1, { kind: 'private' }), mine = post('mine', 1), gone = post('gone', 1);
  const passed = post('meh', 1), asked = post('asked', 1);
  const c = channel('asked'); c.send('host', { type: 'answer', status: 'accepted' });
  c.send('host', { type: 'hello', ...ID('host-guid') });
  const r = derive({
    me: { sign: GUEST },
    posts: [
      { post: pub, signer: HOST }, { post: priv, signer: HOST, shared: true }, { post: mine, signer: GUEST },
      { post: gone, signer: HOST, shared: true }, { unshare: { pid: 'gone', v: 1 }, signer: HOST },
      { post: passed, signer: HOST }, { post: asked, signer: HOST },
      { post: { ...pub, v: 2, title: 'pub v2' }, signer: HOST },
      { post: { ...pub, v: 9, title: 'impostor' }, signer: OTHER },   // someone else reusing the pid
      { unshare: { pid: 'priv', v: 5 }, signer: OTHER },               // can't unshare someone else's post
      { post: { pid: 'bad', v: 0, status: 'open' }, signer: HOST },    // malformed
    ],
    channels: [{ id: 'c1', role: 'attendee', opened: 1, messages: c.msgs }],
    passed: ['meh'],
  });
  assert.deepEqual(r.deck.map(p => p.pid).sort(), ['priv', 'pub']);
  assert.equal(r.posts.get('pub').title, 'pub v2');
  assert.equal(r.requests.length, 1);
  assert.equal(r.requests[0].status, 'accepted');
  assert.equal(r.requests[0].post.pid, 'asked');
  assert.equal(r.badges.plans, 1);
  assert.equal(r.hosting.length, 1, 'my own post');
  // A re-share with a higher version brings an unshared post back.
  const r2 = derive({ me: { sign: GUEST }, posts: [
    { post: gone, signer: HOST, shared: true }, { unshare: { pid: 'gone', v: 1 }, signer: HOST },
    { post: { ...gone, v: 2 }, signer: HOST, shared: true }] });
  assert.deepEqual(r2.deck.map(p => p.pid), ['gone']);
  // The discard pile: the matched request isn't in it (it can't be re-swiped), the pass is.
  assert.deepEqual(r.swiped.map(p => [p.pid, p.swipe]), [['meh', 'pass']]);
}

// 8b. derive: the discard pile, most recently swiped first; a request counts over a pass for the same post.
{
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(pid => post(pid, 1));
  const ca = channel('a'); ca.msgs.forEach(m => { m.at = 200; });
  const cc = channel('c'); cc.send('host', { type: 'answer', status: 'declined' });
  const cd = channel('d'); cd.msgs.forEach(m => { m.at = 50; });
  const r = derive({
    me: { sign: GUEST },
    posts: [a, b, c, d].map(p => ({ post: p, signer: HOST })),
    channels: [{ id: 'ca', role: 'attendee', opened: 1, messages: ca.msgs }, { id: 'cc', role: 'attendee', opened: 2, messages: cc.msgs },
      { id: 'cd', role: 'attendee', opened: 3, messages: cd.msgs }],
    passed: ['b', 'd'], passedAt: { b: 100 },
  });
  assert.deepEqual(r.swiped.map(p => [p.pid, p.swipe, p.request]), [['a', 'in', 'pending'], ['b', 'pass', null], ['d', 'in', 'pending']]);
  assert.equal(r.swiped[0].ch, 'ca');
  assert.equal(r.deck.length, 0);
}

// 9. Done together: attended matches, from either side.
{
  const c = channel('x'); c.send('host', { type: 'answer', status: 'accepted' });
  c.send('attendee', { type: 'hello', ...ID('guest-guid') }); c.send('host', { type: 'happened' });
  const r = derive({ me: { sign: HOST }, posts: [{ post: post('x', 1, { max_attendees: 1 }), signer: HOST }],
    channels: [{ id: 'k', role: 'host', opened: 1, messages: c.msgs }] });
  assert.deepEqual(r.together, { 'guest-guid': 1 });
}
console.log('posts.js: all scripted sequences pass');
