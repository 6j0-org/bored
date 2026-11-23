// A public post in the real UI: a host posts it, and a stranger (not a contact) asks to join with a note, which the
// host sees with the request.
import assert from 'node:assert/strict';
import { browser, finish, wait } from '../lib.mjs';

const A = await browser('host'), B = await browser('stranger');
const r = {}, TITLE = `Public kite flying ${Date.now() % 100000}`;
await A.tab('post');
r.form = await A.ev(`document.querySelector('#newEvent input[name=visibility][value=public]').disabled`);
await A.ev(`(() => { const f = document.getElementById('newEvent'); f.title.value = '${TITLE}'; f.max_attendees.value = '3';
  f.querySelector('input[name=visibility][value=public]').click(); })()`);
r.publicButton = await A.ev(`document.querySelector('#newEvent [data-post-button]').textContent`);
await A.ev(`window.confirm = (q) => { window.asked = q; return true; }; document.getElementById('newEvent').requestSubmit()`);
await wait(3000);
r.posted = await A.ev(`document.getElementById('toast').textContent`);
r.hostRow = await A.ev(`[...document.querySelectorAll('#view .post-card')].find(x => x.innerText.includes('${TITLE}'))?.innerText.replace(/\\s+/g, ' ')`);
// Editing: the visibility stays public.
await A.ev(`[...document.querySelectorAll('#view .post-card')].find(x => x.innerText.includes('${TITLE}')).querySelector('[data-edit]').click()`); await wait(800);
r.editLock = await A.ev(`(() => { const s = document.querySelector('.sheet'); return [s.querySelector('input[name=visibility][value=private]').disabled, s.querySelector('.note')?.textContent.trim()]; })()`);
await A.ev(`document.querySelector('.sheet').remove()`);

// The stranger swipes yes on it (demo hosts' old posts are in the deck too, so swipe no until it's on top).
await B.tab('discover');
for (let i = 0; i < 30; i++) {
  const top = await B.ev(`document.querySelector('.card.top h2')?.textContent`);
  if (top === TITLE) break;
  await B.ev(`document.querySelector('.round.no').click()`); await wait(900);
}
r.strangerCard = await B.ev(`document.querySelector('.card.top').innerText.replace(/\\s+/g, ' ').slice(0, 200)`);
// I'm in opens Ask to join: 4 stars (tapping the 2nd then the 4th) and a note.
await B.ev(`document.querySelector('.round.yes').click()`);
await B.until(`document.querySelector('.sheet textarea[name=note]')`);
await B.ev(`document.querySelector('.sheet [data-interest="2"]').click(); document.querySelector('.sheet [data-interest="4"]').click()`);
r.stars = await B.ev(`[...document.querySelectorAll('.sheet .interest-star')].map(b => b.textContent).join('') + ' ' + document.querySelector('.sheet .interest-label').textContent`);
await B.ev(`(() => { const f = document.querySelector('.sheet form'); f.note.value = 'I can bring a spare kite.'; f.requestSubmit(); })()`);
await wait(2500);
r.asked = await B.ev(`document.getElementById('toast').textContent`);

// The host accepts the anonymous request; the stranger then sees the match in Plans.
await A.tab('discover'); await A.tab('confirm');
// The demo account's own seeded requests come first: say no to them until ours is on top.
for (let i = 0; i < 10; i++) {
  if (await A.ev(`document.querySelector('.card.top')?.innerText.includes('${TITLE}')`)) break;
  await A.ev(`document.querySelector('.round.no')?.click()`); await wait(1500);
}
await A.until(`document.querySelector('.card.top')?.innerText.includes('${TITLE}')`);
r.request = (await A.text()).slice(0, 400);
await A.ev(`document.querySelector('.round.yes').click()`);
await A.until(`document.querySelector('.overlay h1')`);
await B.tab('plans');
await B.until(`document.getElementById('view').innerText.includes('${TITLE}')`, 25000);
r.strangerPlans = (await B.text()).slice(0, 300);
r.overlay = await A.ev(`document.querySelector('.overlay').innerText.replace(/\\s+/g, ' ')`);
await A.ev(`document.getElementById('mKeep').click()`);

// Matching doesn't connect them: the stranger's chat offers an invitation, which needs both nicknames, and it shows
// up in the host's Confirm tab.
await B.ev(`[...document.querySelectorAll('.plan-card[data-id^="m:"]')].find(c => c.innerText.includes('${TITLE}')).querySelector('h2').click()`);
await B.until(`document.getElementById('connectChat')`, 20000);
r.connectNote = await B.ev(`document.querySelector('.connect-note').innerText.replace(/\\s+/g, ' ')`);
await B.ev(`document.getElementById('connectChat').click()`);
await B.until(`document.querySelector('.sheet input[name=their]')`);
await B.ev(`(() => { const f = document.querySelector('.sheet form'); f.their.value = 'Kite host'; f.name.value = 'Kite fan'; f.requestSubmit(); })()`);
await B.until(`document.getElementById('toast').textContent.includes('Invitation sent')`);
await A.tab('discover'); await A.tab('confirm');
await A.until(`document.getElementById('view').innerText.includes('Kite fan')`, 25000);
console.log(JSON.stringify(r, null, 2));
assert.equal(r.form, false, 'a new post can be public');
assert.match(r.posted, /Anyone can now swipe on it/);
assert.equal(r.publicButton, 'Post it publicly');
assert.match(await A.ev(`window.asked`), /^Post this publicly\?/, 'a public post asks first');
assert.match(r.hostRow, /Public · 0\/3 matched/);
assert.equal(r.editLock[0], true, 'a public post stays public');
assert.match(r.strangerCard, new RegExp(TITLE));
assert.match(r.asked, /^Asked to join/);
assert.match(r.request, /Someone you don't know yet/);
assert.match(r.request, /“I can bring a spare kite\.”/, "the host sees the stranger's note");
assert.equal(r.stars, '★★★★☆ 4 of 5: Very interested. Only the host sees it.', 'tapping a star picks up to it');
assert.match(r.request, /★★★★☆ Very interested/, 'and how interested they are');
assert.match(r.strangerPlans, new RegExp(`${TITLE}[\\s\\S]*Hosted by`));
assert.match(r.overlay, /teaming up[\s\S]*Invite them to connect from the chat/, "the match screen doesn't say they're contacts");
assert.match(r.connectNote, /not connected/);
A.close(); B.close();
finish('browser public');
