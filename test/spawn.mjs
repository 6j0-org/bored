// Starting Bored for tests: the shared demo server (test/run.mjs), and servers of their own for tests that need one (a
// database file, another AUTH_MODE, or a stand-in ntfy server). Kept apart from lib.mjs, which reads TEST_BASE as soon
// as it's imported.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const ROOT = new URL('..', import.meta.url).pathname;

// Listen on a free port on 127.0.0.1 and resolve to the port: for stand-in servers, and (closed again) for finding one.
export const listen = (srv) => new Promise((resolve, reject) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)).on('error', reject));

// Start server.js on a free port, with env added to the environment. Resolves once it answers, to { base, proc, log },
// where log() is everything it has printed; rejects with that output if it exits or doesn't answer within 10 seconds.
export async function startServer(env = {}) {
  const probe = createServer(), port = await listen(probe);
  await new Promise(r => probe.close(r));
  const base = `http://127.0.0.1:${port}`;
  let out = '';
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(port), ...env } });
  proc.stdout.on('data', d => out += d); proc.stderr.on('data', d => out += d);
  for (let i = 0; i < 100 && proc.exitCode === null; i++) {
    try { if ((await fetch(base + '/api/config')).ok) return { base, proc, log: () => out }; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error(`The server did not start:\n${out}`);
}
