// Event times ("When"), shared by the server (validation, change notices) and the browser (picker, labels).
//
// Stored as the host's local wall-clock time with no time zone (events are local), "YYYY-MM-DDTHH:MM", which is the
// first (or only) occurrence. A repeat rule in iCalendar RRULE syntax may follow, chosen from a fixed menu that
// depends on that first date (see repeatOptions):
//   2026-11-20T18:30                                  once
//   2026-11-20T18:30;FREQ=DAILY                       every day
//   2026-11-18T18:30;FREQ=WEEKLY;BYDAY=WE             every Wednesday
//   2026-11-18T18:30;FREQ=WEEKLY;INTERVAL=2;BYDAY=WE  every other Wednesday
//   2026-12-01T18:30;FREQ=MONTHLY;BYMONTHDAY=1        the 1st of every month
//   2026-11-14T10:00;FREQ=MONTHLY;BYDAY=2SA           the 2nd Saturday of every month
//   2026-11-28T10:00;FREQ=MONTHLY;BYDAY=-1SA          the last Saturday of every month
// All date math uses UTC Dates as plain wall-clock values, so DST and the viewer's zone never shift anything.
//
// An optional end (end_text on a post) is stored the same way, "YYYY-MM-DDTHH:MM": when the first occurrence ends.
// It comes after the start and at most MAX_EVENT_DAYS later; repeats each last as long as the first one.

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ordinal = (n) => n + ((n % 100 >= 11 && n % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'));
const START_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

// "YYYY-MM-DDTHH:MM" → UTC Date with those wall-clock fields, or null if it isn't a real date and time.
function wallDate(start) {
  const m = START_RE.exec(start || '');
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d && h < 24 && mi < 60 ? date : null;
}

// The repeat choices that make sense for a first occurrence: [{ kind, rule, label }]. kind is stable across dates
// (so the form can keep "monthly on the Nth weekday" when the date changes); rule is the RRULE ('' = once).
export function repeatOptions(start) {
  const date = wallDate(start);
  const opts = [{ kind: 'once', rule: '', label: 'Does not repeat' }];
  if (!date) return opts;
  const dow = date.getUTCDay(), dom = date.getUTCDate(), day = DAY_NAMES[dow];
  const nth = Math.ceil(dom / 7);
  const monthDays = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  opts.push(
    { kind: 'daily', rule: 'FREQ=DAILY', label: 'Every day' },
    { kind: 'weekly', rule: `FREQ=WEEKLY;BYDAY=${DAYS[dow]}`, label: `Every ${day}` },
    { kind: 'biweekly', rule: `FREQ=WEEKLY;INTERVAL=2;BYDAY=${DAYS[dow]}`, label: `Every other ${day}` },
    { kind: 'monthday', rule: `FREQ=MONTHLY;BYMONTHDAY=${dom}`, label: `The ${ordinal(dom)} of every month` },
  );
  if (nth <= 4) opts.push({ kind: 'nthday', rule: `FREQ=MONTHLY;BYDAY=${nth}${DAYS[dow]}`, label: `The ${ordinal(nth)} ${day} of every month` });
  if (dom + 7 > monthDays) opts.push({ kind: 'lastday', rule: `FREQ=MONTHLY;BYDAY=-1${DAYS[dow]}`, label: `The last ${day} of every month` });
  return opts;
}

// Stored value → { start, rule, date, repeat } (repeat: the matching repeatOptions entry), or null if invalid.
export function parseWhen(s) {
  const [start, ...rest] = String(s ?? '').trim().split(';');
  const date = wallDate(start);
  if (!date) return null;
  const rule = rest.join(';');
  const repeat = repeatOptions(start).find(o => o.rule === rule);
  return repeat ? { start, rule, date, repeat } : null;
}

// A start ("YYYY-MM-DDTHH:MM", seconds tolerated) and a rule from repeatOptions → the stored value, or null if invalid.
export function composeWhen(start, rule = '') {
  const s = String(start ?? '').trim().replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}):\d{2}(\.\d+)?$/, '$1');
  return parseWhen(rule ? `${s};${rule}` : s) ? (rule ? `${s};${rule}` : s) : null;
}

