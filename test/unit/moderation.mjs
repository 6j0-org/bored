// Word filters, report thresholds, and moderation settings (public/moderation.js), with harmless stand-in words.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  words, expandTerm, ownTerms, findTerms, censor, mentions, reportedFor, moderationSettings, builtinTerms,
  parseTerms, reportThreshold, REPORT_REASONS, DEFAULT_THRESHOLD, MAX_LIST_WORDS, MIN_SEVERITY,
} from '../../public/moderation.js';

// Words: letters and digits, lowercased, accents off, with their place in the original.
assert.deepEqual(words('Hi, Café-time!').map(w => w.w), ['hi', 'cafe', 'time']);
assert.deepEqual(words('a b').map(({ start, end }) => [start, end]), [[0, 1], [2, 3]]);
assert.deepEqual(words('café ok').map(w => w.w), ['cafe', 'ok'], 'a decomposed accent stays in its word');
assert.deepEqual(words('soooooo').map(w => w.w), ['sooo'], 'long runs count as three');

// Terms: "x*" repeats, phrases, and normalizing.
assert.deepEqual(expandTerm('so*o').sort(), ['soo', 'sooo'], 'so*o: s, one to three o, then o (capped at three)');
assert.deepEqual(expandTerm('Ice  Cream'), ['ice cream']);
assert.deepEqual(expandTerm('a b c d e'), [], 'too many words');
assert.deepEqual(expandTerm('  '), []);

const fruit = ownTerms(['banana', 'ice cream', 'co*ol']);
// Whole words only.
assert.equal(mentions('I like bananas', [fruit]), true, 'plural');
assert.equal(mentions('BANANA!', [fruit]), true, 'any case');
assert.equal(mentions('bandana', [fruit]), false);
assert.equal(mentions('superbanana', [fruit]), false, 'not inside other words');
// Phrases, across any punctuation or spacing.
assert.equal(mentions('free ice-cream today', [fruit]), true);
assert.equal(mentions('ice and cream', [fruit]), false);
// Repeats only where the term allows them.
assert.equal(mentions('so coooooool', [fruit]), true);
assert.equal(mentions('bannnana', [fruit]), false);

// Censoring stars out letters, keeps everything else, and leaves clean text alone.
assert.equal(censor('Banana split, ice cream!', [fruit]), '****** split, *** *****!');
assert.equal(censor('nothing here', [fruit]), 'nothing here');
assert.deepEqual(findTerms('banana', []), []);
assert.equal(censor('', [fruit]), '');

// The built-in list (the npm package the server serves): only entries of MIN_SEVERITY or more, every spelling
// found, and ordinary text left alone. The test never prints a word from it.
const list = JSON.parse(readFileSync(new URL('../../node_modules/@dsojevic/profanity-list/en.json', import.meta.url), 'utf8'));
const builtin = builtinTerms(list);
const kept = list.filter(e => e.severity >= MIN_SEVERITY);
assert.equal(builtin.entries, kept.length);
assert.ok(builtin.entries > 300 && builtin.entries < list.length, 'the mild entries are left out');
const missed = kept.flatMap(e => e.match.split('|')).filter(v => findTerms(`xx ${v.replace(/\*/g, '')} yy`, [builtin.set]).length !== 1);
assert.equal(missed.length, 0, `${missed.length} spellings on the list aren't found`);
const mild = list.filter(e => e.severity < MIN_SEVERITY && !e.match.includes('*') && !e.match.includes('|'));
assert.ok(mild.some(e => !mentions(e.match, [builtin.set])), 'mild entries are not matched');
assert.equal(builtinTerms(null).set.size, 0);
const ordinary = 'Pickup basketball at the park, then tacos. Bring water, sunscreen, and a friend! Gay pride picnic; ' +
  'queer book club; trans support group; Jewish deli; church bake sale; class at Scunthorpe; assessing the cocktail menu.';
assert.deepEqual(findTerms(ordinary, [builtin.set]), [], 'ordinary words and identity words are not on the list');

// Settings: everything on by default; bad values fall back to defaults.
const d = moderationSettings();
assert.deepEqual(d.builtin, { on: true, hide: false });
assert.deepEqual(Object.keys(d.reports), Object.keys(REPORT_REASONS));
assert.ok(Object.values(d.reports).every(r => r.on && r.count === DEFAULT_THRESHOLD));
assert.equal(DEFAULT_THRESHOLD, 3);
const s = moderationSettings({ builtin: { on: false }, reports: { spam: { on: false, count: 25 }, scam: { count: 0 }, offensive: { count: 2.5 } },
  lists: [{ id: 'a', name: 'x', words: ['A', 'a ', 'b'], hide: true }] });
assert.equal(s.builtin.on, false);
assert.deepEqual(s.reports.spam, { on: false, count: 25 });
assert.deepEqual(s.reports.scam, { on: true, count: DEFAULT_THRESHOLD }, 'zero falls back to the default');
assert.deepEqual(s.reports.offensive, { on: true, count: DEFAULT_THRESHOLD }, 'whole numbers only');
assert.equal(reportThreshold('7'), 7); assert.equal(reportThreshold('-1'), null); assert.equal(reportThreshold('x'), null);
assert.deepEqual(s.lists[0].words, ['A', 'a', 'b']);
assert.equal(s.lists[0].on, true); assert.equal(s.lists[0].hide, true);

// Typing a list: lines or commas, trimmed, no repeats, capped.
assert.deepEqual(parseTerms(' one,two\n\n two , three  four '), ['one', 'two', 'three four']);
assert.equal(parseTerms(Array.from({ length: 900 }, (_, i) => `w${i}`).join(',')).length, MAX_LIST_WORDS);

// Report thresholds: hide once at least that many people reported it for a reason that's on.
const prefs = moderationSettings().reports;
assert.equal(reportedFor(null, prefs), null);
assert.equal(reportedFor({ spam: 2 }, prefs), null, 'two reports are under the default of three');
assert.equal(reportedFor({ spam: 3 }, prefs), 'spam');
assert.equal(reportedFor({ spam: 1, scam: 4 }, prefs), 'scam');
const off = moderationSettings({ reports: { spam: { on: false } } }).reports;
assert.equal(reportedFor({ spam: 50 }, off), null, 'a reason turned off never hides');
const strict = moderationSettings({ reports: { offensive: { count: 1 } } }).reports;
assert.equal(reportedFor({ offensive: 1 }, strict), 'offensive');
assert.equal(reportedFor({ bogus: 9 }, prefs), null, 'unknown reasons are ignored');

console.log('moderation ok');
