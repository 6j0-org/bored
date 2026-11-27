// Someone asks to connect through my invitation link: their card in Confirm has a field for my nickname for them,
// starting with the one they suggest. What I type survives a redraw, and saying yes saves it to my contacts.
import assert from 'node:assert/strict';
import { browser, finish, wait, BASE } from '../lib.mjs';

const A = await browser('inviter'), B = await browser('invitee');
for (const P of [A, B]) {
  await P.ev(`document.querySelector('.tour [data-tour-action=skip]')?.click()`);
  await P.until(`!document.querySelector('.tour:not([hidden])')`, 5000);
}

// A creates an invitation; the link is copied (no share sheet here).
await A.ev(`Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
  navigator.clipboard.writeText = async (u) => { window.__link = u; }`);
await A.tab('profile');
await A.until(`document.getElementById('newInvite')`, 30000);
await A.ev(`document.getElementById('newInvite').click()`);
await A.until(`document.querySelector('.sheet input[name=name]')`);
await A.ev(`(() => { const f = document.querySelector('.sheet form'); f.name.value = 'Hal from hiking'; f.requestSubmit(); })()`);
await A.until(`window.__link`);
const link = await A.ev(`window.__link`);
assert.ok(link.startsWith(BASE + '/#invite='), link);

// B opens it and asks to connect, suggesting a nickname for themselves.
await B.send('Page.navigate', { url: 'about:blank' }); await wait(300);
await B.send('Page.navigate', { url: link });
await B.until(`document.querySelector('.sheet input[name=myName]')`, 30000);
await B.ev(`(() => { const f = document.querySelector('.sheet form'); f.theirName.value = 'Hal'; f.myName.value = 'Robin, by the creek';
  f.requestSubmit(); })()`);
await B.until(`document.body.innerText.includes('Request sent')`);

// A finds the request in Confirm (the search leaves only it), with B's suggestion in the field.
await A.tab('confirm');
const search = async (q) => {
  await A.ev(`(() => { const f = document.querySelector('#view .tab-search'); f.querySelector('input').value = ${JSON.stringify(q)}; f.requestSubmit(); })()`);
  await wait(300);
};
await A.until(`document.querySelector('.card [data-nickname]')`, 30000);
await search('wants to connect');
await A.until(`document.querySelector('.card.top [data-nickname]')`);
const field = `document.querySelector('.card.top [data-nickname]')`;
assert.equal(await A.ev(`${field}.value`), 'Robin, by the creek', 'starts as their suggestion');
assert.equal(await A.ev(`${field}.closest('label').textContent.trim().startsWith('Your nickname for them')`), true);

// A changes it; a redraw (a new search) keeps what was typed.
await A.ev(`(() => { const i = ${field}; i.value = 'Robin from the trail'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await search('connect');
assert.equal(await A.ev(`${field}.value`), 'Robin from the trail', 'kept through a redraw');

// Yes connects them under that nickname, without asking for one again.
await A.ev(`document.querySelector('.round.yes').click()`);
await A.until(`document.body.innerText.includes('Connected with Robin from the trail!')`);
await wait(500);
assert.equal(await A.ev(`document.querySelector('.sheet') === null`), true, 'no contact sheet to fill in');
await search('');
await A.tab('profile');
await A.until(`[...document.querySelectorAll('[data-contact] .title')].some(t => t.textContent === 'Robin from the trail')`, 30000);

A.close(); B.close();
finish('connect-nickname');
