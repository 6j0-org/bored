// Network trouble never signs anyone out: losing the connection while using Bored (the badge refresh fails) leaves
// the account and its keys in place, and opening Bored without a connection says it can't reach Bored, then picks
// up where it was once the connection is back.
import assert from 'node:assert/strict';
import { browser, finish, wait } from '../lib.mjs';

const B = await browser('offline');
const guid = () => B.ev(`fetch('/api/me').then(r => r.json()).then(m => m.guid)`);
const before = await guid();
const signedIn = () => B.ev(`!!document.querySelector('nav.tabs button[data-tab=discover]') && !document.getElementById('signIn') && !document.getElementById('idSignIn')`);

// Offline through a badge refresh (every 20 seconds), then back: still signed in, on any tab.
await B.send('Network.enable');
const offline = (on) => B.send('Network.emulateNetworkConditions', { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await offline(true);
await wait(22000);
await offline(false);
await B.tab('profile');
assert.ok(await signedIn(), 'still signed in after the connection dropped');
await B.tab('discover');
assert.ok(await signedIn());

// Opening Bored while /api/me can't be reached: "Can't reach Bored", not the sign-in screen.
await B.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/me' }] });
const failing = (m) => { if (m.method === 'Fetch.requestPaused') B.send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'InternetDisconnected' }); };
B.onEvent = failing;
await B.send('Page.reload');
await B.until(`document.getElementById('retryStart')`, 30000);
assert.match(await B.ev(`document.querySelector('.offline').innerText`), /Can't reach Bored[\s\S]*still signed in/);

// Back online: Try again opens the same account, keys and all.
B.onEvent = null;
await B.send('Fetch.disable');
await B.ev(`document.getElementById('retryStart').click()`);
await B.until(`document.querySelector('nav.tabs button[data-tab=discover]')`);
await wait(1500);
assert.equal(await guid(), before, 'the same account');
assert.ok(await signedIn(), 'and unlocked');
assert.equal(await B.ev(`!!document.querySelector('.offline')`), false);

B.close();
finish('offline');
