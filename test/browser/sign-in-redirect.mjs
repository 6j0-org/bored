// Headless Chromium against Bored in 6j0 mode (its own server; the shared one is a demo), with a stand-in ID
// server that only records where it was sent: anyone not signed in goes straight to the ID server, with a
// deep link (?open=…) kept for after; and they get the sign-in page instead when that would go round in circles
// (just came back without signing in, or sign-in failed) or undo signing out.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { browser, finish, wait, TMP } from '../lib.mjs';
import { listen, startServer } from '../spawn.mjs';

const idServer = createServer((req, res) => {
  if (req.url.startsWith('/.well-known/')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"keys":[]}'); }
  res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<p id="stub">ID server</p>');
});
const ID_ORIGIN = `http://127.0.0.1:${await listen(idServer)}`;
const { base: BORED, proc: bored, log } = await startServer({ DEMO: '', AUTH_MODE: '6j0', ID_ORIGIN,
  DB_PATH: join(TMP, 'sign-in-redirect.sqlite'), FEEDBACK_PATH: join(TMP, 'sign-in-redirect.jsonl') });

const B = await browser('sign-in-redirect');
const open = async (url) => { await B.send('Page.navigate', { url: 'about:blank' }); await wait(300); await B.send('Page.navigate', { url }); };
const atIdServer = () => B.until(`location.origin === '${ID_ORIGIN}' && !!document.getElementById('stub')`);
const signInPage = () => B.until(`location.origin === '${BORED}' && !!document.getElementById('idSignIn')`);
try {
  await B.send('Network.clearBrowserCookies'); // the demo's session cookie (cookies ignore the port)

  // A deep link while signed out: straight to the ID server's /authorize, for this app.
  await open(`${BORED}/?open=profile`);
  await atIdServer();
  const q = new URLSearchParams(await B.ev(`location.search`));
  assert.equal(await B.ev(`location.pathname`), '/authorize');
  assert.equal(q.get('app'), 'bored');
  assert.ok(q.get('nonce') && q.get('epk'), 'nonce and key');

  // Back without signing in (cancelled there): the sign-in page, not round again. The deep link is still waiting.
  await open(`${BORED}/`);
  await signInPage();
  assert.equal(await B.ev(`document.querySelector('nav.tabs').hidden`), true, 'no tabs');
  assert.equal(await B.ev(`sessionStorage.getItem('pendingOpen')`), 'profile');
  // Its button goes to the ID server.
  await B.ev(`document.getElementById('idSignIn').click()`);
  await atIdServer();

  // A sign-in that fails coming back: the sign-in page with the reason, even when it's been a while.
  await open(`${BORED}/`); await signInPage();
  await B.ev(`sessionStorage.removeItem('bored-signin-tried')`);
  await open(`${BORED}/#id_token=x&epk=a.b&key=c.d&state=nope`);
  await signInPage();
  await B.until(`document.getElementById('toast').textContent.includes('expired')`);

  // Signed out on this browser: the sign-in page, saying so, until they sign in again.
  await B.ev(`sessionStorage.removeItem('bored-signin-tried'); localStorage.setItem('bored-signed-out', String(Date.now()))`);
  await open(`${BORED}/`);
  await signInPage();
  assert.match(await B.ev(`document.querySelector('.account .lead').textContent`), /signed out/);

  // Otherwise, a plain visit goes straight to the ID server again.
  await B.ev(`localStorage.removeItem('bored-signed-out')`);
  await open(`${BORED}/`);
  await atIdServer();
} catch (e) {
  console.log(log());
  throw e;
} finally {
  B.close(); bored.kill(); idServer.close();
}
finish('sign-in-redirect');
