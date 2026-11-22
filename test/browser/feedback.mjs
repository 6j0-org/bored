// Headless Chromium against the demo: the "Alpha" note under the board on every tab and its feedback link, the
// About page's Feedback button, posting (with the character count and the 2048-character limit), a draft surviving
// a trip to another tab, a post's chat (replying), deleting your own, and the account ID on the Profile page.
import assert from 'node:assert/strict';
import { browser, finish, wait, BASE } from '../lib.mjs';

const B = await browser('feedback');
const items = () => B.ev(`[...document.querySelectorAll('.fb-item .fb-text')].map(e => e.textContent)`);

// The Alpha note is on every tab, and its link opens the page.
for (const t of ['discover', 'confirm', 'plans', 'post', 'profile']) {
  await B.tab(t);
  assert.match(await B.ev(`document.querySelector('header.top .alpha-note')?.textContent || ''`), /Alpha.*Share what you think/s, `Alpha note on ${t}`);
}
await B.ev(`document.getElementById('feedbackLink').click()`);
await B.until(`document.querySelector('.fb-empty')?.textContent.includes('No feedback yet')`);
assert.equal(await B.ev(`document.querySelector('.page-title').textContent`), 'Feedback');
assert.equal(await B.ev(`document.getElementById('feedbackLink').getAttribute('aria-current')`), 'page');
assert.equal(await B.ev(`!document.querySelector('nav.tabs [aria-current]')`), true, 'no tab is marked as open');
assert.match(await B.ev(`document.querySelector('.fb-intro').textContent`), /only you and the developers can see/);
assert.equal(await B.ev(`document.getElementById('fbBody').maxLength`), 2048);

// The About page has the note and the Feedback button, which opens the same page in the app.
await B.send('Page.navigate', { url: BASE + '/about' }); await wait(1500);
assert.match(await B.ev(`document.querySelector('.bar .alpha-note').textContent`), /Alpha.*Feedback/s);
await B.ev(`document.querySelector('.bar .alpha-note a.btn').click()`);
await B.until(`document.querySelector('.page-title')?.textContent === 'Feedback'`);
assert.equal(await B.ev(`location.search`), '', 'the open=feedback is taken out of the address');

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

// An item opens as a chat, where its author can reply; the list then shows the reply count.
await B.ev(`document.querySelectorAll('.fb-item')[1].click()`);
await B.until(`document.querySelector('.fb-thread:not([hidden]) .fb-msg')`);
assert.equal(await B.ev(`document.querySelector('.fb-thread .fb-state').textContent`), 'Open');
assert.equal(await B.ev(`document.querySelectorAll('[data-set-status]').length`), 0, 'only developers can close it');
assert.equal(await B.ev(`!!document.querySelector('.fb-msg .fb-avatar .avatar.icon svg')`), true, 'with the profile icon');
assert.equal(await B.ev(`document.querySelector('.fb-msg .fb-name').textContent`), 'You');
assert.equal(await B.ev(`document.querySelector('.fb-msg .fb-author').textContent`), 'Tester');
await B.ev(`document.getElementById('fbReply').focus()`);
await B.send('Input.insertText', { text: 'Especially the date filter.' });
await B.ev(`document.querySelector('.fb-reply-send').click()`);
await B.until(`document.querySelectorAll('.fb-msg').length === 2`);
assert.equal(await B.ev(`document.querySelectorAll('.fb-msg')[1].textContent.includes('Especially the date filter.')`), true);
await B.ev(`document.querySelector('.fb-back').click()`);
await B.until(`document.querySelector('.fb-item .fb-replies')`);
assert.equal(await B.ev(`document.querySelector('.fb-item .fb-replies').textContent`), '1 reply');
assert.ok((await items())[0].startsWith('Could Discover'), 'the most recently active comes first');

// Delete takes two clicks.
await B.ev(`document.querySelector('.fb-item .fb-delete').click()`);
assert.equal(await B.ev(`document.querySelector('.fb-item .fb-delete').textContent`), 'Confirm delete');
await B.ev(`document.querySelector('.fb-item .fb-delete').click()`);
await B.until(`document.querySelectorAll('.fb-item').length === 1`);
await wait(200);

// The Profile page ends with the account's ID (the GUID developers are listed by).
await B.tab('profile');
await B.until(`document.querySelector('.account-id code')`);
assert.match(await B.ev(`document.querySelector('.account-id code').textContent`), /^[0-9a-f-]{20,}$/i);

B.close();
finish('browser feedback');
