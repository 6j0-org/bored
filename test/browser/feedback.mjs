// Headless Chromium against the demo: the "Alpha" note under the board on every tab and its feedback link, the
// About page's Feedback button, posting (with the character count and the 2048-character limit), a draft surviving
// a trip to another tab, a post's chat (replying), deleting your own, and on the Profile page, the account ID and the
// order of its sections.
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
assert.match(await B.ev(`document.querySelector('.bar .alpha-note').textContent`), /Alpha.*Share what you think/s, 'the same note as in the app');
await B.ev(`document.querySelector('.bar .alpha-note a').click()`);
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

// Editing my reply: Edit turns it into a text box; Save shows the new text, marked as edited.
await B.ev(`document.querySelectorAll('.fb-msg')[1].querySelector('.fb-edit').click()`);
await B.until(`document.getElementById('fbEditBox')`);
assert.equal(await B.ev(`document.getElementById('fbEditBox').value`), 'Especially the date filter.');
await B.ev(`document.getElementById('fbEditBox').value = 'Especially the distance filter.'; document.querySelector('.fb-edit-form').requestSubmit()`);
await B.until(`document.querySelectorAll('.fb-msg')[1]?.querySelector('.fb-text')?.textContent === 'Especially the distance filter.'`);
assert.equal(await B.ev(`document.querySelectorAll('.fb-msg')[1].querySelector('.fb-edited').textContent`), 'edited');
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

// A tapped feedback notification (?open=feedback:<id>) opens that post's chat.
const threadId = await B.ev(`fetch('/api/feedback').then(r => r.json()).then(d => d.items[0].id)`);
await B.send('Page.navigate', { url: `${BASE}/?open=feedback:${threadId}` });
await B.until(`document.querySelector('.fb-thread:not([hidden]) .fb-msg')?.textContent.includes('<b>bold?</b>')`);

// It can be deleted from its chat too (two clicks), which goes back to the list.
await B.ev(`document.querySelector('[data-delete-thread]').click()`);
assert.equal(await B.ev(`document.querySelector('[data-delete-thread]').textContent`), 'Confirm delete');
await B.ev(`document.querySelector('[data-delete-thread]').click()`);
await B.until(`document.querySelector('.fb-thread[hidden]') && document.querySelector('.fb-empty')`);
assert.equal(await B.ev(`fetch('/api/feedback').then(r => r.json()).then(d => d.items.length)`), 0);

// The Profile page ends with the account's ID (the GUID developers are listed by).
await B.tab('profile');
await B.until(`document.querySelector('.account-id code')`);
assert.match(await B.ev(`document.querySelector('.account-id code').textContent`), /^[0-9a-f-]{20,}$/i);

// Profile's sections come in this order, with light or dark right after the look, under Settings.
const order = ['Notifications', 'Invitations', 'Contacts', 'Settings', 'Moderation'];
assert.deepEqual(await B.ev(`[...document.querySelectorAll('#view .section-title')].map(h => h.textContent).filter(t => ${JSON.stringify(order)}.includes(t))`), order);
assert.equal(await B.ev(`document.getElementById('themePick').previousElementSibling.id`), 'boardPick');
// Buttons on a line of their own are centered, and a warning has room before the form or button after it.
const centered = (sel) => B.ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)}), p = b.parentElement.getBoundingClientRect(), r = b.getBoundingClientRect();
  return Math.abs((r.left - p.left) - (p.right - r.right)) <= 2 && r.width < p.width - 20; })()`);
assert.equal(await centered('#newInvite'), true, '"Create an invitation" is centered');
assert.equal(await centered('#logout'), true, '"Start over" is centered');
assert.ok(await B.ev(`(() => { const f = document.getElementById('deleteAccount'); return f.getBoundingClientRect().top - f.previousElementSibling.getBoundingClientRect().bottom; })()`) >= 8,
  "Delete account's warning doesn't touch the form under it");

B.close();
finish('browser feedback');
