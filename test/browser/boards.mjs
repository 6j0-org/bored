// The title board's look: a surfboard by default, picked in Profile's Settings, kept in this browser after a reload,
// and on the introduction and privacy pages too (they load the same theme.js and boards.css).
import assert from 'node:assert/strict';
import { browser, finish } from '../lib.mjs';

const A = await browser('boards');
const board = () => A.ev(`[document.documentElement.dataset.board, getComputedStyle(document.querySelector('.board'), '::before').backgroundImage]`);
const [look, image] = await board();
assert.equal(look, 'surf', 'the surfboard by default');
assert.match(image, /\/board-surf\.svg/);
for (const f of ['/board-surf.svg', '/board-planed.svg', '/boards.css']) assert.equal(await A.ev(`fetch('${f}').then(r => r.ok)`), true, f);

await A.tab('profile');
await A.until(`document.querySelector('#boardPick input[value=surf]:checked')`, 30000);
await A.ev(`document.querySelector('#boardPick input[value=planed]').click()`);
assert.match((await board())[1], /\/board-planed\.svg/, 'picking one swaps it right away');
await A.reload();
assert.deepEqual((await board())[0], 'planed', 'kept after a reload');

await A.ev(`document.querySelector('nav.tabs button[data-tab=profile]').click()`);
await A.until(`document.querySelector('#boardPick input[value=planed]:checked')`, 30000);
await A.ev(`document.querySelector('#boardPick input[value=rough]').click()`);
assert.match((await board())[1], /\/board\.webp/, 'the rough plank');
await A.ev(`document.querySelector('#boardPick input[value=surf]').click()`);
assert.equal(await A.ev(`localStorage.getItem('board') === null`), true, 'the default isn\'t saved');
for (const page of ['/about', '/privacy']) assert.equal(await A.ev(`fetch('${page}').then(r => r.text()).then(t => t.includes('href="/boards.css"') && t.includes('src="/theme.js"'))`), true, page);
finish('boards');