const MAX_EVENT_DAYS = 14;
const MINUTE = 60000, DAY = 86400000;
const trimSeconds = (v) => String(v ?? '').trim().replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}):\d{2}(\.\d+)?$/, '$1');
const wallString = (d) => d.toISOString().slice(0, 16);

// The end for a stored when value → { end, date } (end: "YYYY-MM-DDTHH:MM"), or null if missing or invalid.
export function parseEnd(s, end) {
  const w = parseWhen(s), date = wallDate(trimSeconds(end));
  return w && date && date > w.date && date - w.date <= MAX_EVENT_DAYS * DAY ? { end: wallString(date), date } : null;
}

// A stored when value and an end from the form → the stored end ('' for none), or throws an Error saying what's wrong.
export function composeEnd(s, end) {
  const e = trimSeconds(end);
  if (!e) return '';
  const w = parseWhen(s);
  if (!w) throw new Error('Pick a start time before an end time');
  const date = wallDate(e);
  if (!date) throw new Error('Ends must be a date and time');
  if (date <= w.date) throw new Error('Ends must be after the start');
  if (date - w.date > MAX_EVENT_DAYS * DAY) throw new Error(`Ends must be within ${MAX_EVENT_DAYS} days of the start`);
  return wallString(date);
}

// The start moved from `before` to `after` ("YYYY-MM-DDTHH:MM"): the end moved with it, so the length stays the
// same. The end unchanged if either start isn't valid.
export function shiftEnd(before, after, end) {
  const a = wallDate(trimSeconds(before)), b = wallDate(trimSeconds(after)), e = wallDate(trimSeconds(end));
  return a && b && e ? wallString(new Date(e.getTime() + (b - a))) : end;
}

// Human label, e.g. "Fri, Nov 20, 6:30 PM" or "Every Wednesday, 6:30 PM (from Nov 18)", with the end when there is
// one: "Fri, Nov 20, 6:30 – 9:00 PM", "Every Wednesday, 6:30 – 9:00 PM". Anything else is returned as-is.
// today: "YYYY-MM-DD" in the viewer's (or host's) zone, to decide whether to say the year / "from".
export function whenLabel(s, { locale, today, end } = {}) {
  const w = parseWhen(s);
  if (!w) return s ?? '';
  const e = parseEnd(s, end);
  const fmt = (o) => w.date.toLocaleString(locale, { timeZone: 'UTC', ...o });
  const range = (o) => new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...o }).formatRange(w.date, e.date);
  const thisYear = today ? today.slice(0, 4) : String(new Date().getFullYear());
  const year = w.start.slice(0, 4) !== thisYear || (e && e.end.slice(0, 4) !== thisYear) ? { year: 'numeric' } : {};
  const clock = { hour: 'numeric', minute: '2-digit' };
  if (!w.rule) return (e ? range : fmt)({ weekday: 'short', month: 'short', day: 'numeric', ...clock, ...year });
  // A repeat that ends on a later day says how many days later.
  const days = e ? Math.round((Date.UTC(e.date.getUTCFullYear(), e.date.getUTCMonth(), e.date.getUTCDate())
    - Date.UTC(w.date.getUTCFullYear(), w.date.getUTCMonth(), w.date.getUTCDate())) / DAY) : 0;
  const time = !e ? fmt(clock)
    : !days ? range(clock)
    : `${fmt(clock)} – ${e.date.toLocaleString(locale, { timeZone: 'UTC', ...clock })} ${days === 1 ? 'the next day' : `${days} days later`}`;
  const from = today && w.start.slice(0, 10) > today ? ` (from ${fmt({ month: 'short', day: 'numeric', ...year })})` : '';
  return `${w.repeat.label}, ${time}${from}`;
}

