// A public post in the real UI: a host posts it, and a stranger (not a contact) joins.
import assert from 'node:assert/strict';
import { browser, finish, wait } from '../lib.mjs';

const A = await browser('host'), B = await browser('stranger');
const r = {}, TITLE = `Public kite flying ${Date.now() % 100000}`;
await A.tab('post');
r.form = await A.ev(`document.querySelector('#newEvent input[name=visibility][value=public]').disabled`);
await A.ev(`(() => { const f = document.getElementById('newEvent'); f.title.value = '${TITLE}'; f.max_attendees.value = '3';
  f.querySelector('input[name=visibility][value=public]').click(); f.requestSubmit(); })()`);
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
await B.ev(`document.querySelector('.round.yes').click()`); await wait(2500);
r.asked = await B.ev(`document.getElementById('toast').textContent`);

// The host accepts the anonymous request; the stranger then sees the match in Plans.
await A.tab('discover'); await A.tab('confirm');
// The demo account's own seeded requests come first: say no to them until ours is on top.
for (let i = 0; i < 10; i++) {
  if (await A.ev(`document.querySelector('.card.top')?.innerText.includes('${TITLE}')`)) break;
  await A.ev(`document.querySelector('.round.no')?.click()`); await wait(1500);
}
await A.until(`document.querySelector('.card.top')?.innerText.includes('${TITLE}')`);
r.request = (await A.text()).slice(0, 160);
await A.ev(`document.querySelector('.round.yes').click()`);
await A.until(`document.querySelector('.overlay h1')`);
await B.tab('plans');
await B.until(`document.getElementById('view').innerText.includes('${TITLE}')`, 25000);
r.strangerPlans = (await B.text()).slice(0, 160);
console.log(JSON.stringify(r, null, 2));
assert.equal(r.form, false, 'a new post can be public');
assert.match(r.posted, /Anyone can now swipe on it/);
assert.match(r.hostRow, /Public · 0\/3 matched/);
assert.equal(r.editLock[0], true, 'a public post stays public');
assert.match(r.strangerCard, new RegExp(TITLE));
assert.match(r.asked, /^Asked to join/);
assert.match(r.request, /Someone you don't know yet/);
assert.match(r.strangerPlans, new RegExp(`${TITLE}[\\s\\S]*Hosted by`));
A.close(); B.close();
finish('browser public');
