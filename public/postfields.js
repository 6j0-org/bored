// A post's fields: checking what the post form sends, and what changed between two versions.
// Encrypted posts never reach the server as plaintext, so the browser checks them, with the same rules the server
// uses for the posts it still stores (eventFields in server.js).
import { composeWhen, composeEnd } from './when.js';
import { parseCost } from './cost.js';

export const MAX_TAGS = 5, MAX_ATTENDEES_LIMIT = 500; // the same as db.js
const MAX_TAG_LENGTH = 24;

export const normalizeTag = (raw) => String(raw ?? '').toLowerCase().trim().replace(/^#+/, '')
  .replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, MAX_TAG_LENGTH);
const parseTags = (input) =>
  [...new Set((Array.isArray(input) ? input : String(input ?? '').split(',')).map(normalizeTag).filter(Boolean))];

const fail = (message) => { throw new Error(message); };
function str(v, max, field, required = false) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) fail(`${field} is required`);
  if (s.length > max) fail(`${field} is too long (max ${max})`);
  return s;
}
function location(v) {
  const s = str(v, 100, 'Location');
  if (!s) return s;
  const m = /^(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/.exec(s);
  const lat = m && Number(m[1]), lon = m && Number(m[2]);
  if (!m || Math.abs(lat) > 90 || Math.abs(lon) > 180) fail('Where must be "latitude,longitude", e.g. 32.719649,-117.220272, or picked on the map');
  return `${lat.toFixed(6)},${lon.toFixed(6)}`;
}
function when(start, repeat) {
  const s = str(start, 100, 'Starts'), rule = str(repeat, 100, 'Repeats');
  if (!s) return s;
  return composeWhen(s, rule) ?? fail(rule ? "That repeat doesn't fit the date picked" : 'Starts must be a date and time');
}
function maxAttendees(v, min = 1) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_ATTENDEES_LIMIT)
    fail(`Max attendees must be a whole number from 1 to ${MAX_ATTENDEES_LIMIT}, or blank for no limit`);
  if (n < min) fail(`${min} ${min === 1 ? 'person has' : 'people have'} already matched, so max attendees can't be less than that`);
  return n;
}

// Post form values → the post's fields, or throws an Error saying what's wrong. matched: people already in, the
// lowest max attendees allowed. The personal info check (public/pii.js, with its phone number data) loads when needed.
export async function postFields(body, { matched = 0 } = {}) {
  const cost = parseCost(body.cost_amount, body.cost_currency);
  if (cost.error) fail(cost.error);
  const tags = parseTags(body.tags);
  if (tags.length > MAX_TAGS) fail(`Up to ${MAX_TAGS} tags, please`);
  const f = {
    title: str(body.title, 100, 'Title', true),
    details: str(body.details, 1000, 'Details'),
    tags,
    cost_amount: cost.amount,
    cost_currency: cost.currency,
    location: location(body.location),
    location_name: str(body.location_name, 100, 'Where'),
    online: [1, 2].includes(Number(body.online)) ? Number(body.online) : 0, // 0 in person, 1 online, 2 both
    when_text: when(body.when_text, body.when_repeat),
    max_attendees: maxAttendees(body.max_attendees, Math.max(1, matched)),
  };
  f.end_text = composeEnd(f.when_text, str(body.end_text, 100, 'Ends')); // optional: '' for none
  if (f.online === 1) { f.location = ''; f.location_name = ''; } // an online-only post has no place
  // No contact info or ID numbers: people share contact info in chat after they match.
  const { piiProblems } = await import('./pii.js');
  const check = (field, text, options) => { const { error } = piiProblems(field, text, options); if (error) fail(error); };
  check('Title', f.title); check('Details', f.details, { instagramPosts: true }); check('Place', f.location_name, { addresses: false });
  f.tags.forEach(tag => check('Tags', tag));
  return f;
}

// What attendees are asked to re-confirm after: the fields that changed, by key, with labels to show.
export const FIELD_LABELS = { title: 'Title', details: 'Details', tags: 'Tags', location: 'Where', when_text: 'When', cost: 'Cost', max_attendees: 'Max attendees' };
const fieldValue = (p, k) => k === 'cost' ? [p.cost_amount, p.cost_currency]
  : k === 'when_text' ? [p.when_text, p.end_text || ''] // posts from before end times have none
  : k === 'location' ? [p.location, p.location_name, p.online] : p[k];
export const changedFields = (before, after) =>
  Object.keys(FIELD_LABELS).filter(k => JSON.stringify(fieldValue(before, k) ?? null) !== JSON.stringify(fieldValue(after, k) ?? null));
