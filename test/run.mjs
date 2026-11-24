// Runs the tests: node test/run.mjs [unit|server|browser ...]
//
// - unit: the crypto and the request rules, with no server (test/unit).
// - server: real accounts in Node against a demo-mode server on a free port (test/server).
// - browser: the real UI in headless Chromium against the same server (test/browser). Skipped when no Chrome or
//   Chromium is found, unless TEST_BROWSER=1 (CI sets it), which makes a missing browser a failure.
//
// Each test is its own process and fails by exiting nonzero. The demo server keeps everything in memory, so nothing
// is left behind; tests that share it only look at their own posts.
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome } from './lib.mjs';
import { startServer } from './spawn.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const SUITES = ['unit', 'server', 'browser'];
const asked = process.argv.slice(2);
const bad = asked.filter(s => !SUITES.includes(s));
if (bad.length) { console.error(`Unknown suite: ${bad.join(', ')} (use ${SUITES.join(', ')})`); process.exit(2); }
const suites = asked.length ? asked : SUITES;
const files = (suite) => readdirSync(join(ROOT, 'test', suite)).filter(f => f.endsWith('.mjs')).sort().map(f => join('test', suite, f));

const TMP = mkdtempSync(join(tmpdir(), 'bored-test-'));

function run(file, env = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    const p = spawn(process.execPath, [file], { cwd: ROOT, env: { ...process.env, TEST_TMP: TMP, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    const timer = setTimeout(() => { out += '\n(timed out after 180 s)'; p.kill(); }, 180_000);
    p.on('close', code => {
      clearTimeout(timer);
      const ok = code === 0, secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`${ok ? 'pass' : 'FAIL'}  ${file}  (${secs} s)`);
      if (!ok || process.env.TEST_VERBOSE) console.log(out.trimEnd().replace(/^/gm, '      '));
      resolve(ok);
    });
  });
}

let server = null;
async function startDemo() {
  // NTFY_SERVERS: nothing listens there, so tests never publish to a real ntfy server.
  try { server = await startServer({ DEMO: '1', AUTH_MODE: '', NTFY_SERVERS: 'http://127.0.0.1:9' }); }
  catch (e) { console.error(e.message); process.exit(1); }
}

const results = [];
try {
  for (const suite of suites) {
    if (suite === 'browser' && !findChrome()) {
      if (/^(1|true|yes)$/i.test(process.env.TEST_BROWSER || '')) { console.log('FAIL  browser: no Chrome or Chromium found (set CHROME_BIN)'); results.push(false); }
      else console.log('skip  browser: no Chrome or Chromium found (set CHROME_BIN to run these)');
      continue;
    }
    if (suite !== 'unit' && !server) await startDemo();
    for (const f of files(suite)) results.push(await run(f, suite === 'unit' ? {} : { TEST_BASE: server.base }));
  }
} finally {
  server?.proc.kill();
  // Chromium can still be writing to its profile as it exits.
  try { rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
}
const failed = results.filter(ok => !ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
