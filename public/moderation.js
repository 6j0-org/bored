// User-controlled moderation: word filters, report thresholds, and the settings for both. Pure: no network, no vault.
// Shared by the browser (public/app.js) and the tests.
//
// Word filters. Text is split into words (letters and digits; everything else is a break), each word lowercased with
// its accents taken off. A term is one word or a phrase of up to MAX_WORDS words, matched whole: "ass" doesn't match
// "class". A term may say a letter can repeat with "*" after it ("so*o" matches "soo" and "soooo"); runs of more than
// MAX_RUN of the same letter count as MAX_RUN, so "sooooo" is matched by the same terms as "sooo". A word ending in
// "s" also matches a term without it (plurals).
//
// The built-in list is David Sojevic's profanity-list (the @dsojevic/profanity-list npm package, MIT), which the
// server serves from node_modules like the other browser packages, so the words aren't in this repository.

const MAX_WORDS = 4, MAX_RUN = 3;

const WORD = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu; // marks: a decomposed accent stays in its word
const capRuns = (w) => w.replace(new RegExp(`(.)\\1{${MAX_RUN},}`, 'gu'), (_, c) => c.repeat(MAX_RUN));
const normalizeWord = (w) => capRuns(w.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase());

// The words in some text, normalized, with where each one is in the original: [{ w, start, end }].
export function words(text) {
  return [...String(text ?? '').matchAll(WORD)].map(m => ({ w: normalizeWord(m[0]), start: m.index, end: m.index + m[0].length }));
}

// A term as typed (words, maybe with "x*" repeats) → every phrase it stands for, normalized the way words() does.
// "x*" means one to MAX_RUN of x. Terms with too many repeats to spell out are skipped.
export function expandTerm(term) {
  const parts = String(term ?? '').toLowerCase().split(/[^\p{L}\p{N}*]+/u).filter(p => p.replace(/\*/g, ''));
  if (!parts.length || parts.length > MAX_WORDS) return [];
  let out = [''];
  for (const [i, part] of parts.entries()) {
    const pieces = [...part.matchAll(/([\p{L}\p{N}])(\*?)/gu)].map(([, c, star]) => star ? [1, 2, 3].map(n => c.repeat(n)) : [c]);
    let forms = [''];
    for (const p of pieces) forms = forms.flatMap(f => p.map(x => f + x));
    out = out.flatMap(o => forms.map(f => (i ? o + ' ' : '') + f));
    if (out.length > 1000) return [];
  }
  return [...new Set(out.map(o => o.split(' ').map(normalizeWord).join(' ')))];
}

// A set of terms to look for: { has(phrase), size }.
function termSet(phrases) {
  const set = new Set(phrases);
  return { has: (p) => set.has(p), size: set.size };
}
// A user's own list: the words they typed, as a term set.
export const ownTerms = (list) => termSet((list || []).flatMap(expandTerm));

// The built-in list, from profanity-list's en.json: [{ match, severity, ... }]. It rates each entry from 1 (mild) to 4
// (severe); the mild ones are left out, since they're everyday words (mild swearing, religious words, and medical
// terms) that would star out ordinary posts. In the list, "|" separates spellings and "x*" means x one or more
// times, the same as in our own terms.
export const MIN_SEVERITY = 2;
export function builtinTerms(entries) {
  const kept = (Array.isArray(entries) ? entries : []).filter(e => e?.severity >= MIN_SEVERITY && typeof e.match === 'string');
  return { entries: kept.length, set: termSet(kept.flatMap(e => e.match.split('|').flatMap(expandTerm))) };
}

