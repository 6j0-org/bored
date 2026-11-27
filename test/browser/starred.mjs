// My own post shows as I wrote it, with a note naming the words the built-in word list stars out for everyone else.
import assert from 'node:assert/strict';
import { browser, finish, wait } from '../lib.mjs';

const A = await browser('starred');
await A.tab('post');
await A.until(`document.querySelector('#newEvent input[name=title]')`);
await A.ev(`window.confirm = () => true`);
for (const [title, details] of [['Bird shit everywhere', 'Bullshit, honestly. Bring a hose.'], ['Wash the patio', 'Bring a hose.']]) {
  await A.ev(`(() => { const f = document.getElementById('newEvent');
    f.querySelector('input[name=visibility][value=public]').click();
    f.title.value = ${JSON.stringify(title)}; f.details.value = ${JSON.stringify(details)}; f.requestSubmit(); })()`);
  await A.until(`[...document.querySelectorAll('#yourPosts .post-card')].some(c => c.textContent.includes(${JSON.stringify(title)}))`);
  await A.until(`document.querySelector('#newEvent input[name=title]')?.value === ''`);
  await wait(300);
}
const card = (title) => `[...document.querySelectorAll('#yourPosts .post-card')].find(c => c.querySelector('h2').textContent === ${JSON.stringify(title)})`;
assert.equal(await A.ev(`${card('Bird shit everywhere')}.querySelector('h2').textContent`), 'Bird shit everywhere', 'shown as written');
assert.equal(await A.ev(`${card('Bird shit everywhere')}.querySelector('.starred-note')?.textContent.replace(/\\s+/g, ' ')`),
  "People using the built-in word list see “shit” and “bullshit” starred out, and anyone who hides posts with those words won't see this post.");
assert.equal(await A.ev(`${card('Wash the patio')}.querySelector('.starred-note') === null`), true, 'no note without filtered words');
finish('starred');
