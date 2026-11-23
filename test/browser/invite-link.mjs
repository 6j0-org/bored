// Headless Chromium against the demo: an invitation link opened by someone new shows the About page first, with
// "Connect with <name>" in place of "Open Bored", and that button carries the invitation on to the app.
import assert from 'node:assert/strict';
import { browser, finish, wait, BASE } from '../lib.mjs';

// A fresh page load: from "/" to "/#…" would only change the fragment.
const open = async (path) => { await B.send('Page.navigate', { url: 'about:blank' }); await wait(300); await B.send('Page.navigate', { url: BASE + path }); await wait(1500); };

const B = await browser('invite-link');
// Someone new: no session and no "seen" cookie, so "/" is the About page.
await B.send('Network.clearBrowserCookies');
const token = 'x'.repeat(32); // well formed, but no such invitation
await open(`/#invite=${token}&key=${'k'.repeat(32)}&name=${encodeURIComponent('Sam <b>& co')}`);
assert.ok(await B.ev(`!!document.querySelector('.closer') && !document.querySelector('nav.tabs')`), 'the About page, not the app');
assert.equal(await B.ev(`location.hash.includes('invite=')`), true, 'the invitation stays in the address');
assert.equal(await B.ev(`document.getElementById('openBored').textContent`), 'Connect with Sam <b>& co', 'the name, as text');
assert.equal(await B.ev(`!!document.querySelector('#openBored b')`), false, 'not as markup');

// Without a name in the link, just "Connect".
await open(`/#invite=${token}&key=${'k'.repeat(32)}`);
assert.equal(await B.ev(`document.getElementById('openBored').textContent`), 'Connect');

// The button goes on to the app with the invitation, which the app checks (this one doesn't exist).
await B.ev(`document.getElementById('openBored').click()`);
await B.until(`document.querySelector('nav.tabs button[data-tab=discover]')`);
await B.until(`document.body.innerText.includes('That invitation link is not valid')`);
assert.equal(await B.ev(`location.hash`), '', 'the app takes the invitation out of the address');

// A plain visit still gets "Open Bored".
await B.send('Network.clearBrowserCookies');
await open('/');
assert.equal(await B.ev(`document.getElementById('openBored').textContent`), 'Open Bored');

B.close();
finish('invite-link');
