// The look: the surfboard with its sand theme by default, picked in Profile's Settings, kept in this browser after a
// reload, and on the introduction and privacy pages too (they load the same theme.js and boards.css). The cartoon and
// photo boards keep the wood browns. Each has a light and a dark theme.
import assert from 'node:assert/strict';
import { browser, finish, wait, BASE } from '../lib.mjs';

const A = await browser('boards');
const board = () => A.ev(`[document.documentElement.dataset.board, getComputedStyle(document.querySelector('.board'), '::before').backgroundImage]`);
const [look, image] = await board();
assert.equal(look, 'surf', 'the surfboard by default');
assert.match(image, /\/board-surf\.svg/);
for (const f of ['/board-surf.svg', '/board-planed.svg', '/boards.css']) assert.equal(await A.ev(`fetch('${f}').then(r => r.ok)`), true, f);
// The colors of a button, the page, and the board's letters, in this look and theme.
const colors = () => A.ev(`(() => { const s = getComputedStyle(document.documentElement);
  return ['--wood', '--bg', '--board-text'].map(v => s.getPropertyValue(v).trim()).join(' | '); })()`);
const theme = (t) => A.ev(`window.boredTheme.set('${t}')`);
await theme('light');
const sandLight = await colors();
assert.match(sandLight, /#eed1a6.*\| #f7efe2 \| #3b2a12/, 'sand buttons, sand page, and dark letters on the light surfboard');
await theme('dark');
assert.match(await colors(), /#eed1a6.*\| #17140e \| #3b2a12/, 'the same sand buttons on a dark page');
assert.equal(await A.ev(`getComputedStyle(document.querySelector('.board'), '::before').filter`), 'brightness(0.86) saturate(0.92)', 'the board a little dimmer in dark');
await theme('auto');

await A.tab('profile');
await A.until(`document.querySelector('#boardPick input[value=surf]:checked')`, 30000);
await A.ev(`document.querySelector('#boardPick input[value=planed]').click()`);
assert.match((await board())[1], /\/board-planed\.svg/, 'picking one swaps it right away');
await theme('light');
assert.match(await colors(), /#a05a28.*\| #f2eee5 \| #f6ecda/, 'the cartoon board keeps the wood browns and cream letters');
await theme('dark');
assert.match(await colors(), /#a05a28.*\| #14110d \| #f6ecda/, 'and its dark theme');
await theme('auto');
await A.reload();
assert.deepEqual((await board())[0], 'planed', 'kept after a reload');

await A.ev(`document.querySelector('nav.tabs button[data-tab=profile]').click()`);
await A.until(`document.querySelector('#boardPick input[value=planed]:checked')`, 30000);
await A.ev(`document.querySelector('#boardPick input[value=rough]').click()`);
assert.match((await board())[1], /\/board\.webp/, 'the photo board');
assert.deepEqual(await A.ev(`[...document.querySelectorAll('#boardPick span')].map(s => s.textContent)`), ['Surfboard', 'Cartoon board', 'Photo board']);
await A.ev(`document.querySelector('#boardPick input[value=surf]').click()`);
assert.equal(await A.ev(`localStorage.getItem('board') === null`), true, 'the default isn\'t saved');
// The board is the same shape on the introduction and privacy pages as in the app, even on a wide screen.
await A.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
const shape = () => A.ev(`(() => { const b = document.querySelector('.board').getBoundingClientRect(); return b.width / b.height; })()`);
const inApp = await shape();
for (const page of ['/about', '/privacy']) {
  await A.send('Page.navigate', { url: BASE + page }); await A.until(`document.querySelector('.board')`); await wait(800);
  const there = await shape();
  assert.ok(Math.abs(there - inApp) < 0.15, `${page}: ${there.toFixed(2)} wide for 1 high, ${inApp.toFixed(2)} in the app`);
}
for (const page of ['/about', '/privacy']) assert.equal(await A.ev(`fetch('${page}').then(r => r.text()).then(t => t.includes('href="/boards.css"') && t.includes('src="/theme.js"'))`), true, page);
finish('boards');
