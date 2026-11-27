// Example posts, shared by the demo (demo.js, DEMO=1), where demo accounts host them, and the sample deck on the
// introduction page (about.js). All in English; most places are in San Diego. when: [days from today, hour, minute,
// repeat kind], where the optional repeat kind is one of repeatOptions (public/when.js), e.g. 'weekly', or null for
// no time yet. location '' = no place. max: null = no limit. Posts asking for a hand are tagged 'help', which counts
// toward "people helped" for whoever shows up.
import { repeatOptions } from './when.js';

export const EXAMPLES = [
  { host: 'maya', title: 'Pick up compost & spread it on my garden', details: 'About 2 cubic yards from the city yard. Need a truck and a second pair of hands with a wheelbarrow. Lemonade provided!',
    tags: ['gardening', 'hauling', 'help'], location: '32.748310,-117.130630', place: 'North Park', when: [5, 9], max: 2 },
  { host: 'sam', title: 'Help me move a couch up two flights', details: 'It is heavy but not huge. Pizza and beer after.',
    tags: ['moving', 'food', 'help'], location: '32.715700,-117.161100', place: 'Little Italy', when: [6, 14], max: 2 },
  { host: 'sam', title: 'Trivia night at the Brass Tap', details: 'Need a team! Entry is $5 each and drinks are on you.',
    tags: ['trivia', 'food'], location: '32.719649,-117.220272', place: 'Point Loma', when: [2, 20, 0, 'weekly'], max: 3, cost: 5 },
  { host: 'dev', title: 'Get some ramen at Chef Jun', details: 'Heard it is great. Around $25 a bowl.',
    tags: ['food'], location: '32.8233478,-117.2218955', place: 'Bay Ho', when: [3, 19], max: 2, cost: 25 },
  { host: 'rosa', title: "Get crunk and go shopping at Macy's", details: 'Meet at my place, pre-party, hop on the trolley, and BUY SOME CUTE STUFF!',
    tags: ['shopping', 'party'], location: '32.748900,-117.161200', place: 'Hillcrest', when: [4, 11], max: 4 },
  { host: 'maya', title: 'Wanna help me paint the nursery?', details: "Because I'm preganant AF, and this is sooo much work, y'all!",
    tags: ['painting', 'fixing', 'help'], location: '32.748310,-117.130630', place: 'North Park', when: [7, 10], max: 3 },
  { host: 'dev', title: "Let's play GTA6 until our fingers fall off", details: "I took the week off, LET'S GOOOOO!",
    tags: ['video-games'], location: '32.795700,-117.252800', place: 'Pacific Beach', when: [1, 12], max: 3 },
  { host: 'sam', title: 'Assemble some IKEA furniture', details: "If I stare at this little dude wordlessly trying to help me assemble a 2000 piece TV console for much longer I'm gonna go crazy. Wanna come help me out? Mocktails and snacks on me.",
    tags: ['fixing', 'food', 'help'], location: '32.768300,-117.149800', place: 'Mission Valley', when: [3, 13], max: 2 },
  { host: 'rosa', title: 'Occupy Wall St.', details: "You know the drill, it's 2036 and these jokers still messing everything up for everybody else. Come, stay, don't leave till minimum wage is sane - at least $200/hour.",
    tags: ['protest'], location: '32.716200,-117.162900', place: 'Civic Center Plaza', when: [9, 8], max: null },
  { host: 'dev', title: 'Burrito crawl: five shops, one stomach', details: 'We split every burrito five ways and rank them on a very serious spreadsheet. Bring Tums.',
    tags: ['food'], location: '32.698900,-117.144700', place: 'Barrio Logan', when: [5, 12], max: 4 },
  { host: 'maya', title: 'Help me catch my escaped chicken', details: "Her name is Nugget, she's somewhere in the canyon, and she's way faster than she looks. Bring snacks (for her).",
    tags: ['pets', 'help'], location: '32.724600,-117.135400', place: 'Golden Hill', when: [1, 8], max: null },
  { host: 'rosa', title: 'Teach my grandma to go viral on TikTok', details: 'She has a dance planned. She has a costume. I cannot be in this video.',
    tags: ['tech', 'help'], location: '32.731400,-117.146100', place: 'Bankers Hill', when: [2, 16], max: 1 },
  { host: 'rosa', title: 'Tea Party', details: 'Friends! Brethren! Countrymen! That worst of plagues, the detested tea shipped for this port by the East India Company, is now arrived in the harbour; the hour of destruction, or manly opposition to the machinations of tyranny, stares you in the face. Every friend to his country, to himself, and posterity, is now called upon to meet at Faneuil Hall, at nine o\u2019clock this day (at which time the bells will ring), to make a united and successful resistance to this last, worst, and most destructive measure of administration.',
    tags: ['protest', 'history'], location: '42.360000,-71.056100', place: 'Faneuil Hall, Boston', when: [12, 9], max: null },
  { host: 'marcus', title: "Hot sauce taste-off in my backyard", details: "I've got 23 bottles and a gallon of milk on standby. Loser buys tacos.",
    tags: ["food"], location: '32.748500,-117.098800', place: "City Heights", when: [4, 17], max: 6 },
  { host: 'ellie', title: "Thrift flip: make ugly clothes cute", details: "Hit three thrift stores, then my sewing machine. Your grandpa's bowling shirt is about to slap.",
    tags: ["crafts", "shopping"], location: '32.763100,-117.122900', place: "Normal Heights", when: [5, 11], max: 3 },
  { host: 'nate', title: "Toddler meltdown support group (at the playground)", details: "Our kids run around, we drink cold coffee and pretend everything is fine. Juice boxes provided.",
    tags: ["kids"], location: '32.739800,-117.212000', place: "Liberty Station", when: [2, 9, 30], max: null },
  { host: 'aisha', title: "Help me build a backyard playhouse", details: "I bought the plans. I own a drill. I have never used the drill. Pizza and gratitude.",
    tags: ["fixing", "kids", "help"], location: '32.640100,-117.084200', place: "Chula Vista", when: [6, 10], max: 3 },
  { host: 'tom', title: "Learn to drive stick before my kid does", details: "My 15-year-old wants my old Civic, and I never learned manual. Empty parking lot, lots of patience, no judgment.",
    tags: ["cars", "help"], location: '32.783000,-117.119600', place: "Mission Valley", when: [4, 8], max: 1 },
  { host: 'lena', title: "Escape the house while the teens have a party", details: "I said yes to the sleepover. I did not say I would be there for it. Wine bar, two hours, phones face down.",
    tags: ["drinks"], location: '32.721600,-117.168600', place: "Little Italy", when: [5, 19], max: 3 },
  { host: 'gloria', title: "Get a real Caesar salad", details: "You ever had a real, OG caesar salad at Caesar's in TJ?",
    tags: ["food", "travel"], location: '32.533100,-117.036000', place: "Caesar's, Tijuana", when: [7, 13], max: 4 },
  { host: 'craig', title: "Restore a 1972 VW bus with me", details: "She doesn't run. She barely rolls. But she's beautiful. Bring rags.",
    tags: ["cars", "fixing", "help"], location: '32.794800,-116.962500', place: "El Cajon", when: [3, 9], max: 3 },
  { host: 'hank', title: "Beer Can Races", details: "Join the crew for a casual \"beer can\" race. Looks like it'll be a good day for sailing!",
    tags: ["sailing"], location: '32.717500,-117.229000', place: "Shelter Island", when: [1, 17, 30, 'weekly'], max: 4 },
  { host: 'linda', title: "Pickleball, but trash talk is required", details: "I'm 64 and I will destroy you. Paddles to borrow if you need one.",
    tags: ["fitness"], location: '32.750600,-117.230900', place: "Point Loma", when: [2, 8], max: 3 },
  { host: 'walt', title: "Ballroom dancing for people with new hips", details: "My doctor says dancing is good for me. My wife says I step on her feet. Help me prove her wrong.",
    tags: ["dancing", "help"], location: '32.731000,-117.150300', place: "Balboa Park", when: [3, 14], max: 2 },
  { host: 'dottie', title: "Card sharks wanted: Tuesday night poker", details: "Nickel ante. I've been playing since Eisenhower. Bring snacks and humility.",
    tags: ["board-games"], location: '32.767800,-117.023000', place: "La Mesa", when: [7, 19, 0, 'weekly'], max: 5 },
  // Whims: not plans yet, just something someone's up for. No time (when: null), and some with no place either.
  { host: 'ellie', title: 'I want to go hiking', details: "I'm up for it whenever, and I'm open to hike anywhere close to Santa Cruz.",
    tags: ['hiking'], location: '', place: '', when: null, max: null },
  { host: 'dev', title: 'Idiocracy', details: 'There\'s this great documentary playing at the Alamo Drafthouse called "Idiocracy".',
    tags: ['movies'], location: '37.756320,-122.418910', place: 'Alamo Drafthouse New Mission, San Francisco', when: null, max: 3 },
  { host: 'sam', title: 'Tacos, sometime soon?', details: 'No plan yet. Just a craving that will not quit.',
    tags: ['food'], location: '', place: '', when: null, max: 3 },
  { host: 'rosa', title: 'Stargazing on the next clear, moonless night', details: "Somewhere dark, way past the city lights. I'll bring a blanket and a thermos of cocoa.",
    tags: ['outdoors'], location: '33.255900,-116.375300', place: 'Borrego Springs', when: null, max: 4 },
  { host: 'marcus', title: 'Start a band?', details: 'I play bass, badly. Looking for other people who also play something badly.',
    tags: ['music'], location: '', place: '', when: null, max: 4 },
  { host: 'maya', title: 'Watch a sunset somewhere', details: 'Any beach, any evening. I keep meaning to go and then I just... do not.',
    tags: ['outdoors'], location: '', place: '', when: null, max: null },
];

// An example's time as stored in events.when_text ("YYYY-MM-DDTHH:MM[;RRULE]"), counted from `now` in local time.
// No time (null) → ''.
export function exampleWhen(when, now = new Date()) {
  if (!when) return '';
  const [days, hh, mm = 0, repeat] = when;
  const d = new Date(now); d.setDate(d.getDate() + days);
  const p = (n) => String(n).padStart(2, '0');
  const start = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(hh)}:${p(mm)}`;
  return repeat ? `${start};${repeatOptions(start).find(o => o.kind === repeat).rule}` : start;
}
