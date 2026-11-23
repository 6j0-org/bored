// The Post tab's "Your posts": newest first by default, with a Sort by menu (remembered per browser) that reorders the
// cards without touching a post half-written in the form.
import assert from 'node:assert/strict';
import { browser, finish, wait } from '../lib.mjs';

const B = await browser('post-sort');
await B.tab('post');
await B.until(`document.querySelector('#newEvent input[name=title]')`);
await B.ev(`window.confirm = () => true; window.alert = (m) => console.log('alert', m)`);
const titles = () => B.ev(`[...document.querySelectorAll('#yourPosts .post-card')].map(c => c.querySelector('h2')?.textContent.trim())
  .filter(t => ['Banana bread swap', 'Apple picking', 'Cherry pie night'].includes(t))`);

// Three public posts, made in this order, the first one happening latest.
const day = (n) => { const d = new Date(Date.now() + n * 86400000); d.setHours(18, 0, 0, 0); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
for (const [title, when] of [['Banana bread swap', day(9)], ['Apple picking', day(3)], ['Cherry pie night', day(6)]]) {
  await B.ev(`(() => { const f = document.getElementById('newEvent');
    f.querySelector('input[name=visibility][value=public]').click();
    f.querySelector('input[name=title]').value = ${JSON.stringify(title)};
    const w = f.querySelector('input[name=when_text]'); w.value = ${JSON.stringify(when)}; w.dispatchEvent(new Event('input', { bubbles: true })); w.dispatchEvent(new Event('change', { bubbles: true }));
    f.requestSubmit(); })()`);
  await B.until(`[...document.querySelectorAll('#yourPosts .post-card')].some(c => c.textContent.includes(${JSON.stringify(title)}))`);
  await B.until(`document.querySelector('#newEvent input[name=title]')?.value === ''`);
  await wait(300);
}

assert.deepEqual(await titles(), ['Cherry pie night', 'Apple picking', 'Banana bread swap'], 'newest first by default');
assert.equal(await B.ev(`document.getElementById('postSort').value`), 'newest');

// A half-written post stays while the cards are reordered.
await B.ev(`document.querySelector('#newEvent input[name=title]').value = 'Half written'`);
const sortBy = (k) => B.ev(`(() => { const s = document.getElementById('postSort'); s.value = '${k}'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await sortBy('oldest');
assert.deepEqual(await titles(), ['Banana bread swap', 'Apple picking', 'Cherry pie night'], 'oldest first');
await sortBy('soonest');
assert.deepEqual(await titles(), ['Apple picking', 'Cherry pie night', 'Banana bread swap'], 'happening soonest');
await sortBy('title');
assert.deepEqual(await titles(), ['Apple picking', 'Banana bread swap', 'Cherry pie night'], 'by title');
assert.equal(await B.ev(`document.querySelector('#newEvent input[name=title]').value`), 'Half written', 'the form is untouched');

// Remembered after a reload.
await B.reload();
await B.tab('post');
await B.until(`document.getElementById('postSort')`);
assert.equal(await B.ev(`document.getElementById('postSort').value`), 'title');
assert.deepEqual(await titles(), ['Apple picking', 'Banana bread swap', 'Cherry pie night']);

B.close();
finish('post sort');
