// "Add to calendar": an iCalendar file (RFC 5545, .ics) for one post. It's the format every major calendar app
// imports (Apple, Google, Outlook, Thunderbird…); opening the downloaded file hands it to the default one.
import { parseWhen } from './when.js';

// Text values escape backslash, semicolon, comma and newlines.
const text = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// Lines are at most 75 octets; longer ones continue on the next line after a space.
function fold(line) {
  const enc = new TextEncoder(), out = [];
  let cur = '', n = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (n + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; n = 0; }
    cur += ch; n += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, ''); // 20261115T203000Z

// e: { id, title, details?, location? ("lat,lon"), location_name?, online? (0 in person, 1 online, 2 both), when_text }. Returns the file's text, or null without a valid time.
// Times are "floating" (no zone), like the post itself: 6:30 PM wherever you are. Posts have no end time, so the
// calendar entry gets an hour.
export function icsFor(e, { origin = location.origin } = {}) {
  const w = parseWhen(e.when_text);
  if (!w) return null;
  const geo = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(e.location || '');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Bored?//Bored?//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:event-${e.id}@${new URL(origin).host}`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${w.start.replace(/[-:]/g, '')}00`,
    'DURATION:PT1H',
    ...(w.rule ? [`RRULE:${w.rule}`] : []),
    `SUMMARY:${text(e.title)}`,
    ...(e.details ? [`DESCRIPTION:${text(e.details)}`] : []),
    ...(e.online === 1 ? ['LOCATION:Online'] : []),
    ...(e.online !== 1 && (e.location_name || geo)
      ? [`LOCATION:${text((e.location_name || `${geo[1]},${geo[2]}`) + (e.online === 2 ? ' and online' : ''))}`]
      : e.online === 2 ? ['LOCATION:In person and online'] : []),
    ...(geo ? [`GEO:${geo[1]};${geo[2]}`] : []),
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

// Download the post's .ics; the browser or OS offers to open it in the default calendar app.
export function addToCalendar(e) {
  const ics = icsFor(e);
  if (!ics) return false;
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), {
    href: url, download: `${(e.title || 'event').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'event'}.ics`,
  });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return true;
}
