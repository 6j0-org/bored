// Notifications through ntfy: turning it on makes a random topic on an offered server, notifications are published
// there as JSON (generic text, a link back into the app, and the server's access token if NTFY_SERVERS has one), a
// new topic replaces the old one, servers that aren't offered are refused, and turning it off stops them. Runs its own
// demo server, pointed at a stand-in ntfy server.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const listen = (srv) => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const got = [];
const ntfy = createServer((req, res) => {
  let body = ''; req.on('data', d => body += d);
  req.on('end', () => { got.push({ path: req.url, auth: req.headers.authorization || '', body: JSON.parse(body) }); res.end('{}'); });
});
const NTFY = `http://127.0.0.1:${await listen(ntfy)}`;
const probe = createServer(), port = await listen(probe);
await new Promise(r => probe.close(r));
const BASE = `http://127.0.0.1:${port}`;
const bored = spawn(process.execPath, ['server.js'], {
  cwd: new URL('../..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, DEMO: '1', AUTH_MODE: '', PORT: String(port), NTFY_SERVERS: `${NTFY}=tk_test,https://ntfy.example` },
});
let log = ''; bored.stdout.on('data', d => log += d); bored.stderr.on('data', d => log += d);
const until = async (fn, ms = 5000) => { for (let t = 0; t < ms; t += 50) { if (fn()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error('timed out'); };
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/config')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  process.env.TEST_BASE = BASE;
  const { person } = await import('../lib.mjs');
  const a = await person('ntfy-a');

  assert.deepEqual(await a.api('/api/ntfy'), { servers: [NTFY, 'https://ntfy.example'], topic: null });
  await assert.rejects(a.api('/api/ntfy', { method: 'POST', body: { server: 'https://evil.example' } }), /isn't offered/);

  // On: a random topic, and a test arrives there with the token, the generic text, and a link to Profile.
  const on = await a.api('/api/ntfy', { method: 'POST', body: { server: NTFY } });
  assert.equal(on.topic.server, NTFY);
  assert.match(on.topic.topic, /^bored_[A-Za-z0-9_-]{32}$/);
  await a.api('/api/push/test', { method: 'POST' });
  await until(() => got.length === 1);
  assert.equal(got[0].path, '/');
  assert.equal(got[0].auth, 'Bearer tk_test');
  assert.deepEqual(got[0].body, { topic: on.topic.topic, title: 'Bored', message: "Notifications are on. You'll hear about requests, matches, and messages here.", click: `${BASE}/?open=profile` });

  // A new topic replaces the old one.
  const renewed = await a.api('/api/ntfy', { method: 'POST', body: { server: NTFY } });
  assert.notEqual(renewed.topic.topic, on.topic.topic);
  await a.api('/api/push/test', { method: 'POST' });
  await until(() => got.length === 2);
  assert.equal(got[1].body.topic, renewed.topic.topic);

  // Off: nothing more is published.
  assert.equal((await a.api('/api/ntfy/off', { method: 'POST' })).topic, null);
  await a.api('/api/push/test', { method: 'POST' });
  await new Promise(r => setTimeout(r, 500));
  assert.equal(got.length, 2);
  console.log('ntfy: ok');
} catch (e) {
  console.log(log);
  throw e;
} finally {
  bored.kill(); ntfy.close();
}
