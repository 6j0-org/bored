// Headless Chromium against the demo: Profile → Moderation (defaults, a word list that stars words out and then hides
// posts), Report or block on a Discover card, and the Blocked list.
import assert from 'node:assert/strict';
import { browser, finish, wait } from '../lib.mjs';

const B = await browser('moderation');
const topTitle = () => B.ev(`document.querySelector('.card.top h2')?.textContent || ''`);
const toast = () => B.ev(`document.getElementById('toast').textContent`);

// Defaults: the built-in list and every report reason on, at 3 reports.
await B.tab('profile');
await B.until(`document.getElementById('moderation')`);
assert.equal(await B.ev(`document.querySelector('#modForm [name=builtinOn]').checked`), true);
assert.equal(await B.ev(`document.querySelector('#modForm [name=builtinHide]').checked`), false);
assert.deepEqual(JSON.parse(await B.ev(`JSON.stringify([...document.querySelectorAll('#modForm [name^=rep-]')].map(i => i.checked))`)), [true, true, true, true, true]);
assert.deepEqual(JSON.parse(await B.ev(`JSON.stringify([...document.querySelectorAll('#modForm [name^=count-]')].map(i => i.value))`)), ['3', '3', '3', '3', '3']);
assert.match(await B.ev(`document.querySelector('#modForm [name=builtinOn]').closest('label').textContent`), /\d{3} slurs/, 'the built-in list loaded');

// The first word of the post on top of the deck goes on a new list.
await B.tab('discover');
await B.until(`document.querySelector('.card.top h2')`);
const title = await topTitle();
const word = title.match(/[A-Za-z]{3,}/)[0];
await B.tab('profile');
await B.ev(`document.getElementById('addList').click()`);
await B.until(`document.querySelector('#modForm [data-list] textarea')`);
await B.ev(`(() => { const t = document.querySelector('#modForm [data-list] textarea'); t.value = ${JSON.stringify(word)}; t.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await B.until(`document.getElementById('toast').textContent === 'Saved'`);

// Discover stars it out on the card.
await B.tab('discover');
await B.until(`document.querySelector('.card.top h2')`);
const starred = await B.ev(`[...document.querySelectorAll('.card h2')].map(h => h.textContent).find(t => t.includes(${JSON.stringify('*'.repeat(word.length))})) || ''`);
assert.ok(starred, `"${word}" is starred out in "${title}"`);

// Turning on "hide whole posts" takes the post out of the deck, and says how many are hidden.
await B.tab('profile');
await B.ev(`(() => { const c = document.querySelector('#modForm [data-list] [name=hide]'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await B.until(`document.getElementById('toast').textContent === 'Saved'`);
await B.tab('discover');
await B.until(`!document.getElementById('modNote').hidden`);
assert.match(await B.ev(`document.getElementById('modNote').textContent`), /hidden by your moderation settings/);
assert.ok(!(await B.ev(`[...document.querySelectorAll('.card h2')].map(h => h.textContent).join('|')`)).includes(title), 'the post is gone from the deck');
// "Change them" goes to the settings.
await B.ev(`document.querySelector('[data-mod-settings]').click()`); await wait(1200);
assert.equal(await B.ev(`document.querySelector('.page-title').textContent`), 'Profile');
// Delete the list again.
await B.ev(`window.confirm = () => true; document.querySelector('[data-del-list]').click()`); await wait(1200);
assert.equal(await B.ev(`document.querySelectorAll('#modForm [data-list]').length`), 0);

// Report the top card for spam: it goes to the discard pile, still there (one report is under the threshold).
await B.tab('discover');
await B.until(`document.querySelector('.card.top [data-report]')`);
const reported = await topTitle();
await B.ev(`document.querySelector('.card.top [data-report]').click()`);
await B.until(`document.getElementById('reportForm')`);
assert.equal(await B.ev(`document.querySelectorAll('#reportForm [name=reason]').length`), 5, 'a public post can be reported');
await B.ev(`document.querySelector('#reportForm [name=reason][value=spam]').click(); document.getElementById('reportForm').requestSubmit()`);
await B.until(`document.getElementById('toast').textContent === 'Reported'`);
await B.until(`(document.querySelector('.card.top h2')?.textContent || '') !== ${JSON.stringify(reported)}`);
// Opening it again from the discard pile shows the report.
await B.until(`[...document.querySelectorAll('.pile-card [data-report]')].length`);
await B.ev(`[...document.querySelectorAll('.pile-card')].find(c => c.querySelector('h2').textContent === ${JSON.stringify(reported)}).querySelector('[data-report]').click()`);
await B.until(`document.getElementById('reportForm')`);
assert.equal(await B.ev(`document.querySelector('#reportForm [name=reason][value=spam]').checked`), true);
await B.ev(`document.getElementById('cancelSheet').click()`);

// With the spam threshold at 1, my own report is enough: the post leaves the discard pile too. Back to 3 after.
const setSpam = async (n) => {
  await B.tab('profile');
  await B.ev(`(() => { const i = document.querySelector('#modForm [name=count-spam]'); i.value = '${n}'; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await B.until(`document.getElementById('toast').textContent === 'Saved'`);
  await B.tab('discover');
};
const inPile = () => B.ev(`[...document.querySelectorAll('.pile-card h2')].some(h => h.textContent === ${JSON.stringify(reported)})`);
await setSpam(1);
await B.until(`!document.getElementById('modNote').hidden`);
assert.equal(await inPile(), false, 'hidden from the discard pile');
await setSpam(3);
await B.until(`[...document.querySelectorAll('.pile-card h2')].some(h => h.textContent === ${JSON.stringify(reported)})`);

// Block the next card's host: their posts leave the deck, and they're on the Blocked list until unblocked.
await B.until(`document.querySelector('.card.top [data-report]')`);
const blockedTitle = await topTitle();
await B.ev(`document.querySelector('.card.top [data-report]').click()`);
await B.until(`document.getElementById('reportForm')`);
await B.ev(`document.querySelector('#reportForm [name=block]').click(); document.getElementById('reportForm').requestSubmit()`);
await B.until(`document.getElementById('toast').textContent === 'Blocked'`);
await B.until(`(document.querySelector('.card.top h2')?.textContent || '') !== ${JSON.stringify(blockedTitle)}`);
await B.tab('profile');
assert.equal(await B.ev(`document.querySelectorAll('[data-unblock]').length`), 1);
await B.ev(`document.querySelector('[data-unblock]').click()`);
await B.until(`document.getElementById('toast').textContent === 'Unblocked'`);
await wait(1200);
assert.equal(await B.ev(`document.querySelectorAll('[data-unblock]').length`), 0);
assert.match(await toast(), /Unblocked/);

B.close();
finish('browser moderation');
