// Shared helpers for the server and browser tests. test/run.mjs starts a demo-mode server and passes its address in
// TEST_BASE, and a scratch directory in TEST_TMP.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const BASE = process.env.TEST_BASE || 'http://localhost:3000';
export const TMP = process.env.TEST_TMP || mkdtempSync(join(tmpdir(), 'bored-test-'));
export const PUBLIC = new URL('../public/', import.meta.url).pathname;
export const wait = (ms) => new Promise(r => setTimeout(r, ms));

// The app's modules call fetch('/api/...'); in Node, send those to the test server.
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => realFetch(String(url).startsWith('/') ? BASE + url : url, opts);
export { realFetch };

// An API client with its own cookie, the shape secure.js and mail.js expect. credentials: 'omit' leaves the cookie off.
export function client() {
  let cookie = '';
  return async function api(path, { method = 'GET', body, credentials } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (cookie && credentials !== 'omit') headers.Cookie = cookie;
    const res = await realFetch(BASE + path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status });
    return data;
  };
}

// A separate copy of public/ for each person, so each gets its own module state (keys, vault, and mail), as two
// browsers would.
export async function copyApp(name) {
  const dir = join(TMP, 'people', name);
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  cpSync(PUBLIC, dir, { recursive: true });
  return { sec: await import(`${dir}/secure.js`), mail: await import(`${dir}/mail.js`), api: client() };
}

// A signed-in demo account with keys, ready to send and read mail.
export async function person(name) {
  const p = await copyApp(name);
  await p.sec.createDemoAccount(p.api); await p.sec.vault.load(p.api); await p.sec.ensureKeys(p.api);
  p.mail.initMail(p.api);
  return { name, ...p, guid: p.sec.myPublicKeys().guid };
}

// ---------- headless Chromium over the DevTools protocol ----------
export function findChrome() {
  const names = [process.env.CHROME_BIN, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return names.find(p => p && existsSync(p)) || null;
}

// Page errors and console errors or warnings from every browser opened, for the test to report at the end.
const pageErrors = [];

// Opens `path` in a new headless browser with its own profile, and waits for the tab bar.
export async function browser(name, path = '/') {
  const chrome = findChrome();
  if (!chrome) throw new Error('No Chrome or Chromium found; set CHROME_BIN');
  const profile = mkdtempSync(join(TMP, `chrome-${name}-`));
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    '--disable-dev-shm-usage', 'about:blank']; // containers often have a tiny /dev/shm
  // Containers usually run as root, where Chromium refuses to start sandboxed.
  if (process.getuid?.() === 0) args.unshift('--no-sandbox');
  const proc = spawn(chrome, args, { stdio: 'ignore' });
  let port;
  for (let i = 0; i < 200 && !port; i++) {
    await wait(100);
    if (existsSync(`${profile}/DevToolsActivePort`)) port = readFileSync(`${profile}/DevToolsActivePort`, 'utf8').split('\n')[0];
  }
  if (!port) { proc.kill(); throw new Error(`${name}: Chromium didn't start`); }
  const targets = await (await realFetch(`http://127.0.0.1:${port}/json`)).json();
  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let seq = 0; const pending = new Map();
  let self = null; // the returned object: its onEvent(message), if set, sees every DevTools event
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method) self?.onEvent?.(m);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(`${name}: ` + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) pageErrors.push(`${name} console.${m.params.type}: ` + m.params.args.map(a => a.value ?? a.description).join(' '));
  };
  const send = (method, params = {}) => new Promise(r => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description; };
  await send('Runtime.enable'); await send('Page.enable');
  const until = async (expr, ms = 20000) => { for (let t = 0; t < ms; t += 250) { if (await ev(expr)) return true; await wait(250); } throw new Error(`${name} timed out: ${expr}`); };
  const ready = () => until(`document.querySelector('nav.tabs button[data-tab=discover]')`);
  await send('Page.navigate', { url: `${BASE}${path}` });
  await ready();
  const tab = async (id) => { await ev(`document.querySelector('nav.tabs button[data-tab=${id}]').click()`); await wait(1200); };
  const text = () => ev(`document.getElementById('view').innerText.replace(/\\s+/g, ' ')`);
  const reload = async () => { await send('Page.reload'); await ready(); await wait(1500); };
  return self = { name, send, ev, until, tab, text, reload, onEvent: null, close: () => { ws.close(); proc.kill(); } };
}

// Prints the page errors and exits: 1 if there were any.
export function finish(label) {
  if (pageErrors.length) { console.log(`${label}: page errors:\n` + pageErrors.join('\n')); process.exit(1); }
  console.log(`${label}: ok`);
  process.exit(0);
}
