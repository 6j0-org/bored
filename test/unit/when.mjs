import assert from 'node:assert/strict';
import { parseEnd, composeEnd, shiftEnd, whenLabel, occursBetween, sunsetAt } from '../../public/when.js';
import { icsFor } from '../../public/ics.js';

const opts = { locale: 'en-US', today: '2026-11-21' };

// composeEnd: optional, after the start, within 14 days; seconds are dropped.
assert.equal(composeEnd('2026-11-27T18:30', ''), '');
assert.equal(composeEnd('2026-11-27T18:30', '2026-11-27T21:00:00'), '2026-11-27T21:00');
assert.throws(() => composeEnd('', '2026-11-27T21:00'), /start time before an end/);
assert.throws(() => composeEnd('2026-11-27T18:30', '2026-11-27T18:30'), /after the start/);
assert.throws(() => composeEnd('2026-11-27T18:30', '2026-12-12T18:30'), /within 14 days/);
assert.throws(() => composeEnd('2026-11-27T18:30', 'tomorrow'), /date and time/);
assert.equal(parseEnd('2026-11-27T18:30', '2026-11-27T12:00'), null, 'an end before the start is ignored');

// shiftEnd: moving the start keeps the length.
assert.equal(shiftEnd('2026-11-27T18:30', '2026-11-28T20:00', '2026-11-27T21:00'), '2026-11-28T22:30');
assert.equal(shiftEnd('', '2026-11-28T20:00', '2026-11-27T21:00'), '2026-11-27T21:00');

// Labels, with and without an end.
assert.equal(whenLabel('2026-11-27T18:30', opts), 'Fri, Nov 27, 6:30 PM');
assert.match(whenLabel('2026-11-27T18:30', { ...opts, end: '2026-11-27T21:00' }), /^Fri, Nov 27, 6:30\s–\s9:00\sPM$/);
assert.match(whenLabel('2026-11-25T18:30;FREQ=WEEKLY;BYDAY=WE', { ...opts, end: '2026-11-25T21:00' }), /^Every Wednesday, 6:30\s–\s9:00\sPM \(from Nov 25\)$/);
assert.match(whenLabel('2026-11-25T22:00;FREQ=WEEKLY;BYDAY=WE', { ...opts, end: '2026-11-26T02:00' }), /^Every Wednesday, 10:00\sPM – 2:00\sAM the next day/);

// Days: an overnight event counts on the day it runs into, but ending at midnight doesn't.
assert.equal(occursBetween('2026-11-27T22:00', '2026-11-28', '2026-11-28'), false);
assert.equal(occursBetween('2026-11-27T22:00', '2026-11-28', '2026-11-28', '2026-11-28T02:00'), true);
assert.equal(occursBetween('2026-11-27T22:00', '2026-11-28', '2026-11-28', '2026-11-28T00:00'), false);
assert.equal(occursBetween('2026-11-25T22:00;FREQ=WEEKLY;BYDAY=WE', '2026-12-03', '2026-12-03', '2026-11-26T02:00'), true, 'Thursday after a Wednesday');
assert.equal(occursBetween('2026-11-25T22:00;FREQ=WEEKLY;BYDAY=WE', '2026-12-04', '2026-12-04', '2026-11-26T02:00'), false);

// Calendar file: DTEND with an end, an hour without.
const ev = { id: 1, title: 'Dinner', when_text: '2026-11-27T18:30' };
assert.match(icsFor(ev, { origin: 'https://example.test' }), /DURATION:PT1H/);
assert.match(icsFor({ ...ev, end_text: '2026-11-27T21:00' }, { origin: 'https://example.test' }), /DTEND:20261127T210000/);

// sunsetAt: within a couple of minutes of published times, on the place's own date; none near the poles in winter
// or summer.
const near = (ymd, lat, lon, iso) => assert.ok(Math.abs(sunsetAt(ymd, lat, lon) - Date.parse(iso)) <= 3 * 60e3, `${ymd} ${lat},${lon}`);
near('2026-11-22', 32.7157, -117.1611, '2026-11-23T00:43:00Z'); // San Diego, 4:43 PM PST (the next day in UTC)
near('2026-06-21', 51.5074, -0.1278, '2026-06-21T20:21:00Z');   // London, 9:21 PM BST
near('2026-11-22', 35.68, 139.69, '2026-11-22T07:30:00Z');      // Tokyo, 4:30 PM JST
assert.equal(sunsetAt('2026-12-21', 69.65, 18.96), null, 'Tromsø: polar night');
assert.equal(sunsetAt('2026-06-21', 69.65, 18.96), null, 'Tromsø: midnight sun');
assert.equal(sunsetAt('tomorrow', 0, 0), null);

console.log('when.js: end times pass');
