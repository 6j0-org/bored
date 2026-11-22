// AUTH_MODE=6j0: a deleted 6j0.org identity's account is erased when the identity server's signed notice arrives at
// /api/id/deleted, and sign-in tokens and deletion notices can't stand in for each other. Runs its own Bored server
// in 6j0 mode (the shared test server is a demo), against a stand-in identity server that only serves its JWKS.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, generateKeyPair, randomBytes, sign } from 'node:crypto';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { TMP, wait } from '../lib.mjs';

const listen = (srv) => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

// The stand-in identity server: an Ed25519 key, and its JWKS.
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const jwk = publicKey.export({ format: 'jwk' }), kid = 'test-key';
const idServer = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ keys: [{ ...jwk, kid, alg: 'EdDSA', use: 'sig' }] }));
});
const ID_ORIGIN = `http://127.0.0.1:${await listen(idServer)}`;
const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(claims) {
  const now = Math.floor(Date.now() / 1000);
  const head = enc({ alg: 'EdDSA', typ: 'JWT', kid });
  const body = enc({ iss: ID_ORIGIN, aud: 'bored', iat: now, exp: now + 120, jti: randomBytes(16).toString('base64url'), ...claims });
  return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
}
const DELETED = { '6j0/v1/identity-deleted': {} };

// Bored in 6j0 mode, with its own database.
const probe = createServer(), port = await listen(probe);
await new Promise(r => probe.close(r)); // a free port
const BASE = `http://127.0.0.1:${port}`;
const bored = spawn(process.execPath, ['server.js'], {
  cwd: new URL('../..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, DEMO: '', AUTH_MODE: '6j0', ID_ORIGIN, PORT: String(port), DB_PATH: join(TMP, `id-deleted-${port}.sqlite`),
    FEEDBACK_PATH: join(TMP, `id-deleted-${port}.jsonl`) },
});
let log = ''; bored.stdout.on('data', d => log += d); bored.stderr.on('data', d => log += d);
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/config')).ok) break; } catch {} await wait(100); }
  const post = async (path, body, cookie = '') => {
    const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => ({})), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  };

  // Sign up as identity "sub-1": sign in (no account yet, so a setup challenge), then register.
  const nonce = randomBytes(16).toString('base64url');
  const login = await post('/api/id/login', { token: token({ sub: 'sub-1', nonce }), nonce });
  assert.ok(login.data.setup, login.data.error);
  const { publicKey: chat } = await promisify(generateKeyPair)('ec', { namedCurve: 'P-256' });
  const { x, y } = chat.export({ format: 'jwk' });
  const blob = () => `${randomBytes(12).toString('base64url')}.${randomBytes(40).toString('base64url')}`;
  const reg = await post('/api/id/register', { setup: login.data.setup, wrappedKey: blob(), chatPubkey: { kty: 'EC', crv: 'P-256', x, y }, chatPrivkey: blob(), vault: blob() });
  assert.equal(reg.status, 200, reg.data.error);
  const me = await fetch(BASE + '/api/me', { headers: { Cookie: reg.cookie } });
  assert.equal(me.status, 200, 'signed in');

  // Bored's own deletion is refused in 6j0 mode.
  const own = await post('/api/account/delete', { confirm: reg.data.user.guid.slice(-4) }, reg.cookie);
  assert.equal(own.status, 400);
  assert.match(own.data.error, /6j0\.org identity/);

  // Sign-in tokens aren't deletion notices, deletion notices aren't sign-in tokens, and the audience must match.
  assert.equal((await post('/api/id/deleted', { token: token({ sub: 'sub-1', nonce }) })).status, 401, 'a sign-in token is no notice');
  assert.equal((await post('/api/id/deleted', { token: token({ sub: 'sub-1', nonce, events: DELETED }) })).status, 401, 'a notice has no nonce');
  const n2 = randomBytes(16).toString('base64url');
  assert.equal((await post('/api/id/login', { token: token({ sub: 'sub-1', nonce: n2, events: DELETED }), nonce: n2 })).status, 401, 'a notice is no sign-in token');
  assert.equal((await post('/api/id/deleted', { token: token({ sub: 'sub-1', aud: 'other-app', events: DELETED }) })).status, 401, 'for another app');
  assert.equal((await fetch(BASE + '/api/me', { headers: { Cookie: reg.cookie } })).status, 200, 'still there');

  // The real notice erases the account; replaying it is refused, and a notice for an unknown identity is fine.
  const notice = token({ sub: 'sub-1', events: DELETED });
  assert.deepEqual((await post('/api/id/deleted', { token: notice })).data, { ok: true });
  assert.equal((await fetch(BASE + '/api/me', { headers: { Cookie: reg.cookie } })).status, 401, 'the session is gone');
  assert.equal((await post('/api/id/deleted', { token: notice })).status, 401, 'a notice is used once');
  assert.equal((await post('/api/id/deleted', { token: token({ sub: 'nobody', events: DELETED }) })).status, 200, 'unknown identities are fine');
  const n3 = randomBytes(16).toString('base64url');
  assert.ok((await post('/api/id/login', { token: token({ sub: 'sub-1', nonce: n3 }), nonce: n3 })).data.setup, 'signing in again starts over');
  console.log('id deleted: ok');
} catch (e) {
  console.log(log);
  throw e;
} finally {
  bored.kill(); idServer.close();
}
