// Links to public posts: the host shares one from Post (copied, where there's no share menu), and someone else who
// opens it gets that post first in Discover, whatever their filters say. Opening it again after passing, as the host,
// or for a post that isn't there says why instead.
import assert from 'node:assert/strict';
import { browser, finish, wait, BASE } from '../lib.mjs';

const A = await browser('share-host'), B = await browser('share-other');
const TITLE = `Shared picnic ${Date.now() % 100000}`;
// Headless Chromium has no share menu, so the link goes to the clipboard: keep it where the test can read it.
const stubClipboard = (P) => P.ev(`navigator.clipboard.writeText = async (t) => { window.copied = t; }`);
const open = async (P, path) => { await P.send('Page.navigate', { url: 'about:blank' }); await wait(300); await P.send('Page.navigate', { url: BASE + path }); };
const toastSays = (P, text) => P.until(`document.getElementById('toast').textContent.includes(${JSON.stringify(text)})`);

// The host posts something public, then shares it from Post.
await A.tab('post');
await A.ev(`(() => { const f = document.getElementById('newEvent'); f.title.value = '${TITLE}';
  f.querySelector('input[name=visibility][value=public]').click(); })()`);
await A.ev(`window.confirm = () => true; document.getElementById('newEvent').requestSubmit()`);
await A.until(`[...document.querySelectorAll('#view .post-card')].some(x => x.innerText.includes('${TITLE}'))`);
await stubClipboard(A);
await A.ev(`[...document.querySelectorAll('#view .post-card')].find(x => x.innerText.includes('${TITLE}')).querySelector('[data-share-post]').click()`);
await A.until(`window.copied`);
const link = await A.ev(`window.copied`);
assert.match(link, new RegExp(`^${BASE}/\\?post=[A-Za-z0-9_-]{16,43}$`), 'a link to the post');
await toastSays(A, 'Link copied');
const path = link.slice(BASE.length);

// Someone else, with a filter on that the post doesn't match, opens the link: it's on top, and the address is clean.
await B.ev(`localStorage.setItem('discoverTags', JSON.stringify(['no-such-tag']))`);
await open(B, path);
await B.until(`document.querySelector('.card.top h2')?.textContent === '${TITLE}'`);
assert.equal(await B.ev(`location.search`), '', 'the app takes ?post out of the address');
// Public cards in Discover have their own Share link.
assert.equal(await B.ev(`!!document.querySelector('.card.top [data-share-post]')`), true, 'Share on the card');
await B.ev(`localStorage.removeItem('discoverTags')`);

// They pass on it; opening the link again says where it went.
await B.ev(`document.querySelector('.round.no').click()`); await wait(1500);
await open(B, path);
await toastSays(B, 'You passed on');

// The host opening their own link, and a link to a post that isn't there.
await open(A, path);
await toastSays(A, 'your own post');
await open(B, `/?post=${'x'.repeat(22)}`);
await toastSays(B, 'has ended or was removed');

A.close(); B.close();
finish('share-post');
