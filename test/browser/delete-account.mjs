// Deleting an account from Profile in the demo: the wrong code does nothing, the right one (the end of the Account
// ID at the bottom of the page) erases the account on the server, and the demo starts a fresh one.
import assert from 'node:assert/strict';
import { browser, finish, wait } from '../lib.mjs';
const B = await browser('delete-account');
const ev = B.ev, out = {};
const guid = () => ev(`fetch('/api/me').then(r => r.json()).then(m => m.guid)`);
const submit = (code) => ev(`(() => { const f = document.getElementById('deleteAccount'); f.confirm.value = '${code}'; f.requestSubmit(); })()`);

await B.tab('profile');
const before = await guid();
out.shown = await ev(`document.getElementById('accountId').textContent.trim()`);
out.section = await ev(`document.querySelector('#deleteAccount label').textContent.replace(/\\s+/g, ' ').trim()`);
await submit(before.slice(-4) === 'zzzz' ? 'yyyy' : 'zzzz');
await wait(800);
out.wrongToast = await ev(`document.getElementById('toast').textContent`);
out.stillHere = (await guid()) === before;
await submit(before.slice(-4));
await B.until(`fetch('/api/me').then(r => r.json()).then(m => m.guid && m.guid !== '${before}')`, 30000);
await wait(1000);
out.after = await guid();
out.oldKeys = await ev(`fetch('/api/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ guids: ['${before}'] }) }).then(r => r.json())`);
console.log(JSON.stringify(out, null, 2));

assert.equal(out.shown, `Account ID: ${before}`);
assert.match(out.section, /last 4 characters of your Account ID\. It's at the very bottom of this page\./);
assert.match(out.wrongToast, /doesn't match/);
assert.ok(out.stillHere, 'the wrong code changes nothing');
assert.ok(out.after && out.after !== before, 'the demo starts a fresh account');
assert.deepEqual(out.oldKeys, {}, 'the old account is gone from the server');
B.close();
finish('browser delete account');
