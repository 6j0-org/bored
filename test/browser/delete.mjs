// Deleting cards, which is only for the discard pile, past plans, and your own posts: a past plan's Delete hides it
// (for good: after a reload too), and plans that are still on, or waitlisted, have no Delete. And a host cancelling
// a plan from its chat, which moves it to Past as cancelled.
import assert from 'node:assert/strict';
import { browser, finish, wait } from '../lib.mjs';

const B = await browser('delete');
await B.tab('plans');
await B.until(`[...document.querySelectorAll('.section-title')].some(h => h.textContent === 'Past')`, 30000);
const past = () => B.ev(`(() => { const h = [...document.querySelectorAll('.section-title')].find(h => h.textContent === 'Past');
  return h ? [...h.nextElementSibling.querySelectorAll('.plan-card')].map(c => c.querySelector('h2').textContent) : []; })()`);
const before = await past();
assert.ok(before.length >= 1, 'the demo has past plans');
assert.equal(await B.ev(`document.querySelectorAll('.plan-card [data-delete-plan]').length`), before.length, 'only past plans have Delete');

await B.ev(`window.confirm = () => true; document.querySelector('.plan-card [data-delete-plan]').click()`);
await B.until(`document.getElementById('toast').textContent === 'Deleted'`);
await wait(500);
assert.deepEqual(await past(), before.slice(1), 'the first past plan is gone');
await B.reload(); await B.tab('plans'); await wait(1000);
assert.deepEqual(await past(), before.slice(1), 'and stays gone after a reload');

// The demo visitor hosts pickup basketball, with Sam in: cancel it from the chat.
await B.ev(`[...document.querySelectorAll('.plan-card[data-id]')].find(c => c.querySelector('h2').textContent === 'Pickup basketball').querySelector('h2').click()`);
await B.until(`document.getElementById('cancelPlan')`);
await B.ev(`window.confirm = (q) => { window.asked = q; return true; }; document.getElementById('cancelPlan').click()`);
await B.until(`document.getElementById('toast').textContent.startsWith('Cancelled')`);
assert.match(await B.ev(`window.asked`), /^Cancel “Pickup basketball”\? Sam will be told/);
await B.tab('plans'); await wait(1000);
const card = `[...document.querySelectorAll('.plan-card')].find(c => c.querySelector('h2').textContent === 'Pickup basketball')`;
assert.equal(await B.ev(`${card}.querySelector('.label').textContent`), 'Cancelled');
assert.ok((await past()).includes('Pickup basketball'), 'it moved to Past');

B.close();
finish('browser delete');