// Local "YYYY-MM-DD" for whenLabel's `today`.
export const localToday = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Does the event happen on any day from `from` to `to` ("YYYY-MM-DD", inclusive)? Repeats count on each day they
// recur, and an event with an end (see parseEnd) counts on every day it runs into (a minute past midnight counts;
// ending at midnight doesn't). Invalid values and invalid ranges are false.
export function occursBetween(s, from, to, end) {
  const w = parseWhen(s);
  const a = wallDate(`${from}T00:00`), b = wallDate(`${to}T00:00`);
  if (!w || !a || !b || b < a) return false;
  const first = new Date(Date.UTC(w.date.getUTCFullYear(), w.date.getUTCMonth(), w.date.getUTCDate()));
  const e = parseEnd(s, end);
  // How many days after its start day an occurrence still runs: start days that many days before the range count.
  const span = e ? Math.floor((e.date.getTime() - MINUTE - first.getTime()) / DAY) : 0;
  const dow = first.getUTCDay(), dom = first.getUTCDate(), nth = Math.ceil(dom / 7);
  const on = (d) => {
    if (d < first) return false;
    const sameDow = d.getUTCDay() === dow, dDom = d.getUTCDate();
    switch (w.repeat.kind) {
      case 'once': return d.getTime() === first.getTime();
      case 'daily': return true;
      case 'weekly': return sameDow;
      case 'biweekly': return sameDow && Math.round((d - first) / DAY / 7) % 2 === 0;
      case 'monthday': return dDom === dom;
      case 'nthday': return sameDow && Math.ceil(dDom / 7) === nth;
      case 'lastday': return sameDow && dDom + 7 > new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      default: return false;
    }
  };
  // Walk the days of the range (capped at a year), from the first occurrence on.
  const start = Math.max(a.getTime() - span * DAY, first.getTime()), last = Math.min(b.getTime(), start + 366 * DAY);
  for (let t = start; t <= last; t += DAY) if (on(new Date(t))) return true;
  return false;
}

// When the sun sets at a place on a date ("YYYY-MM-DD", the place's local date), as a ms timestamp, or null if it
// doesn't set or rise that day (near the poles). The standard sunrise equation (the U.S. Naval Observatory's
// "Almanac for Computers"), good to a minute or two: plenty for "ends at sunset".
export function sunsetAt(ymd, lat, lon) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  if (!m || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const [y, mo, d] = m.slice(1).map(Number);
  const rad = Math.PI / 180, deg = 180 / Math.PI, mod = (x, n) => ((x % n) + n) % n;
  const day0 = Date.UTC(y, mo - 1, d), n = Math.round((day0 - Date.UTC(y, 0, 0)) / DAY);
  const lngHour = lon / 15, t = n + (18 - lngHour) / 24;
  const M = 0.9856 * t - 3.289;
  const L = mod(M + 1.916 * Math.sin(M * rad) + 0.020 * Math.sin(2 * M * rad) + 282.634, 360);
  let RA = mod(Math.atan(0.91764 * Math.tan(L * rad)) * deg, 360);
  RA = (RA + Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90) / 15;
  const sinDec = 0.39782 * Math.sin(L * rad), cosDec = Math.cos(Math.asin(sinDec));
  const cosH = (Math.cos(90.833 * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad));
  if (cosH < -1 || cosH > 1) return null;
  const T = Math.acos(cosH) * deg / 15 + RA - 0.06571 * t - 6.622;
  let at = day0 + mod(T - lngHour, 24) * 3600e3;
  // The sunset after that date's solar noon, not the one a day before or after.
  const noon = day0 + (12 - lngHour) * 3600e3;
  while (at < noon) at += DAY;
  while (at > noon + DAY / 2) at -= DAY;
  return Math.round(at / 60e3) * 60e3;
}

