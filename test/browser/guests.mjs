// Guests: a host allows guests and adds one of their own (someone not on Bored); someone asks to join bringing two
// (one named); the host sees who's coming in Confirm, says yes, and the post is full; then the attendee changes who
// they're bringing from Plans, and the host's Plans shows it.
import assert from 'node:assert/strict';
import { browser, finish, wait, BASE } from '../lib.mjs';

const A = await browser('guests-host'), B = await browser('guests-attendee');
const TITLE = `Guest dinner ${Date.now() % 100000}`;
const cardOf = (title) => `[...document.querySelectorAll('#view .post-card')].find(x => x.innerText.includes(${JSON.stringify(title)}))`;

// The host posts publicly: 4 people at most, up to 2 guests each.
await A.tab('post');
await A.ev(`(() => { const f = document.getElementById('newEvent'); f.title.value = '${TITLE}'; f.max_attendees.value = '4'; f.max_guests.value = '2';
  f.querySelector('input[name=visibility][value=public]').click(); })()`);
await A.ev(`window.confirm = () => true; document.getElementById('newEvent').requestSubmit()`);
await A.until(`${cardOf(TITLE)}`);

// They add someone who isn't on Bored.
await A.ev(`${cardOf(TITLE)}.querySelector('[data-host-guests]').click()`);
await A.until(`document.querySelector('.sheet [data-host-guests]')`);
await A.ev(`(() => { const s = document.querySelector('.sheet'); s.querySelector('input[name=name]').value = 'Aunt May'; s.querySelector('[data-add]').click();
  s.querySelector('form').requestSubmit(); })()`);
await A.until(`${cardOf(TITLE)}?.innerText.includes('1 you added')`);
assert.match(await A.ev(`${cardOf(TITLE)}.innerText`), /1\/4 matched/, 'their guest takes a spot');

// Someone else opens the post's link and asks to join, bringing two: one named, one not.
await A.ev(`navigator.clipboard.writeText = async (t) => { window.copied = t; }; ${cardOf(TITLE)}.querySelector('[data-share-post]').click()`);
await A.until(`window.copied`);
const link = await A.ev(`window.copied`);
await B.send('Page.navigate', { url: link });
await B.until(`document.querySelector('.card.top h2')?.textContent === '${TITLE}'`);
assert.match(await B.ev(`document.querySelector('.card.top').innerText`), /Up to 2 each/, 'the card says guests are allowed');
await B.ev(`document.querySelector('.round.yes').click()`);
await B.until(`document.querySelector('.card.top.flipped .guests-pick')`); await wait(700);
await B.ev(`(() => { const p = document.querySelector('.card.top .guests-pick'); p.querySelector('[data-guests-more]').click(); p.querySelector('[data-guests-more]').click(); p.querySelector('[data-guests-more]').click(); })()`);
assert.equal(await B.ev(`document.querySelectorAll('.card.top .guest-name').length`), 2, 'no more than max_guests');
await B.ev(`document.querySelector('.card.top .guest-name').value = 'Sam'; document.querySelector('.round.yes').click()`);
await wait(2500);

// The host sees who they're bringing, and says yes: 1 + 3 = 4, so they're in and the post is full.
await A.tab('discover'); await A.tab('confirm');
for (let i = 0; i < 10; i++) {
  if (await A.ev(`document.querySelector('.card.top')?.innerText.includes('${TITLE}')`)) break;
  await A.ev(`document.querySelector('.round.no')?.click()`); await wait(1500);
}
await A.until(`document.querySelector('.card.top')?.innerText.includes('${TITLE}')`);
assert.match(await A.ev(`document.querySelector('.card.top').innerText`), /Bringing Sam and 1 unnamed guest/);
await A.ev(`document.querySelector('.round.yes').click()`);
await A.until(`document.querySelector('.overlay h1')`);
await A.ev(`document.getElementById('mKeep').click()`);
await A.tab('post');
await A.until(`${cardOf(TITLE)}?.innerText.includes('4/4 matched')`);

// The attendee changes who they're bringing, from Plans.
await B.tab('plans');
const planOf = `[...document.querySelectorAll('.plan-card')].find(c => c.innerText.includes('${TITLE}'))`;
await B.until(`${planOf}?.querySelector('[data-guests-ch]')`, 25000);
assert.match(await B.ev(`${planOf}.innerText`), /You're bringing Sam and 1 unnamed guest/);
await B.ev(`${planOf}.querySelector('[data-guests-ch]').click()`);
await B.until(`document.querySelector('.sheet .guests-pick')`);
await B.ev(`(() => { const s = document.querySelector('.sheet'); s.querySelector('[data-guests-less]').click(); s.querySelector('form').requestSubmit(); })()`);
await B.until(`document.getElementById('toast').textContent.includes('Guests updated')`);

// The host's Plans shows the change, and a spot opened up.
await A.tab('plans');
await A.until(`${planOf}?.innerText.includes("They're bringing Sam") && !${planOf}?.innerText.includes('unnamed')`, 25000);
await A.tab('post');
await A.until(`${cardOf(TITLE)}?.innerText.includes('3/4 matched')`);

A.close(); B.close();
finish('guests');
