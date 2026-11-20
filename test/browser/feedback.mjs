// Headless Chromium against the demo: the Feedback button beside the page title on every tab, posting (with the
// character count and the 2048-character limit), a draft surviving a trip to another tab, and deleting your own.
import assert from 'node:assert/strict';
import { browser, finish, wait } from '../lib.mjs';

const B = await browser('feedback');
const items = () => B.ev(`[...document.querySelectorAll('.fb-item .fb-text')].map(e => e.textContent)`);

// The button is on every tab, and opens the page.
for (const t of ['discover', 'confirm', 'plans', 'post', 'profile']) {
  await B.tab(t);
  assert.ok(await B.ev(`Boolean(document.getElementById('feedbackLink'))`), `Feedback button on ${t}`);
}
await B.ev(`document.getElementById('feedbackLink').click()`);
await B.until(`document.querySelector('.fb-empty')?.textContent.includes('No feedback yet')`);
assert.equal(await B.ev(`document.querySelector('.page-title').textContent`), 'Feedback');
assert.equal(await B.ev(`document.getElementById('feedbackLink').getAttribute('aria-current')`), 'page');
assert.equal(await B.ev(`!document.querySelector('nav.tabs [aria-current]')`), true, 'no tab is marked as open');
assert.match(await B.ev(`document.querySelector('.fb-intro').textContent`), /only you can see/);
assert.equal(await B.ev(`document.getElementById('fbBody').maxLength`), 2048);

// A draft survives going to another tab and back.
await B.ev(`document.getElementById('fbBody').focus()`);
await B.send('Input.insertText', { text: 'Could Discover remember my last filter?\nI keep re-picking it.' });
assert.equal(await B.ev(`document.querySelector('.fb-count').textContent`), '61 / 2048');
await B.tab('plans');
await B.ev(`document.getElementById('feedbackLink').click()`);
await B.until(`document.getElementById('fbBody')`);
assert.equal(await B.ev(`document.getElementById('fbBody').value.length`), 61, 'the draft is still there');

// Post it.
await B.ev(`document.querySelector('.fb-send').click()`);
await B.until(`document.querySelectorAll('.fb-item').length === 1`);
assert.deepEqual(await items(), ['Could Discover remember my last filter?\nI keep re-picking it.']);
assert.equal(await B.ev(`document.getElementById('fbBody').value`), '');

// HTML shows as text; the box stops at 2048 characters.
await B.ev(`document.getElementById('fbBody').focus()`);
await B.send('Input.insertText', { text: '<b>bold?</b> ' + 'x'.repeat(2100) });
assert.equal(await B.ev(`document.getElementById('fbBody').value.length`), 2048);
await B.ev(`document.querySelector('.fb-send').click()`);
await B.until(`document.querySelectorAll('.fb-item').length === 2`);
assert.ok((await items())[0].startsWith('<b>bold?</b>'));
assert.equal(await B.ev(`document.querySelectorAll('.fb-text b').length`), 0);

// Delete takes two clicks.
await B.ev(`document.querySelector('.fb-item .fb-delete').click()`);
assert.equal(await B.ev(`document.querySelector('.fb-item .fb-delete').textContent`), 'Confirm delete');
await B.ev(`document.querySelector('.fb-item .fb-delete').click()`);
await B.until(`document.querySelectorAll('.fb-item').length === 1`);
await wait(200);

B.close();
finish('browser feedback');
