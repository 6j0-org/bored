// Two headless Chromium profiles (two demo accounts) through the whole flow in the real UI.
import assert from 'node:assert/strict';
import { browser, finish, wait, BASE } from '../lib.mjs';
const A = await browser('host'), B = await browser('guest');
const guidOf = (x) => x.ev(`import('/secure.js').then(s => s.myPublicKeys().guid)`);
const ga = await guidOf(A), gb = await guidOf(B);
// Become contacts (as an accepted invitation would make them).
await A.ev(`import('/secure.js').then(s => s.vault.update((p, o) => fetch(p, { method: o?.method || 'GET', headers: { 'Content-Type': 'application/json' }, body: o?.body ? JSON.stringify(o.body) : undefined }).then(async r => { const d = await r.json(); if (!r.ok) throw Object.assign(new Error(d.error), { status: r.status }); return d; }), d => { d.contacts['${gb}'] = { nickname: 'Guesty', tags: [], added: '' }; }))`);
await B.ev(`import('/secure.js').then(s => s.vault.update((p, o) => fetch(p, { method: o?.method || 'GET', headers: { 'Content-Type': 'application/json' }, body: o?.body ? JSON.stringify(o.body) : undefined }).then(async r => { const d = await r.json(); if (!r.ok) throw Object.assign(new Error(d.error), { status: r.status }); return d; }), d => { d.contacts['${ga}'] = { nickname: 'Hosty', tags: [], added: '' }; }))`);

// Host posts privately to the guest.
await A.tab('post');
await A.ev(`(() => { const f = document.getElementById('newEvent'); f.title.value = 'Two-browser picnic'; f.max_attendees.value = '1';
  f.querySelector('input[name=visibility][value=private]').click();
  [...f.querySelectorAll('.audience [data-contact]')].find(b => b.textContent.includes('Guesty')).click(); f.requestSubmit(); })()`);
await wait(3000);
const r = { posted: await A.ev(`document.getElementById('toast').textContent`) };

// Guest finds it first in Discover, hosted by "Hosty", and swipes yes.
await B.tab('confirm'); await B.tab('discover');
await B.until(`document.querySelector('.card.top h2')?.textContent === 'Two-browser picnic'`).catch(async e => { console.log(JSON.stringify(r), await B.ev(`[...document.querySelectorAll('.card h2')].map(h => h.textContent).slice(0, 5).join(' | ')`), await B.ev(`import('/mail.js').then(m => m.mailView().deck.slice(0,3).map(p => p.title).join(' | '))`)); throw e; });
r.card = await B.ev(`document.querySelector('.card.top .who b').innerText`);
// I'm in opens Ask to join; Cancel puts the card back, and sending it without a rating or note works too.
await B.ev(`document.querySelector('.round.yes').click()`);
await B.until(`document.querySelector('.sheet [data-cancel]')`);
await B.ev(`document.querySelector('.sheet [data-cancel]').click()`); await wait(600);
r.cardBack = await B.ev(`document.querySelector('.card.top h2')?.textContent`);
await B.ev(`document.querySelector('.round.yes').click()`);
await B.until(`document.querySelector('.sheet form')`);
await B.ev(`document.querySelector('.sheet form').requestSubmit()`); await wait(2500);
r.asked = await B.ev(`document.getElementById('toast').textContent`);

// Host: Confirm shows the request, named (the guest is a contact); yes → It's on! → chat.
await A.tab('discover'); await A.tab('confirm');
// The demo account's own seeded requests come first: say no to them until ours is on top.
for (let i = 0; i < 10; i++) {
  if (await A.ev(`document.querySelector('.card.top')?.innerText.includes('Two-browser picnic')`)) break;
  await A.ev(`document.querySelector('.round.no')?.click()`); await wait(1500);
}
await A.until(`document.querySelector('.card.top')?.innerText.includes('Two-browser picnic')`);
r.badge = await A.ev(`document.querySelector('nav.tabs button[data-tab=confirm] .badge')?.textContent`);
r.request = (await A.text()).slice(0, 160);
await A.ev(`document.querySelector('.round.yes').click()`);
await A.until(`document.querySelector('.overlay h1')`);
r.overlay = await A.ev(`document.querySelector('.overlay').innerText.replace(/\\s+/g, ' ')`);
await A.ev(`document.getElementById('mChat').click()`); await wait(2000);
r.hostChat = (await A.text()).slice(0, 160);

