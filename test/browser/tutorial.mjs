// The first-visit tutorial: it shows for a new account, steps through the six steps, points at each step's target,
// and once finished, stays gone after a reload (prefs.tutorialSeen in the vault). A switch in Profile's settings
// turns it back on or off.
import assert from 'node:assert/strict';
import { browser, finish, wait } from '../lib.mjs';
const B = await browser('tutorial');
const ev = B.ev;
const box = () => ev(`(() => { const t = document.querySelector('.tour'); return t && !t.hidden ? t.innerText.replace(/\\s+/g, ' ') : ''; })()`);
const act = async (a) => { await ev(`document.querySelector('.tour [data-tour-action=${a}]').click()`); await wait(1500); };
const out = {};

await B.until(`document.querySelector('.tour')`);
out.first = await box();
out.firstTab = await ev(`document.body.dataset.tourTab`);
out.notMoved = await ev(`document.querySelector('nav.tabs button.active')?.dataset.tab`);
await act('show');
out.onProfile = await ev(`document.body.dataset.tour`);
out.inviteRing = await ev(`getComputedStyle(document.querySelector('#newInvite')).outlineStyle`);
const steps = [];
for (let i = 0; i < 5; i++) {
  if (i === 1) { // Get notified: Profile's Notifications are ringed, and the invitation button isn't any more
    out.pushRing = await ev(`getComputedStyle(document.querySelector('#pushSettings')).outlineStyle`);
    out.inviteRingAfter = await ev(`getComputedStyle(document.querySelector('#newInvite')).outlineStyle`);
  }
  await act('next');
  steps.push([await ev(`document.querySelector('nav.tabs button.active')?.dataset.tab`), await ev(`document.getElementById('tourTitle')?.textContent`)]);
}
out.steps = steps;
out.last = await box();
await act('done');
out.afterDone = await box();
await wait(1000);
await B.reload();
out.afterReload = await box();
await B.tab('profile');
out.switchOff = await ev(`document.getElementById('tutorialPref').checked`);
await ev(`document.getElementById('tutorialPref').click()`);
await wait(2500);
out.replayed = await box();
out.replayTab = await ev(`document.body.dataset.tour`);
out.switchOn = await ev(`document.getElementById('tutorialPref').checked`);
await B.reload();
out.replayAfterReload = await box();
await B.tab('profile');
await ev(`document.getElementById('tutorialPref').click()`);
await wait(1500);
out.switchedOff = await box();
console.log(JSON.stringify(out, null, 2));

assert.match(out.first, /Step 1 of 6 Connect Welcome to Bored!/);
assert.equal(out.firstTab, 'profile', 'step 1 points at Profile');
assert.equal(out.notMoved, 'discover', "the tutorial doesn't switch tabs by itself");
assert.equal(out.onProfile, 'connect', '"Show me" opens Profile');
assert.equal(out.inviteRing, 'solid', 'the invitation button is ringed');
assert.deepEqual(out.steps, [['profile', 'Get notified'], ['post', 'Post'], ['discover', 'Discover'], ['confirm', 'Confirm'], ['plans', 'Plan']]);
assert.equal(out.pushRing, 'solid', 'Get notified rings the Notifications settings');
assert.equal(out.inviteRingAfter, 'none', '...and not the invitation button');
assert.match(out.last, /Step 6 of 6 .* Done$/);
assert.equal(out.afterDone, '', 'Done closes it');
assert.equal(out.afterReload, '', "it doesn't come back after a reload");
assert.equal(out.switchOff, false, "Profile's switch is off once it's done");
assert.match(out.replayed, /Step 1 of 6 Connect/, "Profile's switch shows it again");
assert.equal(out.replayTab, 'connect', 'from step 1, on Profile');
assert.equal(out.switchOn, true, 'the switch is on while it shows');
assert.match(out.replayAfterReload, /Step 1 of 6 Connect/, 'turned back on, it lasts through a reload');
assert.equal(out.switchedOff, '', 'turning the switch off closes it');
B.close();
finish('browser tutorial');
