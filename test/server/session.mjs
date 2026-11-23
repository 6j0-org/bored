// Sessions last 30 days from when they were last used: a session last renewed over a day ago gets a fresh cookie and
// a new seen_at, a recent one isn't touched, and one unused for 30 days stops working and is deleted. Runs its own
// server on a database file (the shared test server keeps its database in memory), with sessions put in directly.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { TMP, wait } from '../lib.mjs';

const probe = createServer();
const port = await new Promise(r => probe.listen(0, '127.0.0.1', () => r(probe.address().port)));
await new Promise(r => probe.close(r));
const BASE = `http://127.0.0.1:${port}`, DB_PATH = join(TMP, `session-${port}.sqlite`);
const server = spawn(process.execPath, ['server.js'], {
  cwd: new URL('../..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, DEMO: '', AUTH_MODE: '', PORT: String(port), DB_PATH, FEEDBACK_PATH: join(TMP, `session-${port}.jsonl`) },
});
let log = ''; server.stdout.on('data', d => log += d); server.stderr.on('data', d => log += d);
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/config')).ok) break; } catch {} await wait(100); }
  const db = new DatabaseSync(DB_PATH);
  const userId = db.prepare('INSERT INTO users (guid) VALUES (?)').run(crypto.randomUUID()).lastInsertRowid;
  const session = (ago) => {
    const token = randomBytes(24).toString('hex');
    db.prepare(`INSERT INTO sessions (token, user_id, seen_at) VALUES (?, ?, datetime('now', ?))`).run(token, userId, ago);
    return token;
  };
  const me = (token) => fetch(BASE + '/api/me', { headers: { Cookie: `sid=${token}` } });
  const seen = (token) => db.prepare('SELECT seen_at FROM sessions WHERE token = ?').get(token)?.seen_at;

  // Used an hour ago: works, no new cookie.
  const fresh = session('-1 hour'), before = seen(fresh);
  let r = await me(fresh);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('set-cookie'), null, 'not renewed again within a day');
  assert.equal(seen(fresh), before);

  // Last renewed 20 days ago: works, and the cookie and seen_at are renewed for another 30 days.
  const old = session('-20 days');
  r = await me(old);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie') || '', new RegExp(`^sid=${old}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`));
  assert.ok(db.prepare(`SELECT seen_at > datetime('now', '-1 minute') AS now FROM sessions WHERE token = ?`).get(old).now, 'seen_at is now');

  // Unused for 31 days: signed out, and the session is gone.
  const stale = session('-31 days');
  assert.equal((await me(stale)).status, 401);
  assert.equal(seen(stale), undefined, 'deleted');

  // Signing out still clears the cookie, even on a session due for renewal.
  const out = session('-2 days');
  r = await fetch(BASE + '/api/logout', { method: 'POST', headers: { Cookie: `sid=${out}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.match(r.headers.get('set-cookie') || '', /^sid=; .*Max-Age=0/);
  console.log('session: ok');
} catch (e) {
  console.log(log);
  throw e;
} finally {
  server.kill();
}
