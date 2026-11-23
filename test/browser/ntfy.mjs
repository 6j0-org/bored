// Profile's ntfy block: Set up ntfy shows a topic to subscribe to (with an ntfy:// link), New topic replaces it, and
// Turn off ntfy goes back to the setup button. The "new posts in Discover" box starts checked, and unchecking it is
// saved for the account. (The test server's only ntfy server is a dead local address.)
import assert from 'node:assert/strict';
import { browser, finish, wait } from '../lib.mjs';

const B = await browser('ntfy');
await B.tab('profile');
await B.until(`document.querySelector('#ntfySettings [data-ntfy-on]')`);
assert.match(await B.ev(`document.getElementById('ntfySettings').innerText`), /without Google Play services[\s\S]*ntfy/);
await B.ev(`window.confirm = () => true; document.querySelector('[data-ntfy-on]').click()`);
await B.until(`document.querySelector('#ntfySettings .ntfy-topic')`);
const topic = await B.ev(`document.querySelector('.ntfy-topic').textContent`);
assert.match(topic, /^http:\/\/127\.0\.0\.1:9\/bored_[A-Za-z0-9_-]{32}$/);
assert.equal(await B.ev(`document.querySelector('#ntfySettings a[href^="ntfy://"]').getAttribute('href')`), topic.replace('http://', 'ntfy://'));

await B.ev(`document.querySelector('[data-ntfy-new]').click()`);
await B.until(`document.querySelector('.ntfy-topic') && document.querySelector('.ntfy-topic').textContent !== ${JSON.stringify(topic)}`);

await B.ev(`document.querySelector('[data-ntfy-off]').click()`);
await B.until(`document.querySelector('#ntfySettings [data-ntfy-on]')`);

assert.equal(await B.ev(`document.getElementById('discoverNews').checked`), true);
assert.match(await B.ev(`document.getElementById('discoverNews').closest('label').innerText`), /new posts in Discover[\s\S]*twice a day/);
await B.ev(`document.getElementById('discoverNews').click()`);
await B.until(`fetch('/api/me').then(r => r.json()).then(m => m.discoverNews.on === false)`);
await wait(300);
B.close();
finish('ntfy');
