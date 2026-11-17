// Example posts, shared by the demo (demo.js, DEMO=1), where demo accounts host them, and the sample deck on the
// introduction page (about.js). Places are in San Diego. when: [days from today, hour, minute, repeat kind], where the
// optional repeat kind is one of repeatOptions (public/when.js), e.g. 'weekly'. max: null = no limit.
import { repeatOptions } from './when.js';

export const EXAMPLES = [
  { host: 'maya', title: 'Pick up compost & spread it on my garden', details: 'About 2 cubic yards from the city yard. Need a truck and a second pair of hands with a wheelbarrow. Lemonade provided!',
    tags: ['gardening', 'hauling'], location: '32.748310,-117.130630', place: 'North Park', when: [5, 9], max: 2 },
  { host: 'rosa', title: 'Walk my dog Biscuit while my hip heals', details: 'He is a sweet old beagle. 20 minutes around the block, any afternoon this week.',
    tags: ['pets'], location: '32.731400,-117.146100', place: 'Bankers Hill', when: [1, 15, 30], max: 1 },
  { host: 'sam', title: 'Help me move a couch up two flights', details: 'It is heavy but not huge. Pizza and beer after.',
    tags: ['moving', 'food'], location: '32.715700,-117.161100', place: 'Little Italy', when: [6, 14], max: 2 },
  { host: 'dev', title: 'Fix a wobbly kitchen table', details: 'One leg is loose. I have glue and clamps but no clue.',
    tags: ['fixing'], location: '32.755800,-117.208700', place: 'Midway District', when: [2, 18, 30], max: 1 },
  { host: 'maya', title: 'Set up a printer for my mom', details: 'It is wireless, in theory.',
    tags: ['tech'], location: '32.748310,-117.130630', place: 'North Park', when: [3, 17], max: 1 },
  { host: 'rosa', title: 'Jazz in the park', details: 'Free outdoor concert by the bandstand. Bring a blanket; I will bring snacks.',
    tags: ['music'], location: '32.731000,-117.150300', place: 'Balboa Park', when: [4, 18, 0, 'nthday'], max: null },
  { host: 'sam', title: 'Trivia night at the Brass Tap', details: 'Need a team! Entry is $5 each and drinks are on you.',
    tags: ['trivia', 'food'], location: '32.719649,-117.220272', place: 'Point Loma', when: [2, 20, 0, 'weekly'], max: 3, cost: 5 },
  { host: 'dev', title: 'Try the new ramen place', details: 'Heard it is great. Around $25 a bowl.',
    tags: ['food'], location: '32.711800,-117.160500', place: 'Downtown', when: [3, 19], max: 2, cost: 25 },
];

// An example's time as stored in events.when_text ("YYYY-MM-DDTHH:MM[;RRULE]"), counted from `now` in local time.
export function exampleWhen([days, hh, mm = 0, repeat], now = new Date()) {
  const d = new Date(now); d.setDate(d.getDate() + days);
  const p = (n) => String(n).padStart(2, '0');
  const start = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(hh)}:${p(mm)}`;
  return repeat ? `${start};${repeatOptions(start).find(o => o.kind === repeat).rule}` : start;
}
