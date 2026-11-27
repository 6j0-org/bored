// Every tab's search box, on a demo account's own content: it ignores case, accents, and a leading #, matches every
// word typed, says when nothing matches, and is kept per tab. Discover's swiped cards don't come back on a new search.
import assert from 'node:assert/strict';
import { browser, finish, wait } from '../lib.mjs';

const A = await browser('search');
const search = async (q) => {
  await A.ev(`(() => { const f = document.querySelector('#view .tab-search'); f.querySelector('input').value = ${JSON.stringify(q)}; f.requestSubmit(); })()`);
  await wait(300);
};
// The titles of the cards that match selector and aren't hidden.
const shown = (selector) => A.ev(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(selector)})]
  .filter(c => !c.closest('[hidden]')).map(c => c.querySelector('h2').textContent.trim()))`).then(JSON.parse);
const visible = (selector) => A.ev(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return Boolean(e && e.getClientRects().length); })()`);

// Discover: the demo hosts' example posts. Title, details, case, and every word.
await A.tab('discover');
await A.until(`document.querySelector('.card.top h2')`, 30000);
await search('COUCH');
assert.equal(await A.ev(`document.querySelector('.card.top h2').textContent`), 'Help me move a couch up two flights');
await search('pizza beer');
assert.equal(await A.ev(`document.querySelector('.card.top h2').textContent`), 'Help me move a couch up two flights', 'the details, every word');
await search('pizza ramen');
assert.equal(await A.ev(`document.querySelector('.empty h3')?.textContent`), 'No matches', 'every word has to match');
assert.match(await A.ev(`document.querySelector('.empty').innerText`), /“pizza ramen”/);
// A card swiped while searching stays gone after the search changes.
await search('couch');
await A.ev(`document.querySelector('.round.no').click()`); await wait(1500);
await search('heavy');
assert.equal(await A.ev(`document.querySelector('.empty h3')?.textContent`), 'No matches', 'a passed card stays passed');
await search('');
assert.ok(await A.ev(`document.querySelector('.card.top h2')?.textContent`), 'clearing the search shows the deck again');
await search('ramen');

// Post: the visitor's own two posts. The form above them isn't searched.
await A.tab('post');
await A.until(`document.querySelectorAll('#yourPosts .post-card').length >= 2`, 30000);
assert.equal(await A.ev(`document.querySelector('#view .tab-search input').value`), '', 'each tab has its own search');
await A.ev(`document.querySelector('#newEvent input[name=title]').value = 'Half written'`);
await search('BASKETBALL');
assert.deepEqual(await shown('#yourPosts .post-card'), ['Pickup basketball']);
await search('#hiking');
assert.deepEqual(await shown('#yourPosts .post-card'), ['Sunrise hike up Cowles Mountain'], 'a tag, with its #');
await search('trailhéad headlamp');
assert.deepEqual(await shown('#yourPosts .post-card'), ['Sunrise hike up Cowles Mountain'], 'accents are ignored');
await search('kayaking');
assert.deepEqual(await shown('#yourPosts .post-card'), []);
assert.equal(await A.ev(`document.querySelector('#view [data-search-none]:not([hidden])')?.textContent`), 'Nothing here matches “kayaking”.');
assert.equal(await A.ev(`document.querySelector('#newEvent input[name=title]').value`), 'Half written', 'the form is untouched');
await search('');
assert.equal((await shown('#yourPosts .post-card')).length, 2);

// Confirm: Maya and Dev asked to join the hike. The search matches what's on the cards, like the note.
await A.tab('confirm');
await A.until(`document.querySelector('.card.top')`, 30000);
await search('spare headlamp');
assert.match(await A.ev(`document.querySelector('.card.top').innerText`), /spare headlamp/);
await search('kayaking');
assert.equal(await A.ev(`document.querySelector('.empty h3')?.textContent`), 'No matches');
await search('');
assert.ok(await A.ev(`document.querySelector('.card.top')`), 'clearing the search brings the cards back');

// Plans: a section with nothing matching is hidden.
await A.tab('plans');
await A.until(`[...document.querySelectorAll('.plan-card')].some(c => c.innerText.includes('Pickup basketball'))`, 30000);
await search('basketball');
assert.deepEqual(await shown('.plan-card'), ['Pickup basketball']);
assert.equal(await visible('[data-search-group]:not([hidden]) .section-title'), true);
assert.equal(await A.ev(`[...document.querySelectorAll('[data-search-group]')].filter(g => !g.hidden).length`), 1, 'only its section shows');

// Profile: contacts by name; the rest of the tab is hidden while searching.
await A.tab('profile');
await A.until(`document.querySelector('[data-contact]')`, 30000);
await search('maya');
assert.deepEqual(await A.ev(`JSON.stringify([...document.querySelectorAll('[data-contact]')].filter(c => !c.hidden).map(c => c.querySelector('.title').textContent))`).then(JSON.parse), ['Maya']);
assert.equal(await visible('#prefsForm'), false, 'settings are hidden while searching');
await search('');
assert.equal(await visible('#prefsForm'), true);

// Each tab kept its own search.
await A.tab('discover');
assert.equal(await A.ev(`document.querySelector('#view .tab-search input').value`), 'ramen');
await A.until(`document.querySelector('.card.top h2')?.textContent === 'Get some ramen at Chef Jun' || document.querySelector('.empty')`);

finish('search');