// Where any of the term sets matches in the text: [{ start, end }], longest phrase first, no overlaps.
export function findTerms(text, sets) {
  sets = sets.filter(s => s?.size);
  if (!sets.length || !text) return [];
  const ws = words(text), found = [];
  const hit = (p) => sets.some(s => s.has(p));
  for (let i = 0; i < ws.length;) {
    let n = Math.min(MAX_WORDS, ws.length - i);
    for (; n > 0; n--) {
      const phrase = ws.slice(i, i + n).map(x => x.w).join(' ');
      if (hit(phrase) || (phrase.length > 3 && phrase.endsWith('s') && hit(phrase.slice(0, -1)))) break;
    }
    if (n) { found.push({ start: ws[i].start, end: ws[i + n - 1].end }); i += n; } else i++;
  }
  return found;
}
// The text with every match starred out, letter for letter (spaces in a phrase stay).
export function censor(text, sets) {
  const found = findTerms(text, sets);
  if (!found.length) return text;
  let out = '', at = 0;
  for (const { start, end } of found) out += text.slice(at, start) + text.slice(start, end).replace(/[\p{L}\p{N}]\p{M}*/gu, '*'), at = end;
  return out + text.slice(at);
}
export const mentions = (text, sets) => findTerms(text, sets).length > 0;

// ---------- reports ----------
// Anyone signed in can report a public post for one or more reasons, and the server counts, per post, how many
// people reported it for each reason. Each person decides, per reason, how many reports it takes to hide a post from
// them (in Discover and in its discard pile), or turns that reason off.
export const REPORT_REASONS = {
  spam: 'Spam',
  scam: 'Scam or fraud',
  offensive: 'Offensive',
  harassment: 'Harassment or hate',
  unsafe: 'Dangerous or illegal',
};
export const DEFAULT_THRESHOLD = 3, MAX_THRESHOLD = 1000;

// Why a post should be hidden from me by its reports (a reason key), or null. counts: { reason: n }.
export function reportedFor(counts, reports) {
  for (const [reason, n] of Object.entries(counts || {})) {
    const pref = reports[reason];
    if (pref?.on && n >= pref.count) return reason;
  }
  return null;
}
const threshold = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= MAX_THRESHOLD ? n : null; };

// ---------- settings ----------
// Kept in the vault as `moderation` (public/secure.js): what's not saved yet gets the defaults. Everything is on by
// default.
//   builtin:  { on, hide }          the built-in word list; hide: hide whole posts, not just star the words out
//   lists:    [{ id, name, words: [term], on, hide }]   the person's own word lists
//   reports:  { [reason]: { on, count } }               hide posts at least count people reported for reason
//   blocked:  { [key]: { guid?, sign?: { x, y }, name, at } }  key: the GUID, or "k:x.y" for a signing key
//   reported: { [pid]: [reason] }                       what I reported, so the report sheet shows it again
export { threshold as reportThreshold };
export const MAX_LISTS = 20, MAX_LIST_WORDS = 500;
const MAX_TERM = 60;
export function moderationSettings(saved = {}) {
  const s = saved || {};
  const reports = {};
  for (const r of Object.keys(REPORT_REASONS)) {
    const p = s.reports?.[r] || {};
    reports[r] = { on: p.on !== false, count: threshold(p.count) ?? DEFAULT_THRESHOLD };
  }
  return {
    builtin: { on: s.builtin?.on !== false, hide: s.builtin?.hide === true },
    lists: (Array.isArray(s.lists) ? s.lists : []).slice(0, MAX_LISTS).map(l => ({
      id: String(l.id || ''), name: String(l.name || '').slice(0, 60),
      words: parseTerms(Array.isArray(l.words) ? l.words.join('\n') : ''), on: l.on !== false, hide: l.hide === true,
    })),
    reports,
    blocked: s.blocked && typeof s.blocked === 'object' ? s.blocked : {},
    reported: s.reported && typeof s.reported === 'object' ? s.reported : {},
  };
}
// Words typed into a list (one per line, or separated by commas) → a clean list of terms.
export function parseTerms(text) {
  const out = String(text ?? '').split(/[\n,]/).map(t => t.trim().replace(/\s+/g, ' ').slice(0, MAX_TERM)).filter(Boolean);
  return [...new Set(out)].slice(0, MAX_LIST_WORDS);
}