// Guest: Plans shows the match, hosted by Hosty; open the chat and say hi.
await B.tab('plans');
await B.until(`document.getElementById('view').innerText.includes('Two-browser picnic')`);
r.guestPlans = (await B.text()).slice(0, 400);
await B.ev(`document.querySelector('.plan-card[data-id^="m:"] h2').click()`); await wait(2000);
await B.ev(`document.getElementById('chatBody').value = 'hi from the guest'; document.getElementById('composer').requestSubmit()`); await wait(2000);

// Host's open chat picks it up within a poll or two, now with the guest's name (from their hello).
await A.until(`document.getElementById('msgs')?.innerText.includes('hi from the guest')`, 20000);
await A.ev(`document.getElementById('chatBody').value = 'hi back'; document.getElementById('composer').requestSubmit()`);
await B.until(`document.getElementById('msgs')?.innerText.includes('hi back')`, 20000);

// The guest edits their message (tap it, change it, save); the host sees the new text, marked as edited.
await B.ev(`document.querySelector('#msgs .msg.mine.editable').click()`);
await B.until(`document.getElementById('msgEditBox')`);
await B.ev(`document.getElementById('msgEditBox').value = 'hi from the guest, edited'; document.querySelector('.msg-edit').requestSubmit()`);
await B.until(`document.querySelector('#msgs .msg.mine')?.innerText.includes('hi from the guest, edited')`, 10000);
await A.until(`[...document.querySelectorAll('#msgs .msg')].some(m => m.innerText.includes('hi from the guest, edited') && m.querySelector('.msg-edited'))`, 20000);
assert.equal(await A.ev(`document.querySelectorAll('#msgs .msg.editable').length`), 1, 'the host can edit only their own message');

// A tapped "New activity" notification (?open=mail) opens the newest thing in the mail: this chat.
await A.send('Page.navigate', { url: BASE + '/?open=mail' });
await A.until(`document.getElementById('msgs')?.innerText.includes('hi back')`, 20000);
await A.ev(`document.querySelector('.back').click()`); await wait(1500);
r.hostPlans = (await A.text()).slice(0, 400);
r.guestChat = await B.ev(`document.getElementById('msgs').innerText.replace(/\\s+/g, ' ')`);
// Guest can't make it: the host's post opens up again.
await B.ev(`window.confirm = () => true; document.getElementById('leave').click()`); await wait(2500);
await A.tab('post');
r.hostPostAfterLeave = (await A.ev(`[...document.querySelectorAll('#view .post-card')].find(x => x.innerText.includes('Two-browser picnic'))?.innerText.replace(/\\s+/g, ' ')`));
console.log(JSON.stringify(r, null, 2));
assert.match(r.posted, /^Posted! 1 person/);
assert.equal(r.card, 'Hosty', 'the card names the host from contacts');
assert.match(r.asked, /^Asked to join/);
assert.equal(r.cardBack, 'Two-browser picnic', 'Cancel puts the card back');
assert.equal(r.badge, '1');
assert.match(r.request, /Guesty One of your contacts/, 'a contact who asks is named');
assert.match(r.overlay, /^It's on! You and Guesty/);
assert.match(r.guestPlans, /Two-browser picnic[\s\S]*Hosted by Hosty/);
assert.match(r.hostPlans, /Two-browser picnic[\s\S]*Guesty is going hi back/);
assert.match(r.guestChat, /hi from the guest, edited edited hi back/);
assert.match(r.hostPostAfterLeave, /^LOOKING .*0\/1 matched/, 'the post opens up again when the guest leaves');
A.close(); B.close();
finish('browser two');
