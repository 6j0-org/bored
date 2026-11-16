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

// Human label, e.g. "Fri, Nov 20, 6:30 PM" or "Every Wednesday, 6:30 PM (from Nov 18)". Anything else is returned as-is.
// today: "YYYY-MM-DD" in the viewer's (or host's) zone, to decide whether to say the year / "from".
export function whenLabel(s, { locale, today } = {}) {
  const w = parseWhen(s);
  if (!w) return s ?? '';
  const fmt = (o) => w.date.toLocaleString(locale, { timeZone: 'UTC', ...o });
  const thisYear = today ? today.slice(0, 4) : String(new Date().getFullYear());
  const year = w.start.slice(0, 4) !== thisYear ? { year: 'numeric' } : {};
  const time = fmt({ hour: 'numeric', minute: '2-digit' });
  if (!w.rule) return fmt({ weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...year });
  const from = today && w.start.slice(0, 10) > today ? ` (from ${fmt({ month: 'short', day: 'numeric', ...year })})` : '';
  return `${w.repeat.label}, ${time}${from}`;
}

// Local "YYYY-MM-DD" for whenLabel's `today`.
export const localToday = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
