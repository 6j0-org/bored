// "New posts in Discover" notifications: a round (kill -USR2 runs one now) tells people with notifications on about
// public posts that went up since the last round, but not about their own posts, posts that already ended, or updates
// to old posts, and not people who turned these off. Runs its own demo server, pointed at a stand-in ntfy server.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { listen, startServer } from '../spawn.mjs';

const got = [];
const ntfy = createServer((req, res) => {
  let body = ''; req.on('data', d => body += d);
  req.on('end', () => { got.push(JSON.parse(body)); res.end('{}'); });
});
const NTFY = `http://127.0.0.1:${await listen(ntfy)}`;
const { base: BASE, proc: bored, log } = await startServer({ DEMO: '1', AUTH_MODE: '', NTFY_SERVERS: NTFY, DISCOVER_NEWS_HOURS: '10,16' });
const pause = (ms) => new Promise(r => setTimeout(r, ms));
// Run a round, and return the topics that heard about it.
const round = async () => {
  const before = got.length;
  bored.kill('SIGUSR2');
  await pause(500);
  return got.slice(before).map(m => { assert.equal(m.message, 'New posts in Discover'); assert.equal(m.click, `${BASE}/?open=discover`); return m.topic; }).sort();
};
try {
  process.env.TEST_BASE = BASE;
  const { person } = await import('../lib.mjs');
  const a = await person('news-a'), b = await person('news-b'), c = await person('news-c');
  const fields = { title: 'Board games', details: 'Bring a game', tags: ['games'], cost_amount: 0, cost_currency: 'USD',
    location: '32.715700,-117.161100', location_name: 'Library', online: 0, when_text: '2030-02-01T18:00', max_attendees: 4 };

  // On by default, and the server says how often.
  assert.deepEqual((await a.api('/api/me')).discoverNews, { on: true, perDay: 2 });
  // The demo's own posts went up before anyone here could hear about them.
  await round();

  const topic = async (p) => (await p.api('/api/ntfy', { method: 'POST', body: { server: NTFY } })).topic.topic;
  const ta = await topic(a), tb = await topic(b); // c has no notifications at all

  // Nothing new: nobody hears anything.
  assert.deepEqual(await round(), []);

  // B posts: A hears about it, B (their own post) and C (no notifications) don't. Once only.
  const { post } = await b.mail.savePost({ kind: 'public', fields });
  assert.deepEqual(await round(), [ta]);
  assert.deepEqual(await round(), []);

  // An update to an old post isn't a new post.
  await b.mail.savePost({ pid: post.pid, fields: { ...fields, title: 'Board games night' } });
  assert.deepEqual(await round(), []);

  // A turns them off: nothing; C posts, so B hears about it.
  assert.deepEqual(await a.api('/api/me/discover-news', { method: 'PUT', body: { on: false } }), { discoverNews: { on: false, perDay: 2 } });
  assert.equal((await a.api('/api/me')).discoverNews.on, false);
  await c.mail.savePost({ kind: 'public', fields: { ...fields, details: 'Bring two games' } });
  assert.deepEqual(await round(), [tb]);

  // Back on.
  await a.api('/api/me/discover-news', { method: 'PUT', body: { on: true } });
  await c.mail.savePost({ kind: 'public', fields: { ...fields, details: 'Bring three games' } });
  assert.deepEqual(await round(), [ta, tb].sort());

  await assert.rejects(a.api('/api/me/discover-news', { method: 'PUT', body: { on: 'yes' } }), /Expected/);
  console.log('discover news: ok');
} catch (e) {
  console.log(log());
  throw e;
} finally {
  bored.kill(); ntfy.close();
}
