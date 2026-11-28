// Headless Chromium against the demo: "/" is always the app (the introduction is only at "/about"), and deep links
// reach the app with someone new: an invitation link (checked, and taken out of the address) and "?open=…".
import assert from 'node:assert/strict';
import { browser, finish, wait, BASE } from '../lib.mjs';

// A fresh page load: from "/" to "/#…" would only change the fragment.
const open = async (path) => { await B.send('Page.navigate', { url: 'about:blank' }); await wait(300); await B.send('Page.navigate', { url: BASE + path }); await wait(1500); };

const B = await browser('invite-link');
// Someone new opens an invitation link: the app, which checks the invitation (this one doesn't exist).
await B.send('Network.clearBrowserCookies');
const token = 'x'.repeat(32); // well formed, but no such invitation
await open(`/#invite=${token}&key=${'k'.repeat(32)}&name=${encodeURIComponent('Sam')}`);
await B.until(`document.querySelector('nav.tabs button[data-tab=discover]')`);
assert.equal(await B.ev(`!!document.querySelector('.closer')`), false, 'not the About page');
await B.until(`document.body.innerText.includes('That invitation link is not valid')`);
assert.equal(await B.ev(`location.hash`), '', 'the app takes the invitation out of the address');

// A deep link to a screen: opened once there's an account, and taken out of the address.
await B.send('Network.clearBrowserCookies');
await open('/?open=profile');
await B.until(`document.querySelector('nav.tabs button[data-tab=profile].active')`);
assert.equal(await B.ev(`location.search`), '', 'the app takes ?open out of the address');

// Older links to "/?start" still reach the app.
await open('/?start');
await B.until(`document.querySelector('nav.tabs')`);
assert.equal(await B.ev(`location.search`), '');

// The About page is at /about, and "Open Bored" goes to the app.
await open('/about');
assert.ok(await B.ev(`!!document.querySelector('.closer')`), 'the About page');
assert.equal(await B.ev(`document.getElementById('openBored').getAttribute('href')`), '/');
assert.equal(await B.ev(`document.getElementById('feedbackLink').getAttribute('href')`), '/?open=feedback');

B.close();
finish('invite-link');
