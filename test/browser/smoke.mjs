// Headless Chromium over the DevTools protocol: open the demo app, walk every tab, post a private post, and
// report any page errors.
import assert from 'node:assert/strict';
import { browser, finish, wait } from '../lib.mjs';
const B = await browser('me');
const evaluate = B.ev, tab = async (id) => { await B.tab(id); await wait(300); };
const out = {};
for (const t of ['discover', 'confirm', 'plans', 'post', 'profile']) { await tab(t); out[t] = (await evaluate(`document.getElementById('view').innerText.slice(0, 120).replace(/\\s+/g, ' ')`)); }

// Post a private post to Maya (a demo account: it has no encryption keys, so it can't be reached yet).
await tab('post');
await evaluate(`(() => {
  const f = document.getElementById('newEvent');
  f.title.value = 'Browser test walk'; f.details.value = 'Easy loop';
  f.querySelector('input[name=visibility][value=private]').click();
  [...f.querySelectorAll('.audience [data-contact]')][0].click();
  f.requestSubmit();
})()`);
await wait(3000);
out.toast = await evaluate(`document.getElementById('toast').textContent`);
out.listed = await evaluate(`[...document.querySelectorAll('#view .post-card h2')].map(e => e.textContent).includes('Browser test walk')`);
// Edit it: the public option is locked.
await evaluate(`[...document.querySelectorAll('[data-edit]')].find(b => b.dataset.edit.startsWith('m:')).click()`);
await wait(500);
out.publicLocked = await evaluate(`document.querySelector('#sheetForm input[name=visibility][value=public]').disabled`);
await evaluate(`document.querySelector('#sheetForm input[name=title]').value = 'Browser test walk 2'; document.querySelector('#sheetForm').requestSubmit()`);
await wait(3000);
out.edited = await evaluate(`[...document.querySelectorAll('#view .post-card h2')].map(e => e.textContent).includes('Browser test walk 2')`);
// Reload: the post is still there (from the vault).
await B.reload();
await tab('post');
out.afterReload = await evaluate(`[...document.querySelectorAll('#view .post-card h2')].map(e => e.textContent).includes('Browser test walk 2')`);
console.log(JSON.stringify(out, null, 2));
assert.match(out.discover, /I'M IN/, 'Discover shows a card');
assert.match(out.confirm, /Wants to join: Sunrise hike/, 'Confirm shows the seeded request');
assert.match(out.plans, /Pickup basketball/, 'Plans shows the seeded match');
assert.match(out.profile, /2 events attended/, 'Profile stats come from mail');
assert.match(out.toast, /^Posted!/);
assert.ok(out.listed, 'the new post is listed');
assert.ok(out.publicLocked, "a private post can't be made public by editing");
assert.ok(out.edited, 'the edit is saved');
assert.ok(out.afterReload, 'the post is still there after a reload');
B.close();
finish('browser smoke');
