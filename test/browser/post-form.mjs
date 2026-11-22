// The Post tab's form: a post idea fills it in (no separate sheet), the quick picks above Starts and Ends fill in
// the times, the Post button says who'll see it, and a private post with nobody picked isn't posted.
import assert from 'node:assert/strict';
import { browser, finish, wait } from '../lib.mjs';

const B = await browser('post-form');
await B.tab('post');
await B.until(`document.querySelector('#newEvent input[name=title]')`);

// A post idea fills in the form on the page.
await B.ev(`document.querySelector('.idea-open').click()`);
await wait(300);
assert.equal(await B.ev(`!!document.querySelector('.sheet')`), false, 'no sheet opens');
assert.ok((await B.ev(`document.querySelector('#newEvent input[name=title]').value`)).length > 0, 'the title is filled in');
// Again, now that it's started: it asks first (say no, and nothing changes).
const title = await B.ev(`document.querySelector('#newEvent input[name=title]').value`);
await B.ev(`window.confirm = () => false; document.querySelector('.idea-next').click(); document.querySelector('.idea-open').click()`);
assert.equal(await B.ev(`document.querySelector('#newEvent input[name=title]').value`), title, 'kept what was there');

// Quick picks: "In an hour" fills Starts; "2 hours" fills Ends two hours after it. Sunset needs a place.
await B.ev(`document.querySelector('#newEvent [data-pick-start="1h"]').click()`);
const start = await B.ev(`document.querySelector('#newEvent input[name=when_text]').value`);
assert.match(start, /^\d{4}-\d\d-\d\dT\d\d:\d[05]$/, 'a start, on a 5-minute mark');
assert.equal(await B.ev(`document.querySelector('#newEvent [data-pick-start="1h"]').classList.contains('on')`), true, 'shown as picked');
await B.ev(`document.querySelector('#newEvent [data-pick-end="2h"]').click()`);
const end = await B.ev(`document.querySelector('#newEvent input[name=end_text]').value`);
assert.equal((new Date(end) - new Date(start)) / 60e3, 120, 'ends two hours after the start');
assert.equal(await B.ev(`document.querySelector('#newEvent [data-pick-end="sunset"]').disabled`), true, 'sunset waits for a place');

// The Post button says who'll see it: one picked person, then nobody (disabled), then public.
const button = () => B.ev(`(() => { const b = document.querySelector('#newEvent [data-post-button]'); return [b.textContent, b.disabled]; })()`);
await B.ev(`(() => { const form = document.getElementById('newEvent');
  form.querySelector('input[name=visibility][value=private]').click();
  form.querySelectorAll('.audience .chip.on').forEach(c => c.click());
  form.querySelector('.audience [data-contact]').click(); })()`);
assert.deepEqual(await button(), ['Post it to 1 person', false]);
await B.ev(`document.querySelector('#newEvent .audience [data-contact].on').click()`);
assert.deepEqual(await button(), ['Pick who can see it', true]);
await B.ev(`document.querySelector('#newEvent input[name=visibility][value=public]').click()`);
assert.deepEqual(await button(), ['Post it publicly', false]);

// Private with nobody picked: refused, with why, and nothing posted (even if the form is submitted some other way).
await B.ev(`(() => { const form = document.getElementById('newEvent');
  form.querySelector('input[name=visibility][value=private]').click();
  form.requestSubmit(); })()`);
await B.until(`document.getElementById('toast').textContent.includes('Pick at least one person or group')`);
assert.equal(await B.ev(`document.querySelector('#newEvent input[name=title]').value`), title, 'the form is still there, unposted');

B.close();
finish('browser post-form');
