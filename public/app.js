// Bored — vanilla JS front-end.
import {
  prfSupport, createAccount, signIn, addPasskey, loadKeys, clearKeys, hasKeys, vault,
  PrfUnsupportedError, startIdSignIn, finishIdSignIn, hasIdCallback, createDemoAccount,
  newInviteKey, sealForInvite, openForInvite, sha1Hex, b64u, ensureKeys,
} from './secure.js';
import { locationHtml, mountLocationField, pickLocation, PIN_SVG, parseLatLon } from './location.js';
import { mountFeedback } from './feedback.js';
import { parseWhen, parseEnd, shiftEnd, repeatOptions, whenLabel as fmtWhen, localToday, occursBetween, sunsetAt } from './when.js';
import {
  initMail, resetMail, loadMail, mailView, requestJoin, sendOn, pass, unpass, deletePassed, savePost, setPostStatus, reshare,
  invitesForMe, answerInvite, sendInvite, declinedInvites, keysFor, myInboxTokens,
} from './mail.js';
import { LIVE } from './posts.js';
import { postFields, FIELD_LABELS } from './postfields.js';
import { CURRENCIES, DEFAULT_CURRENCY, costLabel } from './cost.js';
import { toSvg as identicon } from './vendor/jdenticon.js';
import { addToCalendar } from './ics.js';
import { tap, Tap } from './pointer.js';
import { esc } from './html.js';
import { INSTAGRAM_POST } from './instagram.js';
import {
  builtinTerms, ownTerms, censor, findTerms, mentions, reportedFor, moderationSettings, parseTerms, reportThreshold, REPORT_REASONS,
  MAX_LISTS, MAX_LIST_WORDS, MAX_THRESHOLD,
} from './moderation.js';

// Well-known tags, offered as one-tap suggestions. Posts can also use any other tag.
const TAGS = ['help', 'hiking', 'food', 'gardening', 'hauling', 'moving', 'fixing', 'pets', 'tech', 'cooking',
  'errands', 'fitness', 'board-games', 'video-games', 'movies'];
const MAX_TAGS = 5;
const MAX_ATTENDEES_LIMIT = 500; // must match db.js
const attendeesLabel = (max) => (max == null ? 'No limit' : max === 1 ? '1 person' : `Up to ${max} people`);
const whenLabel = (s, end) => fmtWhen(s, { today: localToday(), end });
// Discover's cost filter: prices in different currencies can't be compared, so it's just free vs. paid.
const COST_FILTERS = { free: 'Free', paid: 'Paid' };
// Discover's distance filter: your spot (kept on this device only) and a radius, in the unit you picked in Profile
// (kept in your encrypted vault, prefs.distanceUnit: 'km' | 'mi'). Kilometres by default, and for guests.
const useMiles = () => vault.data.prefs?.distanceUnit === 'mi';
const kmPerUnit = () => (useMiles() ? 1.609344 : 1);
const RADII = [1, 5, 10, 25, 50];
const DEFAULT_RADIUS = 10;
function fmtDistance(n) {
  try { return new Intl.NumberFormat(undefined, { style: 'unit', unit: useMiles() ? 'mile' : 'kilometer', unitDisplay: 'short' }).format(n); }
  catch { return `${n} ${useMiles() ? 'mi' : 'km'}`; }
}
function loadJson(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }

// Discover's date filter (pick one): day ranges in your own calendar, worked out each time they're used.
const DATE_FILTERS = { today: 'Today', tomorrow: 'Tomorrow', weekend: 'This weekend', week: 'Next 7 days' };
// How the Post tab sorts "Your posts" (remembered per browser): newest first unless picked otherwise.
const POST_SORTS = { newest: 'Newest first', oldest: 'Oldest first', soonest: 'Happening soonest', interested: 'Most interested', title: 'Title (A to Z)' };
function dateFilterRange(key, now = new Date()) {
  const day = (n) => { const d = new Date(now); d.setDate(d.getDate() + n); return localToday(d); };
  const dow = now.getDay(); // 0 = Sunday
  return {
    today: [day(0), day(0)],
    tomorrow: [day(1), day(1)],
    weekend: dow === 0 ? [day(0), day(0)] : [day(6 - dow), day(7 - dow)], // the coming (or current) Saturday and Sunday
    week: [day(0), day(6)],
  }[key];
}
// The currency last picked in the post form, so it's the default next time.
const lastCurrency = () => { try { return localStorage.getItem('currency') || DEFAULT_CURRENCY; } catch { return DEFAULT_CURRENCY; } };
const currencyName = (() => { try { const n = new Intl.DisplayNames(undefined, { type: 'currency' }); return (c) => n.of(c); } catch { return (c) => c; } })();
// Next local date and time at `hour` o'clock (on weekday `dow`, 0 = Sunday, if given), as stored in when_text.
function nextAt(hour, dow) {
  const d = new Date();
  if (d.getHours() >= hour) d.setDate(d.getDate() + 1);
  if (dow !== undefined) while (d.getDay() !== dow) d.setDate(d.getDate() + 1);
  return `${localToday(d)}T${String(hour).padStart(2, '0')}:00`;
}
// Mirror of the server's normalizeTag (db.js) so chips show what will be saved.
const normalizeTag = (raw) => String(raw ?? '').toLowerCase().trim().replace(/^#+/, '')
  .replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
// Suggested tags for organizing your contacts (private, stored only in your encrypted vault).
const CONTACT_TAGS = ['family', 'friends', 'neighbors', 'work'];

// Signed-out guests can browse Discover; everything else needs an account.
// AGPL-3.0 section 13: people using the app over the network must be offered its source. The links are in the
// introduction page's footer (public/about.html), reached from here and from the title board.
const ABOUT_LINKS = `<p class="note" style="margin-top:20px;text-align:center"><a href="/about">About Bored</a> · <a href="/privacy">Privacy Policy</a></p>`;

// Tab icons on the wood buttons: simple line drawings (binoculars, a checkmark, a calendar, a plus, and a person).
// All are cream (--wood-text), like the lettering on the other buttons.
const svgIcon = (body, { fill = false } = {}) => `<svg viewBox="0 0 24 24" aria-hidden="true" ${fill
  ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'}>${body}</svg>`;
const PERSON_ICON = svgIcon('<circle cx="12" cy="8" r="4.2"/><path d="M3.8 21.5c0-4.6 3.7-7.3 8.2-7.3s8.2 2.7 8.2 7.3z"/>', { fill: true });
const TAB_ICONS = {
  discover: svgIcon('<circle cx="6.5" cy="15.5" r="4"/><circle cx="17.5" cy="15.5" r="4"/><path d="M10.5 15.5h3M3 14.5l2.2-8.2a1.8 1.8 0 0 1 3.5.9V12M21 14.5l-2.2-8.2a1.8 1.8 0 0 0-3.5.9V12M8.7 10h6.6"/>'),
  confirm: svgIcon('<path d="M4.5 12.5l5 5L19.5 6.5"/>'),
  plans: svgIcon('<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'),
  post: svgIcon('<path d="M12 4.5v15M4.5 12h15"/>'),
  profile: PERSON_ICON,
  account: PERSON_ICON,
};

const GUEST_TABS = [
  { id: 'discover', label: 'Discover' },
  { id: 'account', label: 'Sign in' },
];
const TABS = [
  { id: 'discover', label: 'Discover' },
  { id: 'confirm', label: 'Confirm' },
  { id: 'plans', label: 'Plans' },
  { id: 'post', label: 'Post' },
  { id: 'profile', label: 'Profile' },
];

// Rotating ideas shown above the form in the Post tab. Tapping one opens a new post pre-filled with its template.
// when: [hour, weekday?] becomes the next such time (see nextAt).
const POST_IDEAS = [
  {
    prompt: "Is there a local restaurant you've been meaning to check out?",
    template: {
      title: 'Try out a local restaurant together',
      details: "There's a place nearby I've been meaning to check out. Want to come along? We can each get our own check.",
      tags: ['food'], max_attendees: 2, when: [19],
    },
  },
  {
    prompt: 'Want some company on a walk around the neighborhood?',
    template: {
      title: 'Walk around the neighborhood',
      details: 'Looking for some company on a walk. Easy pace, about an hour. Dogs welcome!',
      tags: ['fitness'], max_attendees: 1, when: [18],
    },
  },
  {
    prompt: 'Need some help tending the garden?',
    template: {
      title: 'Help tending the garden',
      details: "Weeding, watering, and some general tidying. I'll provide gloves, tools, and something cold to drink.",
      tags: ['gardening', 'help'], max_attendees: 1, when: [10, 6],
    },
  },
  {
    prompt: "Time to do some grocery shopping? It's more fun with a friend!",
    template: {
      title: 'Grocery run together',
      details: "Heading to the grocery store. Come along and we'll make a trip of it. Happy to share a ride.",
      tags: ['errands'], max_attendees: 1, when: [11, 6],
    },
  },
  {
    prompt: 'Need help building a piece of furniture?',
    template: {
      title: 'Help assembling some furniture',
      details: "Got a flat-pack piece that's a two-person job. I have the instructions and an Allen key; a drill would be a bonus. Should take an hour or two.",
      tags: ['fixing', 'help'], max_attendees: 1, when: [14, 0],
    },
  },
  {
    prompt: 'Want to go for a hike?',
    template: {
      title: 'Go for a hike',
      details: "Thinking of hitting a trail nearby. Moderate pace, a few hours. Bring water and good shoes, and we can carpool to the trailhead.",
      tags: ['hiking'], max_attendees: 2, when: [9, 0],
    },
  },
  {
    prompt: 'Any interesting events happening around town?',
    template: {
      title: 'Check out an event around town',
      details: "There's something happening around town that looks fun. Say what it is and where to find details, and anyone who's interested can come along.",
      tags: [], visibility: 'public',
    },
  },
  {
    prompt: 'Want to work out or go to the gym with a friend?',
    template: {
      title: 'Work out together',
      details: "Heading to the gym. It's easier to stick with it when someone's expecting you. Any fitness level is welcome.",
      tags: ['fitness'], max_attendees: 1, when: [7],
    },
  },
  {
    prompt: 'Want someone to play a video game with?',
    template: {
      title: 'Play a video game together',
      details: "Couch co-op or online, I'm up for most things. Say what you like to play and what you play on.",
      tags: ['video-games'], max_attendees: 1, when: [20],
    },
  },
  {
    prompt: 'Up for a board game night?',
    template: {
      title: 'Board game night',
      details: "I have a few games, or bring your favorite. Anything from quick card games to a long strategy night.",
      tags: ['board-games'], max_attendees: 3, when: [19, 5],
    },
  },
  {
    prompt: 'Want to watch a movie together?',
    template: {
      title: 'Watch a movie',
      details: "At the theater or on my couch, either works. Let's pick something we both want to see. Snacks on me.",
      tags: ['movies'], max_attendees: 2, when: [19, 5],
    },
  },
  {
    prompt: 'Want to binge a TV series together?',
    template: {
      title: 'Binge a TV series',
      details: "Starting a series and looking for company. A few episodes at a time, with snacks.",
      tags: ['movies'], max_attendees: 2, when: [19, 6],
    },
  },
];
const POST_IDEA_MS = 5000;

// config.authMode: 'local' (Bored passkeys) | '6j0' (sign in with a 6j0.org identity at config.idOrigin)
//   | 'demo' (server DEMO=1: no sign-in; every browser gets its own throwaway account full of demo content).
const state = { config: { authMode: 'local' }, me: null, tab: 'discover', chat: null, discoverTags: loadSet('discoverTags'), discoverCosts: new Set([...loadSet('discoverCosts')].filter(c => c in COST_FILTERS)),
  discoverDate: (() => { try { const d = localStorage.getItem('discoverDate'); return d in DATE_FILTERS ? d : ''; } catch { return ''; } })(),
  discoverNear: (() => { const n = loadJson('discoverNear', null); return n && Number.isFinite(n.lat) && Number.isFinite(n.lon) ? n : null; })(),
  discoverOnline: loadJson('discoverOnline', false) === true,
  search: {}, // each tab's search, by tab id: kept while the app is open, not saved (an old search would hide new things)
  discoverRadius: (() => { const r = Number(loadJson('discoverRadius', 0)); return RADII.includes(r) ? r : 0; })(),
  postSort: (() => { const s = loadJson('postSort', 'newest'); return s in POST_SORTS ? s : 'newest'; })(),
  filtersOpen: false };
const app = document.getElementById('app');

// ---------- utils ----------

// Remember the Discover filters per browser (a convenience only; the app works without it).
function loadSet(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch { return new Set(); }
}
function saveDiscoverFilters() {
  try {
    localStorage.setItem('discoverTags', JSON.stringify([...state.discoverTags]));
    localStorage.setItem('discoverCosts', JSON.stringify([...state.discoverCosts]));
    localStorage.setItem('discoverDate', state.discoverDate);
    localStorage.setItem('discoverNear', JSON.stringify(state.discoverNear));
    localStorage.setItem('discoverRadius', JSON.stringify(state.discoverRadius));
    localStorage.setItem('discoverOnline', JSON.stringify(state.discoverOnline));
  } catch {}
}

// Text as HTML, escaped, with its web addresses (http:// or https://) as links that open in a new tab. Punctuation
// right after an address (a full stop, a comma, or a closing bracket with no opening one in it) isn't part of it.
// A link to an Instagram post written without https:// (instagram.com/p/…) is a link too.
const LINKABLE = new RegExp(String.raw`(https?:\/\/[^\s<>"']+|${INSTAGRAM_POST.source})`, 'i');
function linkify(text) {
  return String(text ?? '').split(LINKABLE).map((part, i) => {
    if (i % 2 === 0) return esc(part);
    let url = part, after = '';
    for (let m; (m = url.match(/[.,;:!?'")\]}]$/));) {
      if (m[0] === ')' && url.split('(').length > url.split(')').length - 1) break; // a bracket that belongs, e.g. Wikipedia
      after = m[0] + after; url = url.slice(0, -1);
    }
    const href = /^https?:\/\//i.test(url) ? url : 'https://' + url;
    try { new URL(href); } catch { return esc(part); }
    return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer nofollow">${esc(url)}</a>${esc(after)}`;
  }).join('');
}

// ---------- search ----------
// Every tab can be searched. Something matches when every word typed is somewhere in its text, ignoring case and
// accents; a leading # (for a tag) is optional. Each tab's search is kept in state.search while the app is open.
const fold = (s) => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const searchWords = (q) => fold(q).split(/\s+/).map(w => w.replace(/^#+/, '')).filter(Boolean);
const matchesWords = (text, words) => { const t = fold(text); return words.every(w => t.includes(w)); };
// The text a card's HTML shows, to search what's on it. A template's content is inert: nothing in it loads.
const htmlText = (html) => { const t = document.createElement('template'); t.innerHTML = html; return t.content.textContent; };
const searchQuery = (tab = state.tab) => (state.search[tab] || '').trim();
const searchBoxHtml = (label) => `
  <form class="tab-search" role="search">
    <input type="search" placeholder="${esc(label)}" aria-label="${esc(label)}" autocomplete="off" enterkeyhint="search" value="${esc(state.search[state.tab] || '')}">
  </form>`;
// Wires up the search box searchBoxHtml put in root: onSearch(words) runs a moment after typing stops, and right away
// on Enter (or the keyboard's search key), which also puts a phone's keyboard away so the results show.
function mountSearch(root, onSearch) {
  const form = root.querySelector('.tab-search'), input = form?.querySelector('input'), tab = state.tab;
  if (!form) return;
  let timer;
  const run = () => { clearTimeout(timer); state.search[tab] = input.value; onSearch(searchWords(input.value)); };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 200); });
  form.addEventListener('submit', (e) => { e.preventDefault(); run(); input.blur(); });
}
// For a list already on the page: hides each [data-search-item] that doesn't match, and each [data-search-group]
// with none showing. [data-search-none] shows when a search matches nothing. Returns how many match.
function filterShown(root, words) {
  let n = 0;
  root.querySelectorAll('[data-search-item]').forEach(el => { el.hidden = !matchesWords(el.textContent, words); if (!el.hidden) n++; });
  root.querySelectorAll('[data-search-group]').forEach(g => { g.hidden = words.length > 0 && !g.querySelector('[data-search-item]:not([hidden])'); });
  const none = root.querySelector('[data-search-none]');
  if (none) { none.hidden = !words.length || n > 0; none.textContent = `Nothing here matches “${searchQuery()}”.`; }
  return n;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : method !== 'GET' ? '{}' : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.me && !path.startsWith('/api/passkey/') && !path.startsWith('/api/id/')) { state.me = null; await clearKeys(); resetMail(); render(); }
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status });
  return data;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2400);
}

// A bottom sheet over the page, with html as its panel. Escape, or tapping outside the panel (unless backdrop is
// false), dismisses it: onDismiss runs, which closes the sheet unless given. Returns { sheet, close }.
function openSheet(html, { onDismiss, backdrop = true } = {}) {
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.innerHTML = html;
  const panel = sheet.firstElementChild;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  const close = () => sheet.remove();
  const dismiss = () => (onDismiss || close)();
  // On the sheet, not the document: a field inside that uses Escape itself (a search list) stops it first.
  sheet.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); dismiss(); } });
  if (backdrop) sheet.onclick = (e) => { if (e.target === sheet) dismiss(); };
  document.body.appendChild(sheet);
  // Keyboard focus moves into the sheet (so Escape reaches it), unless the caller focuses a field in it right away.
  panel.tabIndex = -1;
  queueMicrotask(() => { if (!sheet.contains(document.activeElement)) panel.focus({ preventScroll: true }); });
  return { sheet, close };
}

// ---------- people ----------
// Nobody has a public name. You see the nickname *you* gave someone (stored in your encrypted vault) once you've
// connected (matched); everyone else has no name, and cards leave it out (contactName). You are just "You".
const isContact = (guid) => Boolean(vault.data.contacts[guid]);
function displayName(guid) {
  if (state.me && guid === state.me.guid) return 'You';
  const c = vault.data.contacts[guid];
  return c ? (c.nickname || 'Unnamed contact') : '';
}
// A contact's name, or '' for anyone else.
const contactName = (guid) => (isContact(guid) ? displayName(guid) : '');
// Everyone's avatar is the Jdenticon of their GUID. The server only sends GUIDs of people you've matched with; for
// anyone else it sends `icon`, the SHA-1 of the GUID, which Jdenticon draws as the very same picture.
const avatar = (key, cls = '') => key
  ? `<div class="avatar icon ${cls}">${identicon(key, 100)}</div>`
  : `<div class="avatar anon ${cls}" aria-hidden="true"></div>`;

// The name I introduce myself with (Profile), offered as what new people should call me. Kept in my vault.
const myName = () => (hasKeys() && vault.data.profile?.name) || '';

// An avatar to click: a contact's opens my contact info for them; a stranger hosting a post (pid) can be invited to
// connect. Anyone else's is just a picture. The clicks are handled once, for the whole page, below.
function personAvatar(guid, cls = '', { pid = null, icon = null } = {}) {
  if (guid && isContact(guid)) {
    return `<button type="button" class="avatar-btn" data-person="${esc(guid)}" title="Your contact info for ${esc(displayName(guid))}">${avatar(guid, cls)}</button>`;
  }
  if (pid && state.me && hasKeys()) {
    return `<button type="button" class="avatar-btn" data-invite-host="${esc(pid)}" title="Invite them to connect">${avatar(guid || icon, cls)}</button>`;
  }
  return avatar(guid || icon, cls);
}
document.addEventListener('click', (e) => {
  const person = e.target.closest('[data-person]');
  // Redraw after an edit, except on a deck, which would start over (its names catch up on the next refresh).
  if (person) return openContactSheet(person.dataset.person, () => { if (!['discover', 'confirm'].includes(state.tab)) render(); });
  const host = e.target.closest('[data-invite-host]');
  if (host) inviteHost(host.dataset.inviteHost);
});

// Add people to my contacts, unnamed unless names[guid] gives a nickname to start with.
async function addContacts(guids, names = {}) {
  const missing = [...new Set(guids)].filter(g => g && !isContact(g));
  if (!missing.length) return;
  await vault.update(api, (d) => {
    for (const g of missing) d.contacts[g] ||= { nickname: names[g] || '', tags: [], added: new Date().toISOString() };
  });
  await keysFor(missing).catch(() => {}); // save their keys now, so their posts show as theirs
}
// People I've connected with through an invitation (theirs or mine): both of us said yes. An inviter I asked to connect with gets the nickname I
// picked when I asked (pendingNames, keyed by their icon, since I didn't know their GUID yet).
async function syncConnections() {
  if (!state.me || !hasKeys()) return;
  try {
    const guids = (await api('/api/connections')).map(c => c.guid).filter(g => !isContact(g));
    if (!guids.length) return;
    const pending = vault.data.pendingNames || {}, names = {}, used = [];
    for (const g of guids) { const icon = await sha1Hex(g); if (pending[icon]) { names[g] = pending[icon]; used.push(icon); } }
    await addContacts(guids, names);
    if (used.length) await vault.update(api, (d) => { for (const i of used) delete d.pendingNames?.[i]; });
  } catch {}
}

// ---------- invitations to connect ----------
// A link the owner shares however they like: ${origin}/#invite=<token>&key=<key>&name=<suggested nickname>.
// Everything after # stays in the browser. The server keeps only a hash of the token; the owner's vault keeps the
// whole thing (invites: { [id]: { token, key, name } }) so they can share it again from any device. The name is the
// nickname the owner suggests for themselves; key encrypts the nickname the other person suggests back.
const inviteOf = (id) => { const v = vault.data.invites?.[id]; return typeof v === 'string' ? { token: v } : v || null; };
const inviteLink = ({ token, key, name }) =>
  `${location.origin}/#${new URLSearchParams({ invite: token, ...(key ? { key } : {}), ...(name ? { name } : {}) })}`;
// Ask for the nickname to suggest, then create the invitation and share it.
function createInvite() {
  const { sheet, close } = openSheet(`
    <form class="stack panel">
      <h2>New invitation</h2>
      <label>What should they call you?
        <input name="name" required maxlength="60" placeholder="e.g. Evan from the garden club" value="${esc(myName())}" autocomplete="off"></label>
      <p class="note">This is in the link, as a suggested nickname for you. They can change it; only they see what they pick.</p>
      <div class="two">
        <button type="button" class="btn ghost" data-cancel>Cancel</button>
        <button class="btn">Create and share</button>
      </div>
    </form>`);
  sheet.querySelector('[data-cancel]').onclick = close;
  sheet.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    if (!name) return;
    try {
      const inv = await api('/api/invites', { method: 'POST' });
      const entry = { token: inv.token, key: newInviteKey(), name };
      await vault.update(api, (d) => { d.invites ||= {}; d.invites[inv.id] = entry; });
      close();
      await shareInvite(entry);
      render();
    } catch (err) { toast(err.message); }
  };
  sheet.querySelector('input').focus();
}
async function shareInvite(entry) {
  const url = inviteLink(entry);
  if (navigator.share) {
    try { await navigator.share({ title: 'Connect with me on Bored', text: "Here's a link to connect with me on Bored:", url }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast('Invitation link copied. Paste it to whoever you want to connect with.'); }
  catch { prompt('Copy this invitation link:', url); }
}
// Someone opened an invitation link: once they're signed in, show who it's from and ask before connecting.
const PENDING_INVITE = 'pendingInvite';
const pendingInvite = () => { try { return JSON.parse(sessionStorage.getItem(PENDING_INVITE)); } catch { return null; } };
const dropPendingInvite = () => { try { sessionStorage.removeItem(PENDING_INVITE); } catch {} };
async function offerPendingInvite() {
  const { token, key, name } = pendingInvite() || {};
  if (!token) return;
  if (!key) { dropPendingInvite(); return toast("That invitation link is incomplete. Ask them to share it again."); }
  let info;
  try { info = await previewInvite(token); }
  catch (e) { dropPendingInvite(); return toast(e.message); }
  if (info.skip) { dropPendingInvite(); return toast(info.skip); }
  const result = await connectSheet({ token, key, name, info, ready: state.me && hasKeys() });
  if (result === 'signin') return go('account'); // enterApp offers it again after sign-in
  dropPendingInvite();
}
// Check an invitation before offering it: { icon, skip } (skip: why not to offer it, if there's a reason).
async function previewInvite(token) {
  const info = await api('/api/invites/preview', { method: 'POST', body: { token } });
  info.skip = info.mine ? "That's your own invitation link. Share it with someone else."
    : info.connected ? "You're already connected with them."
    : info.requested ? "You've already asked to connect. They'll see it in their Confirm tab." : '';
  return info;
}
// Ask whether to connect through an invitation (a link someone shared, or one mailed to me): my nickname for them
// (their suggestion to start with) and what they should call me (my Profile name to start with). Resolves to 'sent',
// 'no', or 'signin' (not signed in yet).
function connectSheet({ token, key, name, info, ready }) {
  return new Promise((resolve) => {
    const done = (r) => { close(); resolve(r); };
    const { sheet, close } = openSheet(`
    <form class="panel stack">
      <h2>Invitation to connect</h2>
      <div class="invite-from">${avatar(info.icon, 'big')}</div>
      <p>${name ? `<b>${esc(name)}</b> invited you` : 'Someone invited you'} to connect. If you say yes, they'll be asked
        to confirm. Once they do, you'll be in each other's contacts and can share private posts with each other.</p>
      ${ready ? `
      <label>Your nickname for them
        <input name="theirName" required maxlength="60" placeholder="e.g. Evan from the garden club" value="${esc(name || '')}" autocomplete="off"></label>
      <label>What should they call you?
        <input name="myName" required maxlength="60" placeholder="e.g. Sam from book club" value="${esc(myName())}" autocomplete="off"></label>
      <p class="note">Nicknames are private: only you see the one you give them, and only they see the one they give
        you. What you suggest is encrypted so only they can read it.</p>`
      : '<p class="note">Sign in or create an account first. This invitation will be waiting.</p>'}
      <div class="two">
        <button type="button" class="btn ghost" data-no>No thanks</button>
        <button class="btn">${ready ? 'Ask to connect' : 'Sign in'}</button>
      </div>
    </form>`, { onDismiss: () => done('no') });
    sheet.querySelector('[data-no]').onclick = () => done('no');
    sheet.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      if (!ready) return done('signin');
      const theirName = e.target.theirName.value.trim(), mine = e.target.myName.value.trim();
      if (!theirName || !mine) return;
      try {
        const note = await sealForInvite(key, mine);
        const { status } = await api('/api/invites/accept', { method: 'POST', body: { token, note } });
        await vault.update(api, (d) => { d.pendingNames ||= {}; d.pendingNames[info.icon] = theirName; });
        if (status === 'connected') { await syncConnections(); toast("You're already connected with them."); }
        else toast("Request sent. You'll be connected once they confirm.");
        done('sent');
      } catch (err) { toast(err.message); }
    };
  });
}

// Nobody becomes a contact without both saying yes. Inviting someone to connect: the host of a post (a stranger:
// their avatar in Discover), or the person in a plan's chat (matching doesn't connect anyone). The invitation is
// mailed to them (sendInvite) and shows in their Confirm tab, where they pick their nickname for me. It's only for
// them: when they say yes, my browser confirms it for me (confirmDirectInvites), since sending it already said yes,
// and they get the nickname I picked for them here.
function inviteHost(pid) {
  const post = mailView()?.posts.get(pid);
  if (!post) return toast('That post is gone.');
  inviteToConnect({ reply: post.reply, to: post.signer?.x, icon: post.signer ? `${post.signer.x}.${post.signer.y}` : null,
    about: `The host of <b>${esc(post.title)}</b>` });
}
function inviteToConnect({ reply, to, icon, about }) {
  if (Object.values(vault.data.invites || {}).some(i => i?.direct && i.to === to)) {
    return toast("You've already invited them. They'll see it in their Confirm tab.");
  }
  const { sheet, close } = openSheet(`
    <form class="stack panel">
      <h2>Invite them to connect</h2>
      <div class="invite-from">${avatar(icon, 'big')}</div>
      <p>${about} gets your invitation in their Confirm tab. If they say yes, you'll be in each other's contacts and
        can share private posts with each other.</p>
      <label>Your nickname for them
        <input name="their" required maxlength="60" placeholder="e.g. Sam from book club" autocomplete="off"></label>
      <label>What should they call you?
        <input name="name" required maxlength="60" placeholder="e.g. Evan from the garden club" value="${esc(myName())}" autocomplete="off"></label>
      <p class="note">Nicknames are private: only you see the one you give them, and only they see the one you
        suggest (they can change it).</p>
      <div class="two">
        <button type="button" class="btn ghost" data-cancel>Cancel</button>
        <button class="btn">Send invitation</button>
      </div>
    </form>`);
  sheet.querySelector('[data-cancel]').onclick = close;
  sheet.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim(), their = e.target.their.value.trim();
    if (!name || !their) return;
    let id = null;
    try {
      const inv = await api('/api/invites', { method: 'POST' });
      id = inv.id;
      const entry = { token: inv.token, key: newInviteKey(), name, direct: true, to, their };
      await vault.update(api, (d) => { d.invites ||= {}; d.invites[id] = entry; });
      await sendInvite(reply, entry);
      close();
      toast('Invitation sent.');
    } catch (err) {
      if (id) {
        await api(`/api/invites/${id}`, { method: 'DELETE' }).catch(() => {});
        await vault.update(api, (d) => { delete d.invites?.[id]; }).catch(() => {});
      }
      toast(err.message);
    }
  };
  sheet.querySelector('input').focus();
}
// Requests to connect through invitations I mailed to someone (inviteToConnect): confirm them, add them to my
// contacts with the nickname I picked (or, for invitations from before that, the one they suggested), and delete the
// invitation (it was only for them). Returns the other requests.
async function confirmDirectInvites(requests) {
  const rest = [];
  for (const c of requests) {
    const inv = c.invite_id && inviteOf(c.invite_id);
    if (!inv?.direct || !inv.token) { rest.push(c); continue; }
    try {
      const suggested = inv.key && c.note ? await openForInvite(inv.key, c.note) : null;
      const r = await api(`/api/connection-requests/${c.id}/respond`, { method: 'POST', body: { yes: true } });
      if (r.connected) {
        const nickname = inv.their || suggested;
        await addContacts([r.guid], nickname ? { [r.guid]: nickname } : {});
        toast(`Connected with ${nickname || 'someone you invited'}!`);
      }
      await api(`/api/invites/${c.invite_id}`, { method: 'DELETE' }).catch(() => {});
      await vault.update(api, (d) => { const e = d.invites?.[c.invite_id]; if (e) d.invites[c.invite_id] = { key: e.key, name: e.name, direct: true, to: e.to }; });
    } catch (err) { console.warn('direct invite', err); rest.push(c); }
  }
  return rest;
}
const formData = (form) => Object.fromEntries(new FormData(form));

// ---------- swipe deck ----------
const KEEP_CARD = Symbol('keep card'); // onSwipe can return this to leave the card in place
// items: array; renderCard(item) -> inner HTML; onSwipe(item, yes) -> Promise; labels for stamps.
// Drag a card sideways to swipe it: past 100px it's a yes (right) or a no (left); short of that it springs back.
// The card's .stamp.yes and .stamp.no fade in as it goes. onDragging(true/false) says when a drag starts and ends.
function dragToSwipe(el, onSwipe, onDragging = () => {}) {
  if (!el) return;
  const yesS = el.querySelector('.stamp.yes'), noS = el.querySelector('.stamp.no');
  let sx = 0, sy = 0, dx = 0, dy = 0, dragging = false;
  const back = () => { el.style.transform = ''; if (yesS) yesS.style.opacity = 0; if (noS) noS.style.opacity = 0; };
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('a, button, input, textarea, select, label')) return;
    dragging = true; sx = e.clientX; sy = e.clientY; dx = dy = 0;
    el.setPointerCapture(e.pointerId); el.classList.add('dragging'); onDragging(true);
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dx = e.clientX - sx; dy = e.clientY - sy;
    el.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`;
    if (yesS) yesS.style.opacity = Math.max(0, Math.min(1, dx / 100));
    if (noS) noS.style.opacity = Math.max(0, Math.min(1, -dx / 100));
  });
  const end = () => {
    if (!dragging) return;
    dragging = false; el.classList.remove('dragging'); onDragging(false);
    if (Math.abs(dx) > 100) onSwipe(dx > 0, back);
    else back();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

// No undo: a swiped card goes to the view's discard pile (mountPile), where the answer can be changed.
// back, if given, turns a card over on a yes instead of using it up: { render(item) → HTML for the back, or null to
// skip it; mount(backEl) → read(), whose result reaches onSwipe as extra.back; yesLabel, noLabel }. On the back, yes
// (swipe right, the yes button, or →) goes ahead and no turns the card face up again.
function mountDeck(root, { items, renderCard, onSwipe, yesLabel, noLabel, empty, back = null }) {
  root.innerHTML = `
    <div class="deck-wrap">
      <div class="deck"></div>
      <div class="actions">
        <button class="btn round no">${esc(noLabel)}</button>
        <button class="btn round yes">${esc(yesLabel)}</button>
      </div>
      <div class="hint"></div>
    </div>`;
  const wrap = root.querySelector('.deck-wrap');
  const deck = root.querySelector('.deck');
  const queue = [...items];
  const used = new Set(); // ids of cards already swiped away, so an update doesn't bring them back
  let busy = false, dragging = false;
  let flipped = null; // { el, read } while the top card shows its back
  // The buttons and hint say what yes and no do now: the deck's own labels, or the back's.
  const setLabels = (yes, no) => {
    root.querySelector('.round.yes').textContent = yes; root.querySelector('.round.no').textContent = no;
    root.querySelector('.hint').innerHTML = `Swipe right for <b>${esc(yes)}</b>, left for <b>${esc(no)}</b> · or use ← →`;
  };
  setLabels(yesLabel, noLabel);

  function draw() {
    deck.innerHTML = '';
    wrap.classList.toggle('is-empty', !queue.length);
    if (!queue.length) { deck.innerHTML = empty; return; }
    queue.slice(0, 2).reverse().forEach((item, i, arr) => {
      const el = document.createElement('div');
      el.className = 'card ' + (i === arr.length - 1 ? 'top' : 'second');
      el.innerHTML = `<div class="stamp yes">${esc(yesLabel)}</div><div class="stamp no">${esc(noLabel)}</div>`
        + `<div class="face front">${renderCard(item)}</div>`;
      deck.appendChild(el);
    });
    attachDrag(deck.querySelector('.card.top'));
  }

  const flyout = (yes) => `translate(${yes ? 600 : -600}px, 40px) rotate(${yes ? 30 : -30}deg)`;

  // Turn the top card over, to its back (html) or face up (null): a quarter turn to edge-on (sliding back to the middle
  // if it was dragged), swap the faces, then on round the same way from the other edge, so it reads as one turn of a
  // card with two sides. Turning back goes the other way. Without animation if the device asks for less motion.
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  function turn(el, html) {
    busy = true;
    el.querySelectorAll('.stamp').forEach(st => { st.style.opacity = 0; });
    const dir = html ? 1 : -1, half = still() ? 0 : 160;
    // The same function list as a drag's transform (plus rotateY), so it slides back while turning, smoothly.
    el.style.transition = half ? `transform ${half}ms ease-in` : 'none';
    el.style.transform = `translate(0px, 0px) rotate(0deg) rotateY(${90 * dir}deg)`;
    setTimeout(() => {
      el.querySelector('.face.back')?.remove();
      el.querySelector('.face.front').hidden = Boolean(html);
      el.classList.toggle('flipped', Boolean(html));
      const [yes, no] = html ? [back.yesLabel, back.noLabel] : [yesLabel, noLabel];
      el.querySelector('.stamp.yes').textContent = yes; el.querySelector('.stamp.no').textContent = no;
      setLabels(yes, no);
      flipped = null;
      if (html) {
        const face = document.createElement('div');
        face.className = 'face back'; face.innerHTML = html;
        el.append(face);
        flipped = { el, read: back.mount(face) };
      }
      el.style.transition = 'none';
      el.style.transform = `rotateY(${-90 * dir}deg)`;
      void el.offsetWidth; // start the second half from the far edge
      el.style.transition = half ? `transform ${half + 60}ms ease-out` : 'none';
      el.style.transform = 'rotateY(0deg)';
      setTimeout(() => { el.style.transition = ''; el.style.transform = ''; busy = false; }, half + 80);
    }, half);
  }

  async function decide(yes, el = deck.querySelector('.card.top'), extra = {}) {
    if (busy || !el || !queue.length) return;
    if (flipped?.el === el) {
      if (!yes) return turn(el, null);
      extra = { ...extra, back: flipped.read() };
    } else if (yes && back) {
      const html = back.render(queue[0]);
      if (html) return turn(el, html);
    }
    busy = true;
    const item = queue[0];
    el.style.transform = flyout(yes);
    el.style.opacity = '0';
    try {
      if ((await onSwipe(item, yes, extra)) === KEEP_CARD) {
        // e.g. a guest swiped yes: put the card back instead of using it up (face up).
        el.style.transform = ''; el.style.opacity = '';
        el.querySelectorAll('.stamp').forEach(st => { st.style.opacity = 0; });
        busy = false;
        if (flipped?.el === el) turn(el, null);
        return;
      }
    } catch (e) {
      toast(e.message); // stale card (e.g. event closed): drop it anyway
    }
    used.add(item.id);
    queue.shift();
    if (flipped?.el === el) { flipped = null; setLabels(yesLabel, noLabel); }
    setTimeout(() => { busy = false; draw(); }, 250);
  }

  const attachDrag = (el) => dragToSwipe(el, (yes) => decide(yes, el), (d) => { dragging = d; });

  root.querySelector('.round.yes').onclick = () => decide(true);
  root.querySelector('.round.no').onclick = () => decide(false);
  mountDeck.keyHandler = (e) => {
    if (e.target.matches('input, textarea, select') || document.querySelector('.overlay, .sheet')) return;
    if (e.key === 'ArrowRight') decide(true);
    if (e.key === 'ArrowLeft') decide(false);
  };
  draw();

  // Take in a fresh list without starting over: cards still in it keep their place (with the new data), new ones
  // go at the end, and ones gone from it drop out. Swiped cards stay gone. Returns false, changing nothing, while a
  // card is moving (being dragged, flying out, or coming back); the caller can try again later.
  return {
    update(fresh) {
      if (busy || dragging || flipped || !document.body.contains(deck)) return false;
      const byId = new Map(fresh.filter(x => !used.has(x.id)).map(x => [x.id, x]));
      const shown = queue.slice(0, 2).map(x => x.id + JSON.stringify(x)).join('|');
      const kept = queue.filter(x => byId.has(x.id)).map(x => byId.get(x.id));
      const ids = new Set(kept.map(x => x.id));
      queue.splice(0, queue.length, ...kept, ...[...byId.values()].filter(x => !ids.has(x.id)));
      if (queue.slice(0, 2).map(x => x.id + JSON.stringify(x)).join('|') !== shown) draw();
      return true;
    },
  };
}
document.addEventListener('keydown', (e) => mountDeck.keyHandler?.(e));

// A discard pile, under a deck: full cards already answered, newest first, each labelled with the answer. Swipe one
// again, or use its button, to change it. items: [{ yes, ... }] (yes: the answer now); label(item) → [class, text];
// onChange(item, yes) saves the new answer and redraws (false: nothing changed, put the card back). onDelete(item),
// if given, adds a Delete button that removes the card from the pile for good (false: put it back). Returns
// { busy() }, so a refresh can wait until a change is done.
function mountPile(el, { items, renderCard, label, onChange, onDelete, yesLabel, noLabel }) {
  let busy = false;
  el.hidden = !items.length;
  el.innerHTML = !items.length ? '' : `
      <h2 class="section-title pile-title">Discard Pile</h2>
      <p class="note">Changed your mind? Swipe a card again, or use its button.${onDelete ? ' Delete one to clear it out of here for good.' : ''}</p>
      <div class="pile-list">${items.map((it, i) => {
        const [cls, text] = label(it);
        return `
        <div class="card flat pile-card ${it.yes ? 'in' : 'pass'}" data-i="${i}">
          <div class="stamp yes">${esc(yesLabel)}</div><div class="stamp no">${esc(noLabel)}</div>
          <span class="label ${cls}">${esc(text)}</span>
          ${renderCard(it)}
          <div class="pile-actions">
            ${onDelete ? '<button type="button" class="btn small" data-delete>Delete</button>' : ''}
            <button type="button" class="btn small" data-flip>Change to ${esc(it.yes ? noLabel : yesLabel)}</button>
          </div>
        </div>`;
      }).join('')}</div>`;
  el.querySelectorAll('.pile-card').forEach(card => {
    const it = items[card.dataset.i];
    const restore = () => { card.style.transform = ''; card.style.opacity = ''; card.querySelectorAll('.stamp').forEach(st => { st.style.opacity = 0; }); };
    const change = async (yes) => {
      if (busy || yes === it.yes) return restore(); // already that way: spring back
      busy = true;
      card.style.transform = `translate(${yes ? 600 : -600}px, 0)`; card.style.opacity = '0';
      try { if ((await onChange(it, yes)) === false) restore(); }
      catch (err) { toast(err.message); restore(); }
      finally { busy = false; }
    };
    card.querySelector('[data-flip]').onclick = () => change(!it.yes);
    const del = card.querySelector('[data-delete]');
    if (del) del.onclick = async () => {
      if (busy) return;
      busy = true;
      card.style.opacity = '0';
      try { if ((await onDelete(it)) === false) restore(); }
      catch (err) { toast(err.message); restore(); }
      finally { busy = false; }
    };
    dragToSwipe(card, (yes) => change(yes));
  });
  return { busy: () => busy };
}

// ---------- views ----------

// Unread chat messages in Plans. What I've read is kept in the vault, so reading a chat on one device clears it on all
// of them: chatRead is { channel: the highest n of the other side's chat messages I've had open }. Accounts from
// before this have no chatRead; their first one counts everything already there as read, so old chats don't all
// light up at once.
const theirChats = (m) => m.state.timeline.filter(t => t.event === 'chat' && t.role !== m.role);
const theirLastN = (m) => Math.max(0, ...theirChats(m).map(t => t.n || 0));
function unreadCount(m) {
  const read = vault.data.chatRead;
  if (!read || isBlocked({ guid: m.other })) return 0;
  return theirChats(m).filter(t => !t.deleted && (t.n || 0) > (read[m.ch] || 0)).length;
}
let chatReadSaving = null;
function markChatsRead(ms) {
  if (!hasKeys() || chatReadSaving) return chatReadSaving;
  const read = vault.data.chatRead || {}, todo = ms.filter(m => theirLastN(m) > (read[m.ch] || 0));
  if (vault.data.chatRead && !todo.length) return null;
  chatReadSaving = vault.update(api, (d) => {
    d.chatRead ||= {};
    for (const m of todo) d.chatRead[m.ch] = Math.max(d.chatRead[m.ch] || 0, theirLastN(m));
  }).catch(err => console.warn('chatRead', err)).finally(() => { chatReadSaving = null; });
  return chatReadSaving;
}
// The plans whose chats count toward the Plans badge: everything listed there (a deleted past plan isn't).
function unreadPlans(view = mailView()) {
  if (!view || !hasKeys()) return [];
  const deleted = new Set(vault.data.deletedPlans || []);
  return mailMatches(view).filter(m => m.status !== 'waitlisted' && !deleted.has(m.ch));
}

// Tab badges: connection requests from the server, plus requests from the mail (public/mail.js), and unread messages
// in Plans' chats.
function badgeCounts() {
  const c = state.me?.counts || {}, m = mailView()?.badges || {};
  const plans = unreadPlans();
  if (mailView() && hasKeys() && !vault.data.chatRead) markChatsRead(plans); // first time: start from here
  return {
    confirm: (c.confirm || 0) + (m.confirm || 0) + (hasKeys() ? invitesForMe().length : 0),
    plans: plans.reduce((n, p) => n + unreadCount(p), 0),
  };
}

function shell(content) {
  const me = state.me, c = badgeCounts();
  const tabs = me ? TABS : GUEST_TABS;
  // The page's name under the board. The account screen is "Unlock" for someone signed in without their keys here.
  const title = state.tab === 'account' ? (me ? 'Unlock' : 'Sign in') : state.tab === 'feedback' ? 'Feedback' : TABS.find(t => t.id === state.tab)?.label || '';
  // Under the board on every screen: Bored is in alpha, and asks for feedback (the feedback page, once signed in).
  app.innerHTML = `
    <header class="top">
      <a class="logo board wide" href="/about" title="About Bored">Bored?</a>
      <p class="alpha-note"><em>Alpha:</em> Bored is new and still changing.
        <button type="button" class="link" id="feedbackLink" ${state.tab === 'feedback' ? 'aria-current="page"' : ''}>Share what you think</button></p>
      <h1 class="page-title">${esc(title)}</h1>
    </header>
    <main id="view"></main>
    <nav class="tabs" style="grid-template-columns: repeat(${tabs.length}, 1fr)">
      ${tabs.map(t => {
        const n = t.id === 'confirm' ? c.confirm : t.id === 'plans' ? c.plans : 0;
        return `<button data-tab="${t.id}" class="${state.tab === t.id ? 'active' : ''}" aria-label="${t.label}" title="${t.label}"
          ${state.tab === t.id ? 'aria-current="page"' : ''}>${TAB_ICONS[t.id]}${n ? `<span class="badge">${n}</span>` : ''}</button>`;
      }).join('')}
    </nav>`;
  app.querySelectorAll('nav.tabs button').forEach(b => b.onclick = () => go(b.dataset.tab));
  document.getElementById('feedbackLink').onclick = openFeedback;
  content(document.getElementById('view'));
  drawTour();
}

function go(tab) { state.tab = tab; state.chat = null; render(); }
// The feedback page needs an account (posts are filed under it), so anyone else is sent to sign in first.
function openFeedback() {
  if (state.me && hasKeys()) return go('feedback');
  toast('Sign in to send feedback.');
  if (state.tab !== 'account') go('account');
}

// Network trouble (no connection, a timeout, or the server restarting), as opposed to an answer about the account.
// Phones hit it all the time (waking up, switching networks), so it must never look like being signed out.
const transient = (e) => e instanceof TypeError || e?.status === 408 || e?.status === 429 || e?.status >= 500;
// Signed out only when the server says so (a 401 also clears the keys, in api()); network trouble keeps who I am.
async function refreshMe() {
  try { state.me = await api('/api/me'); } catch (e) { if (!transient(e)) state.me = null; }
}
// fn, tried again after network trouble: 3 tries, 1 and 2 seconds apart.
async function retrying(fn, tries = 3) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) { if (!transient(e) || i >= tries - 1) throw e; await new Promise(r => setTimeout(r, 1000 * 2 ** i)); }
  }
}
// Shown when Bored can't be reached at startup, instead of the sign-in screen: nothing on this device is lost.
function showOffline() {
  app.innerHTML = `<main class="offline stack"><h1>Can't reach Bored</h1>
    <p>Check your connection and try again. You're still signed in.</p>
    <button class="btn" id="retryStart">Try again</button></main>`;
  document.getElementById('retryStart').onclick = () => location.reload();
}

// The browser's Back and Forward buttons move between screens (a tab, or a plan's chat on Plans): each new screen
// render() shows is a history entry, and going back shows the one before it. Without this, Back left the site.
let historyStarted = false, replaceScreen = false;
function syncHistory(forced) {
  const here = { tab: state.tab, chat: state.chat || null }, was = history.state;
  if (was && was.tab === here.tab && was.chat === here.chat) return; // the same screen, redrawn
  // The first screen, one the app chose itself (sign in, unlock), or closing a chat with its back arrow takes the
  // current entry's place, so Back never lands on a screen that just sends you on again.
  const replace = !historyStarted || forced || replaceScreen;
  historyStarted = true; replaceScreen = false;
  // A chat opened from its plan's list: the chat's back arrow can be the browser's Back.
  const entry = { ...here, fromList: !replace && !!here.chat && was?.tab === here.tab && !was?.chat };
  history[replace ? 'replaceState' : 'pushState'](entry, '', location.href);
}
window.addEventListener('popstate', (e) => {
  if (!e.state?.tab) return;
  state.tab = e.state.tab; state.chat = e.state.chat || null;
  render();
});

async function render() {
  mountDeck.keyHandler = null;
  stopFresh(); // the new view starts its own, if it has one
  const asked = state.tab;
  // Signed in, but this browser doesn't hold the keys (e.g. keys were cleared): unlock with a passkey first.
  if (state.me && !hasKeys()) state.tab = 'account';
  if (!state.me && !GUEST_TABS.some(t => t.id === state.tab)) state.tab = 'discover';
  syncHistory(state.tab !== asked);
  const views = {
    discover: viewDiscover, confirm: viewConfirm, plans: viewPlans, post: viewPost, profile: viewProfile, account: viewAccount,
    feedback: viewFeedback,
  };
  shell((v) => views[state.tab](v).catch(err => toast(err.message)));
  maybeStartTour();
}

// ---------- tutorial ----------
// A short tour the first time someone signed in opens the app (people skim the About page): the five steps from
// the About page's "How it works", one at a time, in a box above the tab bar. Each step points at its tab and, once
// you're there, at the thing to use. It doesn't move you around on its own: "Show me", Next, and Back do.
// Finishing or skipping it is saved in the vault (prefs.tutorialSeen), so it shows once per account; a switch in
// Profile's settings turns it back on. The highlighting is CSS keyed on <body data-tour-tab data-tour> (public/style.css), so it
// survives views redrawing themselves.
const TOUR = [
  { tab: 'profile', target: '#newInvite', title: 'Connect', text: `Welcome to Bored! Here's how it works, in five steps. First, invite your
    friends: on Profile, create an invitation and send them the link. Once you're connected, you can share posts with
    just them.` },
  { tab: 'post', target: '#postIdea', title: 'Post', text: `Post something you want to do or need help with. ${Tap} an idea to fill in the
    form, or write your own. When, where, and cost are optional: leave them blank and play it by ear.` },
  { tab: 'discover', target: '#deckHost', title: 'Discover', text: `Swipe through what other people have posted: right means “I'm in,” and
    left means pass. Open the filters to narrow it down by tags, distance, date, and more.` },
  { tab: 'confirm', target: '#deckHost', title: 'Confirm', text: `When people want to join your posts, they show up here. Swipe right for
    “Let's do it,” or left if you're not feeling it. There's no obligation.` },
  { tab: 'plans', title: 'Plan', text: `When you both say yes, it's on, and it shows up in Plans. Chat to sort out the
    details, ${tap} When to add it to your calendar, and then go do the thing!` },
];
let tour = null; // { step, el }
let tourDone = false; // finished or skipped in this session, even if saving that to the vault failed

function maybeStartTour() {
  if (tour || tourDone || !state.me || !hasKeys() || vault.data.prefs?.tutorialSeen) return;
  if (pendingInvite()) return; // the invitation's sheet comes first; the tour starts on the next draw
  startTour();
}
function startTour() {
  tour = { step: 0, el: null };
  drawTour();
}
async function tourGo(step) {
  tour.step = step;
  go(TOUR[step].tab); // draws the tour too (shell)
  window.scrollTo(0, 0);
  // Views load asynchronously: wait a moment for the step's target, then bring it into view (Connect's is far down).
  const sel = TOUR[step].target;
  for (let i = 0; sel && i < 30 && tour?.step === step; i++) {
    const el = document.querySelector(`#view ${sel}`);
    if (el) {
      const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
      return el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
    }
    await new Promise(r => setTimeout(r, 100));
  }
}
async function endTour() {
  tour?.el?.remove();
  tour = null; tourDone = true;
  drawTour();
  const pref = document.getElementById('tutorialPref'); // Profile's switch, if it's showing
  if (pref) pref.checked = false;
  if (!vault.data.prefs?.tutorialSeen) {
    try { await vault.update(api, (d) => { d.prefs = { ...d.prefs, tutorialSeen: true }; }); } catch (err) { console.warn('tutorial', err); }
  }
}
// Profile's "Show the tutorial" switch: on starts it again from step 1 (and it shows until finished or skipped,
// even after a reload); off ends it.
async function setTutorial(on) {
  if (!on) return endTour();
  tourDone = false;
  try { await vault.update(api, (d) => { d.prefs = { ...d.prefs, tutorialSeen: false }; }); } catch (err) { console.warn('tutorial', err); }
  if (!tour) startTour();
  tourGo(0);
}
function drawTour() {
  const body = document.body;
  // Hidden on the sign-in or unlock screen, and on the feedback page, which isn't one of the steps' tabs.
  if (!tour || !state.me || !hasKeys() || state.tab === 'account') {
    delete body.dataset.tourTab; delete body.dataset.tour;
    if (tour?.el) tour.el.hidden = true;
    return;
  }
  const s = TOUR[tour.step], here = state.tab === s.tab && !state.chat, last = tour.step === TOUR.length - 1;
  body.dataset.tourTab = s.tab;
  if (here) body.dataset.tour = s.tab; else delete body.dataset.tour;
  if (!tour.el) {
    tour.el = document.createElement('aside');
    tour.el.className = 'tour';
    tour.el.setAttribute('aria-labelledby', 'tourTitle');
    tour.el.addEventListener('click', (e) => {
      const a = e.target.closest('[data-tour-action]')?.dataset.tourAction;
      if (a === 'skip' || a === 'done') endTour();
      else if (a === 'next') tourGo(tour.step + 1);
      else if (a === 'back') tourGo(tour.step - 1);
      else if (a === 'show') tourGo(tour.step);
    });
    body.append(tour.el);
  }
  tour.el.hidden = false;
  const tabName = TABS.find(t => t.id === s.tab).label;
  tour.el.innerHTML = `
    <p class="tour-count">Step ${tour.step + 1} of ${TOUR.length}</p>
    <h2 id="tourTitle">${esc(s.title)}</h2>
    <p>${s.text.replace(/\s+/g, ' ')}</p>
    <div class="tour-actions">
      <button type="button" class="link" data-tour-action="skip">Skip the tutorial</button>
      ${here ? '' : `<button type="button" class="btn ghost small" data-tour-action="show">Show me ${esc(tabName)}</button>`}
      ${tour.step ? '<button type="button" class="btn ghost small" data-tour-action="back">Back</button>' : ''}
      <button type="button" class="btn ghost small" data-tour-action="${last ? 'done' : 'next'}">${last ? 'Done' : 'Next'}</button>
    </div>`;
}

// The feedback page (public/feedback.js, first written for Glaze Journal). It's drawn once per account and kept, so
// a half-written post survives the app redrawing and a trip to another tab.
// Each post and reply comes with its author's icon hash (the SHA-1 of their GUID, like `icon` elsewhere): everyone's
// avatar is drawn from it, and matched against my contacts (and blocked people) to show the name I gave them.
let feedbackPage = null; // { guid, el, page }
let feedbackPeople = {}; // icon hash → GUID, for me, my contacts, and people I blocked
async function knownIcons() {
  const guids = [state.me.guid, ...Object.keys(vault.data.contacts), ...Object.values(mod().blocked).map(b => b.guid)].filter(Boolean);
  return Object.fromEntries(await Promise.all([...new Set(guids)].map(async g => [await sha1Hex(g), g])));
}
function feedbackAuthor(key) {
  const guid = feedbackPeople[key];
  return { icon: guid ? personAvatar(guid, 'small') : avatar(key, 'small'), name: guid ? contactName(guid) : '', hidden: Boolean(guid && isBlocked({ guid })) };
}
async function viewFeedback(v) {
  feedbackPeople = await knownIcons().catch(() => feedbackPeople);
  if (feedbackPage?.guid !== state.me.guid) {
    const el = document.createElement('div');
    const page = mountFeedback(el, {
      buttonClass: 'btn ghost small', primaryClass: 'btn', actionClass: 'btn small', author: feedbackAuthor,
      intro: isDemo()
        ? `Ideas, problems, or questions? In this demo only you and the developers can see what you post here. ${Tap} a post to open its chat. Please don't include anything personal.`
        : `Ideas, problems, or questions? Everyone signed in can read what's posted here and see your profile icon, and people you're connected with see the name they gave you. It isn't encrypted, so please don't include anything personal. ${Tap} a post to open its chat, where anyone can reply.`,
    });
    feedbackPage = { guid: state.me.guid, el, page };
  } else if (!state.feedbackThread) feedbackPage.page.refresh();
  v.replaceChildren(feedbackPage.el);
  // From a notification: open that post's chat.
  if (state.feedbackThread) { feedbackPage.page.open(state.feedbackThread); state.feedbackThread = null; }
}

// After any successful sign-in/sign-up/unlock.
// Ask the browser to keep this site's storage (the keys in IndexedDB) even when the device is short on space;
// otherwise it may clear it, and the account has to be unlocked again. Chromium decides quietly, Firefox may ask.
function keepStorage() {
  navigator.storage?.persisted?.().then(kept => kept || navigator.storage.persist()).catch(() => {});
}

async function enterApp(tab = 'discover') {
  keepStorage();
  await refreshMe();
  await vault.load(api);
  await ensureKeys(api);
  await syncConnections();
  await loadMail().catch(err => console.warn(err));
  syncAudiences().catch(err => console.warn(err));
  state.tab = tab; state.chat = null;
  render();
  offerPendingInvite();
  syncPush();
}

// ---------- push notifications ----------
// Opt-in per device, from Profile. The service worker (sw.js) shows them; the server sends them (push.js).
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
async function swRegistration() {
  return (await navigator.serviceWorker.getRegistration()) || navigator.serviceWorker.register('/sw.js');
}
async function pushSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}
async function turnOnPush() {
  if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications are blocked for this site.');
  const reg = await swRegistration();
  const { publicKey } = await api('/api/push/key');
  let sub;
  try {
    sub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u.dec(publicKey) });
  } catch (e) {
    // The browser couldn't reach its push service. On Android, Chromium-based browsers deliver web notifications
    // through Google Play services, so phones without them (e.g. GrapheneOS) get "push service error".
    if (e?.name === 'AbortError' || /push service/i.test(e?.message || '')) {
      throw new Error("This browser couldn't reach its push service. On Android, most browsers need Google Play services for notifications. Without them (e.g. on GrapheneOS), use ntfy, below, or turn on sandboxed Google Play and use a browser like Chrome.");
    }
    throw e;
  }
  await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
}
async function turnOffPush() {
  const sub = await pushSubscription();
  if (!sub) return;
  await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe();
}
// Keep the server's record of this device in step, e.g. after signing in as someone else on it.
async function syncPush() {
  if (!state.me || !pushSupported() || Notification.permission !== 'granted') return;
  const sub = await pushSubscription().catch(() => null);
  if (sub) api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() }).catch(() => {});
}
// Go where a tapped notification says: 'confirm', 'plans', 'profile', 'discover', 'feedback' (also the About page's
// Feedback button), 'feedback:<id>' (that post's chat), or 'mail' (see mailDestination).
function openScreen(open) {
  if (open === 'feedback') return openFeedback();
  if (open?.startsWith('feedback:')) { state.feedbackThread = open.slice(9); return openFeedback(); }
  if (open === 'mail') return openMail();
  if (!open || !state.me || !['confirm', 'plans', 'profile', 'discover'].includes(open)) return;
  state.tab = open; state.chat = null;
  render();
}
// Mail is encrypted, so the server's notification only says "New activity". The newest thing in my mail is almost
// certainly what it was about: a match's chat (or what happened in it), a request waiting for my answer, or an
// invitation to connect. Anything else, like a private post shared with me, is in Discover.
function mailDestination(view) {
  const channels = [
    ...(view?.requests || []).map(r => ({ r, host: false })),
    ...(view?.hosting || []).flatMap(h => h.requests.map(r => ({ r, host: true }))),
  ].sort((a, b) => b.r.updatedAt - a.r.updatedAt);
  // Invitations sent before they carried a time count as oldest.
  const newest = channels[0], invites = invitesForMe(), inviteAt = Math.max(0, ...invites.map(i => Number(i.at) || 0));
  if (invites.length && (!newest || inviteAt >= newest.r.updatedAt)) return { tab: 'confirm' };
  if (!newest) return { tab: 'discover' };
  const { r, host } = newest;
  if (['accepted', 'attended', 'withdrawn', 'called-off'].includes(r.status)) return { tab: 'plans', chat: `m:${r.id}` };
  if (r.status === 'waitlisted') return { tab: 'plans' };
  if (host && r.status === 'pending') return { tab: 'confirm' };
  return { tab: 'discover' };
}
async function openMail() {
  if (!state.me || !hasKeys()) return;
  const { tab, chat = null } = mailDestination(await loadMail().catch(() => mailView()));
  state.tab = tab; state.chat = chat;
  render();
}
// Profile's Notifications section, which depends on the browser and this device's state.
async function drawPushSettings(el) {
  const ios = isIos(), standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  let note = '', on = false, canToggle = false;
  if (!pushSupported()) {
    note = ios && !standalone
      ? 'On iPhone and iPad, first add Bored to your Home Screen (Share, then Add to Home Screen), open it from there, and turn notifications on here.'
      : "This browser doesn't support notifications.";
  } else if (Notification.permission === 'denied') {
    note = "Notifications are blocked for this site. Allow them in your browser's site settings, then come back here.";
  } else {
    on = Boolean(await pushSubscription().catch(() => null)) && Notification.permission === 'granted';
    canToggle = true;
    note = on ? "On for this device. You'll hear about join requests, matches, messages, and changes to your plans."
      : 'Get notified on this device about join requests, matches, messages, and changes to your plans.';
  }
  el.innerHTML = `
    <p class="note">${note}</p>
    <details class="help" ${ios && !standalone ? 'open' : ''}>
      <summary>How to turn them on</summary>
      <p><b>iPhone and iPad</b> (iOS 16.4 or newer): notifications only work once Bored is on your Home Screen.
        Open it in Safari, tap Share, then <b>Add to Home Screen</b>. Open Bored from the new icon, come back here,
        and tap <b>Turn on notifications</b>.</p>
      <p><b>Android</b>: they work right in the browser (Chrome, Firefox, and others). Tap <b>Turn on
        notifications</b> and allow them when asked. If you like, add Bored to your home screen too (the browser's
        menu, then <b>Add to Home screen</b> or <b>Install app</b>) so it opens like an app.</p>
      <p>Turn them on separately on each device. If you said no by mistake, allow notifications for this site in
        your browser's site settings.</p>
    </details>
    ${canToggle ? `<div class="two">
      <button type="button" class="btn" data-push-toggle>${on ? 'Turn off' : 'Turn on notifications'}</button>
      ${on ? '<button type="button" class="btn" data-push-test>Send a test</button>' : ''}</div>` : ''}`;
  el.querySelector('[data-push-toggle]')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { if (on) { await turnOffPush(); toast('Notifications off for this device'); } else { await turnOnPush(); toast('Notifications on'); } }
    catch (err) { toast(err.message); }
    drawPushSettings(el);
  });
  el.querySelector('[data-push-test]')?.addEventListener('click', () =>
    api('/api/push/test', { method: 'POST' }).then(() => toast('Sent. It should arrive in a moment.'), err => toast(err.message)));
}

// Profile's ntfy block, for phones without Google Play services (server.js, "ntfy"): one random topic per account,
// which the person subscribes to in the ntfy app on each phone. "Send a test" goes everywhere, Web Push included.
async function drawNtfySettings(el) {
  let nt;
  try { nt = await api('/api/ntfy'); } catch { el.innerHTML = ''; return; }
  if (!nt.servers.length) { el.innerHTML = ''; return; }
  const t = nt.topic, url = t ? `${t.server}/${t.topic}` : '';
  const host = (s) => new URL(s).host;
  el.innerHTML = `
    <h3 class="sub-title">Phones without Google Play services</h3>
    ${t ? `
      <p class="note">ntfy is on. In the ntfy app, subscribe to this topic on each phone you want notifications on:</p>
      <code class="ntfy-topic">${esc(url)}</code>
      <div class="two">
        <a class="btn ghost" href="ntfy://${esc(host(t.server))}/${esc(t.topic)}">Open in ntfy</a>
        <button type="button" class="btn ghost" data-ntfy-copy>Copy</button>
      </div>
      <button type="button" class="btn" data-push-test>Send a test</button>
      <p class="note">Keep the topic to yourself: anyone who has it can read these notifications. If it got out, get a
        new one (then subscribe to the new one in the app).</p>
      <div class="two">
        <button type="button" class="btn small" data-ntfy-new>New topic</button>
        <button type="button" class="btn small" data-ntfy-off>Turn off ntfy</button>
      </div>`
    : `
      <p class="note">On phones without Google Play services, like GrapheneOS, browsers can't get notifications.
        Bored can send them through <b>ntfy</b> instead, a free app (on F-Droid and Google Play).</p>
      <details class="help">
        <summary>How it works</summary>
        <p>Bored makes a private, random topic for you. Subscribe to it in the ntfy app, and Bored's notifications
          arrive there. Tapping one opens Bored.</p>
        <p>Unlike browser notifications, these aren't encrypted: the ntfy server${nt.servers.length === 1 ? ` (${esc(host(nt.servers[0]))})` : ''},
          and anyone who learns your topic, can read them. They only ever say things like “New activity”, never
          names, posts, or messages.</p>
      </details>
      ${nt.servers.length > 1 ? `<label>ntfy server
        <select data-ntfy-server>${nt.servers.map(s => `<option value="${esc(s)}">${esc(host(s))}</option>`).join('')}</select></label>` : ''}
      <button type="button" class="btn" data-ntfy-on>Set up ntfy</button>`}`;
  const run = (fn, msg) => async (e) => {
    e.currentTarget.disabled = true;
    try { await fn(); if (msg) toast(msg); } catch (err) { toast(err.message); }
    drawNtfySettings(el);
  };
  el.querySelector('[data-ntfy-on]')?.addEventListener('click', run(() =>
    api('/api/ntfy', { method: 'POST', body: { server: el.querySelector('[data-ntfy-server]')?.value || nt.servers[0] } }),
    'ntfy is set up. Now subscribe to the topic in the ntfy app.'));
  el.querySelector('[data-ntfy-new]')?.addEventListener('click', (e) => {
    if (!confirm('Get a new topic? The old one stops getting notifications, so subscribe to the new one in the ntfy app.')) return;
    run(() => api('/api/ntfy', { method: 'POST', body: { server: t.server } }), 'New topic. Subscribe to it in the ntfy app.')(e);
  });
  el.querySelector('[data-ntfy-off]')?.addEventListener('click', (e) => {
    if (!confirm('Turn off ntfy? Notifications stop going to your topic.')) return;
    run(() => api('/api/ntfy/off', { method: 'POST' }), 'ntfy is off')(e);
  });
  el.querySelector('[data-ntfy-copy]')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(url); toast('Topic copied. In the ntfy app, tap + and paste it.'); }
    catch { toast(url); }
  });
  el.querySelector('[data-push-test]')?.addEventListener('click', () =>
    api('/api/push/test', { method: 'POST' }).then(() => toast('Sent. It should arrive in a moment.'), err => toast(err.message)));
}

const PASSKEY_ADVICE = `Your passkey <b>is</b> your account: there's no email or password to recover it with.
  Add a second passkey in Profile (another device or a security key), so losing one device doesn't lose your account.`;
const UPGRADE_ADVICE = `Bored encrypts your contacts and chats with a key that only your passkey can make, using a
  passkey feature called <b>PRF</b>. This browser or passkey manager doesn't support it. <b>Some password managers,
  including Bitwarden, don't support it yet.</b><br><br>
  Passkeys that do: a <b>security key</b> (YubiKey 5, Nitrokey 3, SoloKey 2, and similar), <b>Google Password
  Manager</b> (Chrome, Android) and <b>iCloud Keychain</b> (Safari on macOS/iOS 18 or newer).`;

const idHost = () => new URL(state.config.idOrigin).host;

// AUTH_MODE=6j0: one button for sign-in, sign-up, and unlock; the identity server handles the passkey.
function viewAccountId(v) {
  const unlocking = Boolean(state.me);
  v.innerHTML = `
    <div class="account stack">
      <p class="lead">${unlocking ? 'Unlock your account with your 6j0.org identity to see your contacts and chats.'
        : `Swipe through what's happening nearby, and when you and the host both say yes, it's on.
           Join something fun, or host your own.`}</p>
      <button class="btn" id="idSignIn">${unlocking ? 'Unlock' : 'Continue'} with ${esc(idHost())}</button>
      <div class="error" id="authErr"></div>
      <div class="notice"><b>No names or email.</b> Bored uses your anonymous 6j0.org identity: one sign-in, with a
        username and password, for every 6j0.org app. New here? You can create one on the next screen.
        Nobody sees a name for you unless they've connected with you, and then only the nickname <em>they</em> chose.
        Your contacts and chats are encrypted with a key only you can unlock.</div>
      ${unlocking ? `<button class="btn" id="logout">Sign out</button>` : ''}
      ${ABOUT_LINKS}
    </div>`;
  v.querySelector('#idSignIn').onclick = async () => {
    try { await startIdSignIn(state.config); } catch (e) { v.querySelector('#authErr').textContent = e.message; }
  };
  v.querySelector('#logout')?.addEventListener('click', signOut);
}

// Sign up, sign in, or unlock (signed in but keys missing in this browser). Shown as a tab for guests.
async function viewAccount(v) {
  if (state.config.authMode === '6j0') return viewAccountId(v);
  const unlocking = Boolean(state.me);
  const support = await prfSupport();
  v.innerHTML = `
    <div class="account stack">
      <p class="lead">${unlocking ? 'Unlock your account with your passkey to see your contacts and chats.'
        : `Swipe through what's happening nearby, and when you and the host both say yes, it's on.
           Join something fun, or host your own.`}</p>
      ${unlocking ? `<button class="btn" id="signIn">Unlock with passkey</button>` : `
        <button class="btn" id="signIn">Sign in with passkey</button>
        <button class="btn" id="create" ${support === false ? 'disabled' : ''}>Create an account</button>`}
      <div class="error" id="authErr"></div>
      <div class="notice ${support === false ? 'warn' : ''}" id="authNote">${support === false ? UPGRADE_ADVICE : `
        <b>No usernames, passwords, or email.</b> You get an anonymous account protected by a passkey.
        Nobody sees a name for you unless they've connected with you, and then only the nickname <em>they</em> chose.
        <br><br>${PASSKEY_ADVICE}`}</div>
      ${unlocking ? `<button class="btn" id="logout">Sign out</button>` : ''}
      ${ABOUT_LINKS}
    </div>`;
  const err = v.querySelector('#authErr'), note = v.querySelector('#authNote');
  const fail = (e) => {
    if (e instanceof PrfUnsupportedError) {
      note.classList.add('warn');
      note.innerHTML = UPGRADE_ADVICE + `<br><br>If a "Bored" passkey was just saved, you can delete it from your passkey manager.`;
      err.textContent = '';
    } else if (e?.name === 'NotAllowedError') err.textContent = 'Passkey request was cancelled or timed out.';
    else err.textContent = e.message;
  };
  v.querySelector('#signIn').onclick = async () => {
    err.textContent = '';
    try { await signIn(api); await enterApp(); toast('Welcome back!'); } catch (e) { fail(e); }
  };
  v.querySelector('#create')?.addEventListener('click', async () => {
    err.textContent = '';
    try {
      await createAccount(api, nextStep);
      await enterApp('profile');
      toast('Account created! Add a second passkey below so you never get locked out.');
    } catch (e) { fail(e); }
  });
  v.querySelector('#logout')?.addEventListener('click', signOut);
}

// "Tap to continue" between passkey prompts (Safari allows only one prompt per tap). Rejects if dismissed.
function nextStep(message, button = 'Continue') {
  return new Promise((resolve, reject) => {
    const cancel = () => { close(); reject(Object.assign(new Error('Cancelled'), { name: 'NotAllowedError' })); };
    // No closing by tapping outside: a stray tap mid-sign-up would cancel it.
    const { sheet, close } = openSheet(`<div class="stack panel" aria-live="polite">
      <h2>One more step</h2><p class="note">${esc(message)}</p>
      <div class="two"><button type="button" class="btn ghost" id="stepCancel">Cancel</button>
        <button type="button" class="btn" id="stepGo">${esc(button)}</button></div></div>`, { onDismiss: cancel, backdrop: false });
    sheet.querySelector('#stepGo').onclick = () => { close(); resolve(); };
    sheet.querySelector('#stepCancel').onclick = cancel;
    sheet.querySelector('#stepGo').focus();
  });
}

async function signOut() {
  await turnOffPush().catch(() => {}); // a signed-out device shouldn't get this account's notifications
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  await clearKeys();
  resetMail();
  state.me = null; state.tab = 'discover'; state.chat = null;
  if (isDemo()) return startDemo();
  render();
}

// ---------- deleting an account ----------
// At the bottom of Profile. With Bored's own accounts (and in the demo), the server erases everything it holds for
// the account (POST /api/account/delete in server.js) once you type the last 4 characters of your Account ID, which
// is just below. With a 6j0.org identity, the account belongs to the identity, so it's deleted at the identity
// server (its "Delete your identity", at /#delete), along with the identity's accounts on every other 6j0.org
// service; the identity server then tells this server (/api/id/deleted), which erases the account.
function deleteAccountHtml(idMode) {
  if (idMode) return `<div class="section-title">Delete account</div>
    <div class="notice warn">You sign in with a 6j0.org identity, so your Bored account is deleted along with it, at
      ${esc(idHost())}. <b>Deleting your identity deletes all of your accounts on 6j0.org services</b>, Bored
      included, and everything in them. There's no recovery. Bored erases your account as soon as it hears. Remove
      the posts you're hosting first (in Post), so the people they're shared with are told.</div>
    <button type="button" class="btn ghost" id="deleteAtId">Go to ${esc(idHost())}</button>`;
  return `<div class="section-title">Delete account</div>
    <div class="notice warn"><b>Deleting your account erases everything Bored's server has for it, right away, and
      there's no recovery.</b> That's your keys and encrypted vault (contacts, nicknames, and settings), your posts,
      your requests to join, your side of every chat, your invitations and connections, the posts you reported, your
      feedback and replies, and your notifications. Posts you're hosting that are still on are cancelled first, so
      the people they're shared with are told. People you've chatted with keep their own side of the chat.
      ${isDemo() ? 'This demo account would be deleted after a day anyway; you get a fresh one right after.' : ''}</div>
    <form class="stack" id="deleteAccount">
      <label>To confirm, type the last 4 characters of your Account ID. It's at the very bottom of this page.
        <input name="confirm" maxlength="4" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>
      <button class="btn" type="submit">Delete my account</button>
    </form>`;
}
function mountDeleteAccount(v) {
  v.querySelector('#deleteAtId')?.addEventListener('click', () => location.assign(`${state.config.idOrigin}/#delete`));
  v.querySelector('#deleteAccount')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget, code = form.confirm.value.trim(), btn = form.querySelector('button[type=submit]');
    if (code.toLowerCase() !== state.me.guid.slice(-4).toLowerCase())
      return toast("That doesn't match. Type the last 4 characters of the Account ID at the bottom of this page.");
    btn.disabled = true; btn.textContent = 'Deleting…';
    try { await deleteAccount(code); } catch (err) { toast(err.message); btn.disabled = false; btn.textContent = 'Delete my account'; }
  });
}
async function deleteAccount(code) {
  // Cancel the posts I'm hosting that are still on first: the cancellations reach the people they're shared with
  // through their own inboxes, which aren't erased, so their Discover and Plans say it's off.
  await loadMail().catch(err => console.warn(err));
  for (const h of mailView()?.hosting || []) {
    if (LIVE.includes(h.post.status)) await cancelPost(h.post.pid).catch(err => console.warn('cancel', err));
  }
  const inboxes = await myInboxTokens();
  await turnOffPush().catch(() => {});
  await api('/api/account/delete', { method: 'POST', body: { confirm: code, inboxes } });
  await clearKeys();
  resetMail();
  tour?.el?.remove(); tour = null;
  state.me = null; state.tab = 'discover'; state.chat = null;
  toast('Your account is deleted.');
  if (isDemo()) return startDemo();
  render();
}

// Demo mode: a fresh account with demo posts, requests, plans, and chats, and nicknames for the demo people.
const isDemo = () => state.config.authMode === 'demo';
async function startDemo() {
  const res = await createDemoAccount(api);
  await refreshMe();
  await vault.load(api);
  await vault.update(api, (d) => { d.profile = { ...d.profile, name: 'Demolition Man' }; }); // the demo visitor's name
  await addContacts(Object.keys(res.names || {}), res.names);
  await ensureKeys(api);
  await seedDemo().catch(err => console.warn('demo seed', err));
  await enterApp('discover');
}
// Only this browser can sign this account's posts, so it makes the demo ones itself; the demo people (a bot on the
// server, see demo.js) answer as it goes.
async function seedDemo() {
  const plan = await api('/api/demo/seed', { method: 'POST' });
  for (const p of plan.posts) await savePost({ kind: 'private', fields: p.fields, audience: { groups: [], contacts: p.share }, guids: p.share });
  const view = await loadMail({ act: false });
  for (const pid of plan.join) { const post = view.posts.get(pid); if (post) await requestJoin(post); }
}

// Where a post happens, as HTML: its place (linked to the map), "Online", or both ("City Hall and online").
// e.online: 0 in person, 1 online only, 2 both. '' when nothing is known.
function whereHtml(e) {
  const place = e.online !== 1 && (e.location || e.location_name) ? locationHtml(e.location, '', { name: e.location_name }) : '';
  return e.online === 1 ? 'Online' : e.online === 2 ? `${place || 'In person'} and online` : place;
}

// A Discover card: each detail has a label, and no emoji. who: HTML for the people line at the bottom, in place of
// the host's (Plans says who's going), which also has a button to report the post or block its host. mine: it's my
// own post. Someone else's post has the words my filters catch starred out.
function eventCard(t, { who = null, mine = false } = {}) {
  const fact = (label, value) => `<dt>${label}</dt><dd>${value}</dd>`;
  // My own post is shown as I wrote it, with a note naming the words others see starred out (starredNote).
  const starred = mine ? starredNote(t) : '';
  if (!mine) t = { ...t, title: clean(t.title), details: clean(t.details), location_name: clean(t.location_name), tags: t.tags.map(clean) };
  const report = !mine && who === null && t.post?.pid && state.me && hasKeys()
    ? `<button type="button" class="link report-link" data-report="${esc(t.post.pid)}">Report or block</button>` : '';
  return `
    <div class="body">
      <h2>${esc(t.title)}</h2>
      ${t.status === 'full' && who === null ? `<div class="meta"><span class="chip warn" title="Say yes to join the waitlist">Full: join the waitlist</span></div>` : ''}
      <dl class="facts">
        ${t.when_text ? fact('When', `<button type="button" class="link" data-ics="${t.id}" title="Add to your calendar">${esc(whenLabel(t.when_text, t.end_text))}</button>`) : ''}
        ${whereHtml(t) ? fact('Where', whereHtml(t)) : ''}
        ${fact('Cost', esc(costLabel(t.cost_amount, t.cost_currency)))}
        ${fact('Max attendees', attendeesLabel(t.max_attendees))}
        ${t.tags.length ? fact('Tags', t.tags.map(x => '#' + esc(x)).join(' ')) : ''}
      </dl>
      ${t.details ? `<div class="details">${linkify(t.details)}</div>` : ''}
      ${starred}
      <div class="who">${who ?? `${personAvatar(t.host.guid, '', { pid: t.post?.pid, icon: t.host.icon })}
        <div>${contactName(t.host.guid) ? `<b>${esc(contactName(t.host.guid))}</b>` : ''}</div>${report}`}
      </div>
    </div>`;
}

// Posts from public/mail.js (encrypted private posts and signed public ones) as Discover cards, and the Discover
// filters for them. The browser filters them itself: the server never learns what you're looking for, or where.
// The host shows by name when they're a contact (a share says who it's from; a public post is matched by its
// signing key), otherwise as an icon made from their signing key.
const contactBySign = (key) => key && Object.keys(vault.data.contacts).find(g => vault.data.contacts[g].keys?.sign?.x === key.x && vault.data.contacts[g].keys?.sign?.y === key.y);
const mailCard = (p) => ({
  ...p, id: `m:${p.pid}`, post: p, visibility: p.kind, tags: p.tags || [],
  host: { guid: p.host || contactBySign(p.signer) || null, icon: p.signer ? `${p.signer.x}.${p.signer.y}` : null },
});
function distanceKm({ lat, lon }, location) {
  const m = /^(-?[\d.]+),(-?[\d.]+)$/.exec(location || '');
  if (!m) return Infinity;
  const rad = Math.PI / 180, dLat = (m[1] - lat) * rad, dLon = (m[2] - lon) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat * rad) * Math.cos(m[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a)); // Earth's mean diameter, km
}
function mailPostMatches(p) {
  const tags = state.discoverTags, costs = state.discoverCosts, near = state.discoverNear;
  const km = near && state.discoverRadius ? state.discoverRadius * kmPerUnit() : 0, online = state.discoverOnline;
  if (tags.size && !(p.tags || []).some(t => tags.has(t))) return false;
  if (costs.size && !costs.has(p.cost_amount > 0 ? 'paid' : 'free')) return false;
  if (state.discoverDate) { const [from, to] = dateFilterRange(state.discoverDate); if (!occursBetween(p.when_text, from, to, p.end_text)) return false; }
  if (km || online) return (km && distanceKm(near, p.location) <= km) || (online && p.online > 0);
  return true;
}
// Discover's search matches a post's title, details, place, and tags.
const postMatchesSearch = (p, words) => matchesWords([p.title, p.details, p.location_name, ...(p.tags || [])].join('\n'), words);
// How many posts each filter chip would show.
function postCounts(posts) {
  const tags = new Map(), cost = (p) => (p.cost_amount > 0 ? 'paid' : 'free'), near = state.discoverNear;
  for (const p of posts) for (const t of p.tags || []) tags.set(t, (tags.get(t) || 0) + 1);
  return {
    tags: [...tags].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
    costs: Object.keys(COST_FILTERS).map(c => ({ cost: c, count: posts.filter(p => cost(p) === c).length })),
    dates: Object.keys(DATE_FILTERS).map(key => { const [from, to] = dateFilterRange(key); return { key, count: posts.filter(p => occursBetween(p.when_text, from, to, p.end_text)).length }; }),
    distances: near ? RADII.map(r => ({ km: r * kmPerUnit(), count: posts.filter(p => distanceKm(near, p.location) <= r * kmPerUnit()).length })) : [],
    online: posts.filter(p => p.online > 0).length,
  };
}

async function viewDiscover(v) {
  // The hint goes right under the heading: under the deck, the tab bar would cover it on a phone. Guests have no
  // discard pile (their passes aren't kept).
  // Guests get a warning above everything: swiping looks like it does something, but nothing is saved or sent.
  v.innerHTML = `${state.me ? '' : `<div class="notice warn guest-warning" role="note">
      <b>You're not signed in, so swiping does nothing.</b> Passes aren't saved, and you can't ask to join anything.
      <button type="button" class="btn small" id="guestSignIn">Sign in or create an account</button></div>`}
    <p class="hint pile-hint">${state.me ? 'Scroll up to refresh. Scroll down to see your discard pile.' : 'Scroll up to refresh.'}</p>
    ${searchBoxHtml('Search posts')}
    <div class="filters" id="filters"></div>
    <p class="note mod-note" id="modNote" hidden></p>
    <div class="deck-host" id="deckHost"></div>
    <section class="pile" id="pile" aria-labelledby="pileTitle" hidden></section>`;
  const filtersEl = v.querySelector('#filters'), host = v.querySelector('#deckHost'), pileEl = v.querySelector('#pile');
  const modNote = v.querySelector('#modNote');
  v.querySelector('#guestSignIn')?.addEventListener('click', () => go('account'));
  let options = { tags: [], costs: [], dates: [] }, events = [], deck = null;
  let hidden = new Map(); // posts my moderation settings hide, from the deck and the discard pile (moderatePosts)

  // All the filters sit in one panel that opens and closes; its heading says how many are on.
  function drawFilters() {
    const selTags = state.discoverTags, selCosts = state.discoverCosts, selDate = state.discoverDate;
    const near = state.discoverNear, radius = near ? state.discoverRadius : 0;
    const online = state.discoverOnline;
    const on = selTags.size + selCosts.size + (selDate ? 1 : 0) + (radius ? 1 : 0) + (online ? 1 : 0);
    const dateCount = Object.fromEntries((options.dates || []).map(d => [d.key, d.count]));
    const distCount = Object.fromEntries(RADII.map((r, i) => [r, options.distances?.[i]?.count ?? 0]));
    // Keep selected tags visible even when no open posts carry them right now.
    const tags = [...options.tags, ...[...selTags].filter(t => !options.tags.some(a => a.tag === t)).map(tag => ({ tag, count: 0 }))];
    const chip = (kind, value, label, count, on, title = '') => `
      <button type="button" class="chip filter ${on ? 'on' : ''}" data-${kind}="${esc(value)}" aria-pressed="${on}" ${title ? `title="${esc(title)}"` : ''}>
        ${label} <span class="n">${count}</span></button>`;
    filtersEl.innerHTML = `
      <div class="filter-box">
        <div class="filter-head">
          <button type="button" class="filter-toggle" data-filters-toggle aria-expanded="${state.filtersOpen}" aria-controls="filterBody">Filters${on ? ` <span class="badge">${on}</span>` : ''}</button>
          ${on ? `<button type="button" class="chip filter clear" data-clear>Clear all</button>` : ''}
        </div>
        <div class="filter-body" id="filterBody" ${state.filtersOpen ? '' : 'hidden'}>
          <div class="filter-row" role="group" aria-label="Filter by date"><span class="label">When</span>
            ${Object.entries(DATE_FILTERS).map(([key, label]) => chip('date', key, label, dateCount[key] ?? 0, selDate === key)).join('')}</div>
          <div class="filter-row" role="group" aria-label="Filter by distance"><span class="label">Near</span>
            <button type="button" class="chip filter" data-near-pick title="${near ? 'Change your location' : 'Pick your location on a map'}">${near ? esc(near.label) : 'Pick on map'}</button>
            <button type="button" class="chip filter" data-near-gps>Use my location</button>
            ${near ? RADII.map(r => chip('radius', r, `Within ${esc(fmtDistance(r))}`, distCount[r], radius === r)).join('') : ''}
            ${chip('online', '1', radius ? 'Or online' : 'Online', options.online ?? 0, online,
              radius ? 'Also show online posts' : 'Only show online posts')}</div>
          ${tags.length ? `<div class="filter-row" role="group" aria-label="Filter by tag"><span class="label">Tags</span>
            ${tags.map(({ tag, count }) => chip('tag', tag, `#${esc(tag)}`, count, selTags.has(tag))).join('')}</div>` : ''}
          <div class="filter-row" role="group" aria-label="Filter by cost"><span class="label">Cost</span>
            ${options.costs.map(({ cost, count }) => chip('cost', cost, esc(COST_FILTERS[cost]), count, selCosts.has(cost))).join('')}
          </div>
        </div>
      </div>`;
  }

  // soft: an automatic refresh, which merges into the deck instead of starting it over, and leaves the filters
  // alone unless their counts changed.
  async function load({ soft = false } = {}) {
    const mail = await loadMail().catch(err => { console.warn(err); return mailView(); });
    // Posts my moderation settings hide (blocked hosts, reports, and word lists that hide posts) are left out of the
    // deck and the discard pile, before the filters, so their counts don't include them either.
    hidden = await moderatePosts([...(mail?.deck || []), ...(state.me ? mail?.swiped || [] : [])]);
    if (!document.body.contains(host)) return;
    const posts = (mail?.deck || []).filter(p => !hidden.has(p.pid));
    modNote.hidden = !hidden.size;
    modNote.innerHTML = `${hidden.size === 1 ? '1 post is' : `${hidden.size} posts are`} hidden by ${state.me ? 'your' : 'the default'} moderation settings.${
      state.me && hasKeys() ? ' <button type="button" class="link" data-mod-settings>Change them</button>' : ''}`;
    allPosts = posts; swiped.clear();
    apply({ soft });
    if (!pile?.busy()) drawPile();
  }
  // The deck and the filters' counts from the posts load() last got: the search, then the filters. Typing a search
  // calls this alone, without fetching again. The filters' counts are within the search.
  let allPosts = [];
  const swiped = new Set(); // swiped since allPosts was loaded, so a new search doesn't bring them back
  function apply({ soft = false } = {}) {
    const near = state.discoverNear, words = searchWords(searchQuery());
    const found = allPosts.filter(p => !swiped.has(p.pid) && postMatchesSearch(p, words));
    events = found.filter(mailPostMatches).map(mailCard);
    const before = JSON.stringify(options);
    options = postCounts(found);
    if (!soft || JSON.stringify(options) !== before) drawFilters();
    if (soft && deck) deck.update(events);
    else deck = mountDeck(host, swipeTracked(deckOptions(events, drawPile, { query: searchQuery(), tags: [...state.discoverTags], costs: [...state.discoverCosts], date: state.discoverDate,
      near: [near && state.discoverRadius && `Within ${fmtDistance(state.discoverRadius)} of ${near.label.toLowerCase()}`,
        state.discoverOnline && 'online'].filter(Boolean).join(' or ').replace(/^online$/, 'Online') })));
  }
  const swipeTracked = (opts) => ({ ...opts, onSwipe: async (t, ...rest) => { const r = await opts.onSwipe(t, ...rest); if (r !== KEEP_CARD) swiped.add(t.pid); return r; } });
  // The discard pile: cards I've swiped (passed, or asked to join and still waiting), newest first, each labelled with
  // my answer. Swipe one again, or use its button, to change it. Signed in only: a guest's passes aren't kept.
  let pile = null, pileCards = [];
  function drawPile() {
    pileCards = (state.me ? mailView()?.swiped || [] : []).filter(p => !hidden.has(p.pid)).map(p => ({ ...mailCard(p), yes: p.swipe === 'in', request: p.request }));
    pile = mountPile(pileEl, {
      items: pileCards, renderCard: eventCard, yesLabel: "I'm in", noLabel: 'Pass',
      label: (c) => c.yes ? ['in', c.request === 'waitlisted' ? "I'm in · waitlist" : "I'm in"] : ['pass', 'Pass'],
      onChange: async (c, yes) => { await reswipe(c.post, c, yes); drawPile(); },
      // Deleting a request I'm still waiting on takes it back first (the host hasn't answered yet).
      onDelete: async (c) => {
        if (c.yes && !confirm(`Delete “${c.title}” from your discard pile? Your request to join it is taken back.`)) return false;
        if (c.yes) await reswipe(c.post, c, false);
        await deletePassed(c.pid);
        toast(`Deleted “${c.title}” from your discard pile`);
        drawPile();
      },
    });
  }
  // Change a swipe: pass → I'm in asks to join; I'm in → pass takes the request back (while the host hasn't
  // answered) and passes.
  async function reswipe(p, c, yes) {
    if (yes) {
      const ask = await askJoin(p);
      if (!ask) return; // cancelled: nothing changes
      await requestJoin(p, ask.note, ask.interest);
      await unpass(p.pid);
      toast(p.status === 'full' ? `Asked to join the waitlist for “${p.title}”` : `Asked to join “${p.title}”! You'll match if the host swipes yes too.`);
      return;
    }
    // Read first: the host may have said yes since the pile was drawn, and a match can't be taken back here.
    const answered = 'They already said yes. Message them in Plans if you need to back out.';
    const ch = mailView()?.swiped.find(x => x.pid === p.pid)?.ch;
    const status = async () => (await loadMail().catch(() => mailView()))?.requests.find(x => x.id === ch)?.status;
    if (!['pending', 'waitlisted'].includes(await status())) throw new Error(answered);
    await sendOn(ch, { type: 'unjoin' });
    if ((await status()) !== 'cancelled') throw new Error(answered); // they answered while this was sent
    await pass(p.pid);
    toast(`Took back your request to join “${p.title}”`);
  }

  // Clearing the filters keeps your location; it only turns the distance off.
  const clearAll = () => { state.discoverTags.clear(); state.discoverCosts.clear(); state.discoverDate = ''; state.discoverRadius = 0; state.discoverOnline = false; };
  const setNear = (lat, lon, label) => {
    state.discoverNear = { lat, lon, label };
    if (!state.discoverRadius) state.discoverRadius = DEFAULT_RADIUS;
  };
  const refresh = () => { saveDiscoverFilters(); load().catch(err => toast(err.message)); };
  const toggle = (set, value) => (set.has(value) ? set.delete(value) : set.add(value));

  mountSearch(v, () => apply());

  filtersEl.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-near-pick')) {
      const n = state.discoverNear;
      const v = await pickLocation(n ? `${n.lat},${n.lon}` : '', '', {
        title: 'Your location', nameField: false, clearLabel: 'Forget my location',
        note: 'Drop the pin where you are, to see posts nearby. It stays on this device: posts are filtered right here, so the server never learns where you are.',
      });
      if (v === undefined) return;
      if (v) { const [lat, lon] = v.location.split(',').map(Number); setNear(lat, lon, 'Picked spot'); }
      else { state.discoverNear = null; state.discoverRadius = 0; }
      return refresh();
    }
    if (b.hasAttribute('data-near-gps')) {
      if (!navigator.geolocation) return toast("This browser can't share your location.");
      b.disabled = true;
      navigator.geolocation.getCurrentPosition(
        ({ coords }) => { setNear(coords.latitude, coords.longitude, 'Current location'); refresh(); },
        () => { b.disabled = false; toast("Couldn't get your location. You can pick it on the map instead."); },
        { timeout: 15000, maximumAge: 300000 });
      return;
    }
    if (b.hasAttribute('data-filters-toggle')) {
      state.filtersOpen = !state.filtersOpen;
      b.setAttribute('aria-expanded', String(state.filtersOpen));
      filtersEl.querySelector('.filter-body').hidden = !state.filtersOpen;
      return;
    }
    if (b.hasAttribute('data-clear')) clearAll();
    else if (b.dataset.tag) toggle(state.discoverTags, b.dataset.tag);
    else if (b.dataset.cost) toggle(state.discoverCosts, b.dataset.cost);
    else if (b.dataset.date) state.discoverDate = state.discoverDate === b.dataset.date ? '' : b.dataset.date;
    else if (b.dataset.online) state.discoverOnline = !state.discoverOnline;
    else if (b.dataset.radius) state.discoverRadius = state.discoverRadius === Number(b.dataset.radius) ? 0 : Number(b.dataset.radius);
    refresh();
  });
  v.addEventListener('click', (e) => {
    const cal = e.target.closest('[data-ics]');
    if (cal) addToCalendar([...events, ...pileCards].find(t => String(t.id) === cal.dataset.ics));
    if (e.target.id === 'goPost') go('post');
    if (e.target.closest('[data-mod-settings]')) { state.focus = 'moderation'; go('profile'); }
    if (e.target.id === 'clearFilters') { clearAll(); state.search.discover = v.querySelector('.tab-search input').value = ''; saveDiscoverFilters(); load().catch(err => toast(err.message)); }
  });
  await load();

  keepFresh(host, () => load({ soft: true }));
}

// After "I'm in" (a swipe right, the button, or →): how interested they are (0 to 5 stars, optional) and a note for
// the host (optional), then Send request or Cancel. Resolves to { note, interest } (interest null if not picked), or
// null if cancelled. Both are sealed to the host with the request, so only they see them.
const MAX_JOIN_NOTE = 280; // what requestJoin keeps (public/mail.js)
const INTEREST_LABELS = ['Just curious', 'A little interested', 'Somewhat interested', 'Interested', 'Very interested', "Can't wait"];
const starsText = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
// The optional extras when asking to join: how interested (0 to 5 stars, or not rated) and a note for the host. On
// the back of a Discover card (mountDeck's back), and in askJoin's dialog for a card in the discard pile.
// intro: the sentence at the top, saying both are optional and how to skip them; rows: the note box's height.
const joinExtrasHtml = (intro, rows = 3) => `
  <p class="join-intro">${intro}</p>
  <fieldset class="interest">
    <legend>How interested are you?</legend>
    <div class="interest-picks" role="radiogroup" aria-label="How interested are you, 0 to 5 stars">
      <button type="button" class="interest-zero" role="radio" aria-checked="false" data-interest="0" aria-label="0 stars: ${esc(INTEREST_LABELS[0])}">0</button>
      ${[1, 2, 3, 4, 5].map(n => `<button type="button" class="interest-star" role="radio" aria-checked="false" data-interest="${n}"
        aria-label="${n} star${n === 1 ? '' : 's'}: ${esc(INTEREST_LABELS[n])}">☆</button>`).join('')}
    </div>
    <p class="note interest-label" aria-live="polite">Not rated. Only the host sees it.</p>
  </fieldset>
  <label>A note for the host
    <textarea name="note" rows="${rows}" maxlength="${MAX_JOIN_NOTE}" placeholder="e.g. I have a spare headlamp if anyone needs one."></textarea></label>
  <p class="note"><span class="note-count">0 / ${MAX_JOIN_NOTE}</span> · Only the host can read it, with your request.</p>`;
// Wires up joinExtrasHtml inside root; returns read() → { note, interest } (interest: 0 to 5, or null).
function mountJoinExtras(root) {
  const box = root.querySelector('textarea[name=note]'), count = root.querySelector('.note-count');
  let interest = null;
  // Tapping the picked rating again clears it.
  const pick = (n) => {
    interest = interest === n ? null : n;
    root.querySelectorAll('[data-interest]').forEach(b => {
      const v = Number(b.dataset.interest);
      b.setAttribute('aria-checked', String(v === interest));
      if (v > 0) { b.textContent = interest !== null && v <= interest ? '★' : '☆'; b.classList.toggle('on', interest !== null && v <= interest); }
      else b.classList.toggle('on', interest === 0);
    });
    root.querySelector('.interest-label').textContent = interest === null ? 'Not rated. Only the host sees it.'
      : `${interest} of 5: ${INTEREST_LABELS[interest]}. Only the host sees it.`;
  };
  root.querySelectorAll('[data-interest]').forEach(b => b.onclick = () => pick(Number(b.dataset.interest)));
  box.addEventListener('input', () => { count.textContent = `${box.value.length} / ${MAX_JOIN_NOTE}`; });
  return () => ({ note: box.value.trim(), interest });
}
function askJoin(t) {
  return new Promise((resolve) => {
    const done = (v) => { close(); resolve(v); };
    const { sheet, close } = openSheet(`
      <form class="stack panel">
        <h2>Ask to join</h2>
        <p><b>${esc(t.title)}</b></p>
        ${joinExtrasHtml('These are optional. Leave them blank to just send your request.')}
        <div class="two">
          <button type="button" class="btn ghost" data-cancel>Cancel</button>
          <button class="btn">Send request</button>
        </div>
      </form>`, { onDismiss: () => done(null) });
    const read = mountJoinExtras(sheet);
    sheet.querySelector('[data-cancel]').onclick = () => done(null);
    sheet.querySelector('form').onsubmit = (e) => { e.preventDefault(); done(read()); };
    sheet.querySelector('.interest-star').focus();
  });
}
// changed: called after a swipe or an undo is saved (Discover redraws the discard pile).
function deckOptions(events, changed, filters) {
  return {
    items: events,
    renderCard: eventCard,
    yesLabel: "I'm in", noLabel: 'Pass',
    // Saying yes turns the card over: the back has the optional rating and note for the host, and swiping right
    // again sends the request (with or without them); left turns it back. Guests get no back (they sign in first).
    back: {
      yesLabel: 'Send request', noLabel: 'Back',
      render: (t) => state.me ? `<div class="body join-back">
        <h2>Ask to join</h2>
        <p class="join-title"><b>${esc(t.title)}</b></p>
        ${joinExtrasHtml('These are optional. Swipe right again to skip them and send your request.', 2)}</div>` : null,
      mount: mountJoinExtras,
    },
    onSwipe: async (t, yes, extra = {}) => {
      if (!state.me) {
        // Guests can browse; passing is just local, but saying yes needs an account.
        if (yes) { toast('Sign in or create an account to say yes.'); go('account'); return KEEP_CARD; }
        return;
      }
      if (!yes) { await pass(t.pid); return changed(); }
      // From the card's back: how interested they are and a note for the host (both optional).
      const ask = extra.back || await askJoin(t);
      if (!ask) return KEEP_CARD;
      t.ch = await requestJoin(t.post, ask.note, ask.interest);
      changed();
      toast(t.status === 'full'
        ? `Asked to join the waitlist for “${t.title}”. If the host says yes, you'll get the next open spot.`
        : `Asked to join “${t.title}”! You'll match if the host swipes yes too.`);
    },
    // No undo: the discard pile, under the deck, is where a swipe is changed.
    empty: filters.query || filters.tags.length || filters.costs.length || filters.date || filters.near
      ? `<div class="empty"><h3>No matches${filters.query ? '' : ' for these filters'}</h3>
          <p>${[filters.query && `“${esc(filters.query)}”`, filters.near && esc(filters.near), filters.date && esc(DATE_FILTERS[filters.date]), filters.tags.length && filters.tags.map(t => '#' + esc(t)).join(' or '), filters.costs.length && filters.costs.map(c => esc(COST_FILTERS[c])).join(' or ')].filter(Boolean).join(' · ')}</p>
          <p>Nothing open matches right now. Try ${filters.query ? 'other words or filters' : 'other filters'}, or see everything.</p>
          <button class="btn ghost" id="clearFilters">Show all posts</button></div>`
      : `<div class="empty"><h3>Still bored?</h3>
          ${state.me
            ? `<p>Nothing new right now. Check back later, or post something you think people would enjoy.</p>
          <button class="btn ghost" id="goPost">Post something</button>`
            : `<p>Nothing new right now. Check back later.</p>`}</div>`,
  };
}

// Confirm: people asking to join my posts, and people asking to connect through my invitation links.
function connectCard(c) {
  return `
      <div class="hero">${avatar(c.requester.icon, 'big')}</div>
      <div class="body">
        <div class="meta"><span class="chip">Wants to connect${c.via ? ` through your invitation as “${esc(c.via)}”` : ''}</span></div>
        <h2>${c.suggested ? esc(clean(c.suggested)) : 'Someone'}</h2>
        ${c.suggested ? '<p class="note">The nickname they suggest for themselves. You can change it after you connect.</p>' : ''}
        <p>They opened one of your invitation links and asked to connect. If you say yes, you'll be in each other's
          contacts and can share private posts with each other.</p>
      </div>`;
}

// Requests to join my encrypted posts: anonymous until I say yes (the person's name and contact come with the match).
function mailRequests(view) {
  return (view?.hosting || []).filter(h => LIVE.includes(h.post.status)).flatMap(h => h.requests
    .filter(r => r.status === 'pending')
    .map(r => ({ kind: 'mail', id: `m:${r.id}`, ch: r.id, from: r.from, pid: h.post.pid, title: h.post.title, note: r.note, interest: r.interest, full: h.status === 'full' })));
}
// A yes on a full post puts them on the waitlist, as the server does for the posts it stores.
function mailAnswer(view, pid) {
  const h = view?.hosting.find(x => x.post.pid === pid);
  const max = h?.post.max_attendees ?? null;
  return max !== null && h.counts.accepted + h.counts.attended >= max ? 'waitlisted' : 'accepted';
}
// A contact who asked says who they are (checked when the mail is read), so they show by the nickname I gave them.
const mailRequestCard = (o) => {
  const known = Boolean(o.from) && isContact(o.from);
  return `
      <div class="hero">${known ? personAvatar(o.from, 'big') : avatar(null, 'big')}</div>
      <div class="body">
        <div class="meta"><span class="chip">Wants to join: <b>${esc(o.title)}</b></span></div>
        ${known ? `<h2>${esc(displayName(o.from) || 'One of your contacts')}</h2>` : ''}
        ${o.interest != null ? `<p class="interest-shown" aria-label="${o.interest} of 5 stars: ${esc(INTEREST_LABELS[o.interest])}"><span class="stars" aria-hidden="true">${starsText(o.interest)}</span> ${esc(INTEREST_LABELS[o.interest])}</p>` : ''}
        ${o.note ? `<div class="details">“${esc(clean(o.note))}”</div>` : ''}
        ${o.full ? `<p class="note">This post is full, so saying yes puts them on the waitlist. They'll be matched automatically when a spot opens.</p>` : ''}
        <p class="note">${known ? "One of your contacts." : "Someone you don't know yet: you'll see who it is once you say yes."}</p>
      </div>`;
};

// An invitation to connect someone mailed to me (they clicked my avatar on one of my posts).
const inviteCard = (o) => `
      <div class="hero">${avatar(o.icon, 'big')}</div>
      <div class="body">
        <div class="meta"><span class="chip">Wants to connect</span></div>
        <h2>${o.name ? esc(clean(o.name)) : 'Someone'}</h2>
        ${o.name ? '<p class="note">The name they suggest for themselves. You can change it after you connect.</p>' : ''}
        <p>They invited you to connect. If you say yes, you'll be in each other's contacts and can share private posts
          with each other.</p>
      </div>`;

async function viewConfirm(v) {
  v.innerHTML = `${searchBoxHtml('Search requests')}
    <p class="hint pile-hint">Scroll up to refresh. Scroll down to see your discard pile.</p>
    <div class="deck-host" id="deckHost"></div>
    <section class="pile" id="pile" hidden></section>`;
  const host = v.querySelector('#deckHost'), pileEl = v.querySelector('#pile');
  // Their suggested nickname, decrypted with the key of the invitation they used (kept in my vault).
  const withNames = async (requests) => {
    for (const c of requests) {
      const inv = c.invite_id && inviteOf(c.invite_id);
      c.via = inv?.name || '';
      c.suggested = inv?.key && c.note ? await openForInvite(inv.key, c.note) : null;
    }
    return requests;
  };
  // Invitations mailed to me, with the inviter's icon; ones that don't apply any more (mine, already connected or
  // asked, deleted) are answered and dropped.
  const checkInvites = async (list, declined) => {
    const out = [];
    for (const i of list) {
      const info = await previewInvite(i.token).catch(() => ({ skip: 'gone' }));
      if (info.skip) await answerInvite(i.token).catch(() => {});
      else out.push({ ...i, kind: 'invite', id: `i:${i.token}`, icon: info.icon, info, yes: false, at: i.at || 0 });
    }
    return out;
  };
  // People I've blocked get a no without being shown: requests to join from a contact who said who they are, and
  // requests to connect and invitations, which come with the icon of the person's GUID.
  const blockedIcons = async () => new Set(await Promise.all(Object.values(mod().blocked).filter(b => b.guid).map(b => sha1Hex(b.guid))));
  const load = async () => {
    const [all, mail] = await Promise.all([api('/api/connection-requests'), loadMail().catch(() => mailView())]);
    const icons = await blockedIcons();
    const requests = [];
    for (const c of await withNames(await confirmDirectInvites(all))) {
      if (!icons.has(c.requester.icon)) requests.push(c);
      else await api(`/api/connection-requests/${c.id}/respond`, { method: 'POST', body: { yes: false } }).catch(() => {});
    }
    const invites = [];
    for (const i of await checkInvites(invitesForMe())) {
      if (!icons.has(i.icon)) invites.push(i);
      else await answerInvite(i.token).catch(() => {});
    }
    const joins = [];
    for (const o of mailRequests(mail)) {
      if (!(o.from && isBlocked({ guid: o.from }))) joins.push(o);
      else await sendOn(o.ch, { type: 'answer', status: 'declined' }).catch(() => {});
    }
    return [...requests.map(c => ({ ...c, kind: 'connect' })), ...invites, ...joins];
  };

  // The discard pile: what I've answered and can still change. Requests to join I said no to, waitlisted, or said yes
  // to without chatting yet (after that, it's changed from Plans); connection requests and invitations I said no to.
  const sqlTime = (t) => Date.parse(String(t || '').replace(' ', 'T') + 'Z') || 0;
  const loadPile = async () => {
    const declined = await withNames(await api('/api/connection-requests?answered=1').catch(() => []));
    const mail = (mailView()?.hosting || []).filter(h => LIVE.includes(h.post.status)).flatMap(h => h.requests
      .filter(r => r.status === 'declined' || r.status === 'waitlisted' || (r.status === 'accepted' && !r.chatted))
      .map(r => ({ kind: 'mail', id: `m:${r.id}`, ch: r.id, pid: h.post.pid, title: h.post.title, note: r.note, interest: r.interest, from: r.from,
        guid: r.hello.attendee?.guid || null, status: r.status, yes: r.status !== 'declined', at: r.updatedAt })));
    const icons = await blockedIcons();
    return [
      ...mail.filter(o => !isBlocked({ guid: o.from || o.guid })),
      ...declined.filter(c => !icons.has(c.requester.icon)).map(c => ({ ...c, kind: 'connect', yes: false, at: sqlTime(c.created_at) })),
      ...(await checkInvites(declinedInvites())).filter(i => !icons.has(i.icon)),
    ].sort((a, b) => b.at - a.at);
  };
  const renderCard = (o) => o.kind === 'connect' ? connectCard(o) : o.kind === 'invite' ? inviteCard(o) : mailRequestCard(o);
  // Answer a request to join, and say what happened.
  const answerJoin = async (o, yes) => {
    const status = yes ? mailAnswer(mailView(), o.pid) : 'declined';
    await sendOn(o.ch, { type: 'answer', status });
    if (status === 'accepted') showMatch(o.from && isContact(o.from) ? o.from : null, o.title, `m:${o.ch}`);
    else if (status === 'waitlisted') toast(`Added them to the waitlist for “${o.title}”`);
    loadMail().then(shellRefreshBadges, () => {}); // say hello, so each side knows who the other is
  };
  const connected = async (r, o) => {
    await refreshMe();
    if (!r.connected) return;
    await addContacts([r.guid], o.suggested ? { [r.guid]: o.suggested } : {});
    toast(o.suggested ? `Connected with ${o.suggested}! Change their nickname if you like.` : "Connected! Give them a nickname only you'll see.");
    openContactSheet(r.guid, () => {});
  };

  let pile = null;
  // force: redraw even while a change is being saved (that change redraws when it's done).
  async function drawPile(force = false) {
    const items = await loadPile();
    if (!document.body.contains(pileEl) || (pile?.busy() && !force)) return;
    pile = mountPile(pileEl, {
      items, renderCard, yesLabel: "Let's do it", noLabel: 'No thanks',
      label: (o) => o.status === 'waitlisted' ? ['warn', 'Waitlist'] : o.yes ? ['in', "Let's do it"] : ['pass', 'No thanks'],
      onChange: async (o, yes) => {
        if (o.kind === 'invite') {
          if (await connectSheet({ token: o.token, key: o.key, name: o.name, info: o.info, ready: true }) !== 'sent') return false;
          await answerInvite(o.token); // no longer declined
        } else if (o.kind === 'connect') {
          await api(`/api/connection-requests/${o.id}/undo`, { method: 'POST' });
          await connected(await api(`/api/connection-requests/${o.id}/respond`, { method: 'POST', body: { yes: true } }), o);
        } else {
          // Read first: it may have changed since the pile was drawn (a chat started, the post filled up).
          const r = (await loadMail().catch(() => mailView()))?.hosting.flatMap(h => h.requests).find(x => x.id === o.ch);
          if (!r || r.status !== o.status) { drawPile(); throw new Error('That changed in the meantime. Have another look.'); }
          if (r.chatted) { drawPile(); throw new Error("You've already started chatting, so change it from Plans."); }
          await sendOn(o.ch, { type: 'undo' });
          await answerJoin(o, yes);
          if (!yes) toast(`Said no thanks for “${o.title}”`);
        }
        shellRefreshBadges();
        await drawPile(true);
      },
    });
  }

  // The search matches what's on each card: names, notes, and the post's title. A new search starts the deck over,
  // so the cards stay in order.
  let all = await load();
  const answered = new Set(); // swiped since `all` was loaded, so a new search doesn't bring them back
  const shown = () => { const words = searchWords(searchQuery()); return all.filter(o => !answered.has(o.id) && matchesWords(htmlText(renderCard(o)), words)); };
  const deckOpts = {
    renderCard,
    yesLabel: "Let's do it", noLabel: 'No thanks',
    onSwipe: async (o, yes) => {
      if (o.kind === 'invite') {
        // Yes asks for the names first; closing that without sending leaves the card where it was.
        if (yes && await connectSheet({ token: o.token, key: o.key, name: o.name, info: o.info, ready: true }) !== 'sent') return KEEP_CARD;
        await answerInvite(o.token, { declined: yes ? null : o });
      } else if (o.kind === 'connect') {
        await connected(await api(`/api/connection-requests/${o.id}/respond`, { method: 'POST', body: { yes } }), o);
      } else {
        await answerJoin(o, yes);
      }
      shellRefreshBadges();
      drawPile().catch(err => console.warn(err));
    },
    empty: `<div class="empty"><h3>Nobody to confirm</h3>
      <p>When someone asks to join one of your posts, or asks to connect through one of your invitation links,
        they'll show up here for you to answer.</p></div>`,
  };
  const emptySearch = () => `<div class="empty"><h3>No matches</h3><p>Nobody waiting matches “${esc(searchQuery())}”.</p></div>`;
  const mount = () => mountDeck(host, { ...deckOpts, items: shown(), empty: searchQuery() && all.length ? emptySearch() : deckOpts.empty,
    onSwipe: async (o, ...rest) => { const r = await deckOpts.onSwipe(o, ...rest); if (r !== KEEP_CARD) answered.add(o.id); return r; } });
  let deck = mount();
  mountSearch(v, () => { deck = mount(); });
  await drawPile();
  keepFresh(v, async () => { all = await load(); answered.clear(); deck.update(shown()); shellRefreshBadges(); await drawPile(); });
}

function showMatch(otherGuid, title, matchId) {
  const known = Boolean(otherGuid) && isContact(otherGuid);
  const o = document.createElement('div');
  o.className = 'overlay';
  o.innerHTML = `
    <h1>It's on!</h1>
    <div class="pair">${avatar(state.me.guid)}${avatar(otherGuid)}</div>
    <p>You and <b>${esc(known ? displayName(otherGuid) : 'someone new')}</b> are teaming up on<br><b>${esc(title)}</b></p>
    ${known ? '' : `<p style="opacity:.8;font-size:.9rem">Want to stay in touch afterwards? Invite them to connect from the chat. You'll only be contacts if you both say yes.</p>`}
    <button class="btn ghost" id="mChat">Send a message</button>
    <button class="btn ghost" id="mKeep">Keep swiping</button>`;
  document.body.appendChild(o);
  o.querySelector('#mKeep').onclick = () => { o.remove(); shellRefreshBadges(); };
  o.querySelector('#mChat').onclick = () => { o.remove(); state.tab = 'plans'; state.chat = matchId; render(); };
}

function shellRefreshBadges() {
  // Re-render only the nav badges without disturbing the current deck.
  const c = badgeCounts();
  app.querySelectorAll('nav.tabs button').forEach(b => {
    b.querySelector('.badge')?.remove();
    const n = b.dataset.tab === 'confirm' ? c.confirm : b.dataset.tab === 'plans' ? c.plans : 0;
    if (n) b.insertAdjacentHTML('beforeend', `<span class="badge">${n}</span>`);
  });
}

// Matches (public/mail.js), as rows for Plans. id is "m:<channel>".
// Waitlisted requests are only mine as an attendee. The other person is known from their hello (or, for a private
// post I asked to join, from the share it came in).
function mailMatches(view) {
  const row = (r, role, post) => {
    const other = r.hello[role === 'host' ? 'attendee' : 'host']?.guid || (role === 'attendee' ? post.host : null) || null;
    const last = [...r.timeline].reverse().find(t => t.event === 'chat' && !t.deleted);
    return { id: `m:${r.id}`, ch: r.id, role, status: r.status, reconfirm: r.reconfirm, other, state: r, post,
      title: post.title, when_text: post.when_text, end_text: post.end_text, location: post.location, location_name: post.location_name, online: post.online,
      last_message: last?.text || '' };
  };
  return [
    ...(view?.requests || []).filter(r => r.post && ['accepted', 'attended', 'withdrawn', 'called-off', 'waitlisted'].includes(r.status)).map(r => row(r, 'attendee', r.post)),
    ...(view?.hosting || []).flatMap(h => h.requests.filter(r => ['accepted', 'attended', 'withdrawn', 'called-off'].includes(r.status)).map(r => row(r, 'host', h.post))),
  ].sort((a, b) => b.state.updatedAt - a.state.updatedAt);
}
const nameOrSomeone = (guid) => displayName(guid) || 'Someone';

async function viewPlans(v) {
  if (state.chat) return viewChat(v, state.chat);
  const mail = await loadMail().catch(() => mailView());
  const matches = mailMatches(mail);
  // Unread counts too, since reading a chat on another device changes them without changing the mail.
  const key = (ms) => JSON.stringify([ms, ms.map(unreadCount)]), shown = key(matches);
  keepFresh(v, async () => {
    const m = mailMatches(await loadMail());
    if (key(m) !== shown && state.tab === 'plans' && !state.chat) { shellRefreshBadges(); await viewPlans(v); }
  });
  if (!matches.length) {
    v.innerHTML = `<div class="empty"><h3>No plans yet</h3>
      <p>Swipe right on something you'd like to join. When the host swipes yes on you, you'll match.</p>
      <button class="btn ghost" id="goD">Find something to do</button></div>`;
    v.querySelector('#goD').onclick = () => go('discover');
    return;
  }
  // Only past plans can be deleted (for a plan that's still on, "Can't make it" first moves it here). Deleting just
  // hides it from me, on all my devices; nobody is told.
  const deleted = new Set(vault.data.deletedPlans || []);
  const active = matches.filter(m => m.status === 'accepted'), waiting = matches.filter(m => m.status === 'waitlisted');
  const past = matches.filter(m => !['accepted', 'waitlisted'].includes(m.status) && !deleted.has(m.ch));
  // Full cards, like Discover's, each labelled with where the plan stands and who's in it. A card opens its chat.
  const label = (m) =>
    m.status === 'attended' ? ['done', 'Done']
    : m.status === 'withdrawn' ? ['done', 'Dropped out']
    : m.status === 'called-off' ? ['pass', 'Cancelled']
    : m.reconfirm ? ['warn', m.role === 'attendee' ? 'Re-confirm?' : 'Awaiting OK']
    : ['in', "It's on"];
  const who = (m) => `${personAvatar(m.other)}
    <div><b>${m.role === 'attendee' ? `Hosted by ${esc(nameOrSomeone(m.other))}` : `${esc(nameOrSomeone(m.other))} is going`}</b>
      ${m.last_message && !isBlocked({ guid: m.other }) ? `<small>${esc(clean(m.last_message))}</small>` : ''}</div>`;
  // A plan I'm hosting that's still on can be edited, like it can from Your posts.
  const hosted = (m) => m.role === 'host' && m.status === 'accepted'
    && (mail?.hosting || []).find(h => h.post.pid === m.post.pid && LIVE.includes(h.status));
  const card = (m, { deletable = false } = {}) => {
    const [cls, text] = label(m), unread = unreadCount(m);
    const unreadText = unread ? `, ${unread} unread message${unread === 1 ? '' : 's'}` : '';
    return `
    <div class="card flat plan-card" data-search-item role="button" tabindex="0" data-id="${m.id}" aria-label="Chat about ${esc(m.title)}${unreadText}">
      ${unread ? `<span class="badge unread" aria-hidden="true">${unread}</span>` : ''}
      <span class="label ${cls}">${esc(text)}</span>
      ${eventCard(mailCard(m.post), { who: who(m), mine: m.role === 'host' })}
      ${deletable ? `<div class="card-actions"><button class="btn small" data-delete-plan="${esc(m.ch)}">Delete</button></div>`
        : hosted(m) ? `<div class="card-actions"><button class="btn ghost small" data-edit-plan="${esc(m.post.pid)}">Edit</button></div>` : ''}
    </div>`;
  };
  // Waitlist cards have no chat yet: that opens when a spot does and they're matched.
  const waitCard = (m) => `
    <div class="card flat plan-card waiting" data-search-item>
      <span class="label warn">${m.waitlist_pos ? `Waitlist #${m.waitlist_pos}` : 'Waitlist'}</span>
      ${eventCard(mailCard(m.post), { who: `${personAvatar(m.other)}<div>${contactName(m.other) ? `<b>Hosted by ${esc(contactName(m.other))}</b>` : ''}</div>` })}
      <div class="card-actions"><button class="btn small" data-leave-ch="${esc(m.ch)}">Leave</button></div>
    </div>`;
  // The search matches what's on the cards: the plan, who's in it, and the newest message.
  v.innerHTML = `
    ${searchBoxHtml('Search plans')}
    ${active.length || past.length ? `<p class="hint plans-hint">${Tap} a card to chat. In a chat, ${tap} one of your messages to edit or delete it.</p>` : ''}
    <p class="note" data-search-none hidden></p>
    ${active.length ? `<section data-search-group><div class="section-title">Happening</div><div class="list">${active.map(card).join('')}</div></section>` : ''}
    ${waiting.length ? `<section data-search-group><div class="section-title">Waitlist</div>
      <p class="note">These posts are full. You'll be matched automatically, in order, when a spot opens.</p>
      <div class="list">${waiting.map(waitCard).join('')}</div></section>` : ''}
    ${past.length ? `<section data-search-group><div class="section-title">Past</div><div class="list">${past.map(m => card(m, { deletable: true })).join('')}</div></section>` : ''}`;
  mountSearch(v, (words) => filterShown(v, words));
  filterShown(v, searchWords(searchQuery()));
  const all = [...active, ...waiting, ...past];
  v.onclick = (e) => {
    const cal = e.target.closest('[data-ics]');
    if (cal) return addToCalendar(mailCard(all.find(m => m.id === cal.closest('[data-id]')?.dataset.id)?.post || {}));
    if (e.target.closest('a, button')) return; // the card's own links and buttons
    const c = e.target.closest('.plan-card[data-id]');
    if (c) { state.chat = c.dataset.id; render(); }
  };
  v.onkeydown = (e) => {
    const c = e.target.closest?.('.plan-card[data-id]');
    if (c && e.target === c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); state.chat = c.dataset.id; render(); }
  };
  v.querySelectorAll('[data-delete-plan]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this plan from Plans? Only you stop seeing it; nobody is told.')) return;
    const ch = b.dataset.deletePlan;
    try { await vault.update(api, (d) => { d.deletedPlans = [...new Set([...(d.deletedPlans || []), ch])]; }); toast('Deleted'); render(); }
    catch (err) { toast(err.message); }
  });
  v.querySelectorAll('[data-edit-plan]').forEach(b => b.onclick = () => {
    const h = (mail?.hosting || []).find(h => h.post.pid === b.dataset.editPlan);
    if (h) openPostSheet(hostedPost(h));
  });
  v.querySelectorAll('[data-leave-ch]').forEach(b => b.onclick = async () => {
    if (!confirm('Leave this waitlist?')) return;
    try { await sendOn(b.dataset.leaveCh, { type: 'unjoin' }); toast('Left the waitlist'); render(); }
    catch (err) { toast(err.message); }
  });
}

// The chat for a match on an encrypted post: the channel's timeline (chat and what happened), and its actions as
// messages on the channel. Re-checks for new mail every 5 seconds while open.
const mailSystemLine = (t, m) => ({
  promoted: "A spot opened up, so you're off the waitlist and in!",
  updated: `The post was updated: ${(t.changes || []).map(k => FIELD_LABELS[k] || k).join(', ') || 'details'}.${m.role === 'attendee' ? ' Please re-confirm you can still make it.' : ''}`,
  reconfirmed: 'Re-confirmed: still in!',
  'reconfirm-no': "Can't make it after the change, so dropped out.",
  left: "Can't make it anymore, so dropped out.",
  cancelled: m.role === 'host' ? 'You cancelled this plan.' : 'The host cancelled this plan.',
}[t.event]);

// Cancel one of my posts: everyone who asked to join, is in, or is waitlisted gets a cancel on their channel (so their
// Plans say it's cancelled), then the post is marked cancelled (so it leaves everyone's Discover).
async function cancelPost(pid) {
  const h = mailView()?.hosting.find(x => x.post.pid === pid);
  for (const r of h?.requests || []) {
    if (['pending', 'waitlisted', 'accepted'].includes(r.status)) await sendOn(r.id, { type: 'cancel' }).catch(err => console.warn('cancel', err));
  }
  await setPostStatus(pid, 'cancelled');
}

async function viewChat(v, id) {
  await loadMail().catch(() => {});
  const find = () => mailMatches(mailView()).find(x => x.id === id);
  const m = find();
  if (!m || m.status === 'waitlisted') { state.chat = null; return viewPlans(v); }
  const name = nameOrSomeone(m.other);
  // Matching doesn't connect anyone: either side can invite the other, from what they said in their hello.
  const theirHello = m.state.hello[m.role === 'host' ? 'attendee' : 'host'];
  const canConnect = Boolean(m.other && theirHello?.chat && theirHello?.inbox && !isContact(m.other));
  v.innerHTML = `
    <div class="chat">
      <div class="chat-head">
        <button class="back" aria-label="Back">←</button>
        ${personAvatar(m.other)}
        <div class="grow" style="flex:1;min-width:0">
          <b>${esc(name)}</b>
          <div class="sub" style="color:var(--muted);font-size:.85rem">${esc(m.title)}${m.when_text ? ` · <button type="button" class="link cal-link" id="addCal" title="Add to your calendar">${esc(whenLabel(m.when_text, m.end_text))}</button>` : ''}${whereHtml(m) ? ' · ' + whereHtml(m) : ''}</div>
        </div>
        ${m.role === 'host' && m.status === 'accepted' ? `<button class="btn small" id="happened">Mark as done</button>
          <button class="btn small" id="cancelPlan">Cancel plan</button>` : ''}
        ${m.role === 'attendee' && m.status === 'accepted' && !m.reconfirm ? `<button class="btn small" id="leave">Can't make it</button>` : ''}
      </div>
      ${isBlocked({ guid: m.other }) ? `<div class="notice">You blocked ${esc(name)}, so their messages are hidden.
        <button type="button" class="btn small" id="unblockChat">Unblock</button></div>`
      : canConnect ? `<div class="notice connect-note">You're not connected.
        <button type="button" class="link" id="connectChat">Invite them to connect</button></div>` : ''}
      <div class="msgs" id="msgs"></div>
      ${m.status === 'accepted' && m.reconfirm && m.role === 'attendee' ? `
        <div class="reconfirm">
          <div><b>${esc(name)} changed this post.</b> Can you still make it?</div>
          <div class="btns">
            <button class="btn small" id="stillIn">I'm still in</button>
            <button class="btn small" id="cantGo">Can't make it</button>
          </div>
        </div>` : ''}
      ${m.status === 'accepted' ? `
        <form class="composer" id="composer">
          <label class="sr-only" for="chatBody">Message</label>
          <input id="chatBody" name="body" placeholder="Say hi, sort out the details…" autocomplete="off" maxlength="2000" required>
          <button class="btn">Send</button>
        </form>` : ''}
    </div>`;
  // Back to the list: the browser's Back when the list is the entry before this one, so both buttons agree.
  v.querySelector('.back').onclick = () => {
    if (history.state?.fromList) return history.back();
    state.chat = null; replaceScreen = true; render();
  };
  v.querySelector('#connectChat')?.addEventListener('click', () => inviteToConnect({
    reply: { chat: theirHello.chat, inbox: theirHello.inbox }, to: m.other, icon: m.other, about: `The person you matched with on <b>${esc(m.title)}</b>`,
  }));
  v.querySelector('#unblockChat')?.addEventListener('click', async () => {
    try { await setBlocked({ guid: m.other }, false); toast(`Unblocked ${name}`); render(); } catch (err) { toast(err.message); }
  });
  v.querySelector('#addCal')?.addEventListener('click', () => addToCalendar({ id: m.id, title: m.title, location: m.location, location_name: m.location_name, online: m.online, when_text: m.when_text, end_text: m.end_text }));

  const msgsEl = v.querySelector('#msgs');
  let drawn = '', editing = false;
  // My messages can be edited or deleted (tap one) while we're matched or after it happened.
  const editable = (x) => ['accepted', 'attended'].includes(x.status);
  const edited = (t) => t.edited ? '<span class="msg-edited">edited</span>' : '';
  function drawMsgs(x) {
    if (editing) return; // don't wipe a message being edited; the next poll catches up
    const nm = esc(nameOrSomeone(x.other)), blocked = isBlocked({ guid: x.other });
    const html = `<div class="msg sys">${x.role === 'attendee' ? `You asked to join and ${nm} said yes!` : `${nm} asked to join and you said yes!`}</div>` +
      x.state.timeline.map(t => t.event === 'chat'
        ? t.deleted ? `<div class="msg deleted${t.role === x.role ? ' mine' : ''}">Message deleted</div>`
        : t.role === x.role
          ? editable(x) && t.n ? `<div class="msg mine editable" role="button" tabindex="0" data-n="${t.n}" title="Edit or delete this message">${linkify(t.text)}${edited(t)}</div>`
            : `<div class="msg mine">${linkify(t.text)}${edited(t)}</div>`
          : blocked ? '<div class="msg hidden-msg">Message hidden</div>' : `<div class="msg">${linkify(clean(t.text))}${edited(t)}</div>`
        : mailSystemLine(t, x) ? `<div class="msg sys notice">${esc(mailSystemLine(t, x))}</div>` : '').join('') +
      (x.status === 'attended' ? '<div class="msg sys">Marked as done. Hope it was fun!</div>'
        : x.status === 'accepted' && x.reconfirm && x.role === 'host' ? `<div class="msg sys">Waiting for ${nm} to re-confirm</div>` : '');
    // Open on screen counts as read (and clears the Plans badge, here and on my other devices).
    if (!document.hidden) markChatsRead([x])?.then(shellRefreshBadges);
    if (html === drawn) return;
    drawn = html; msgsEl.innerHTML = html;
    msgsEl.scrollTop = msgsEl.scrollHeight;
    window.scrollTo(0, document.body.scrollHeight);
  }
  drawMsgs(m);
  // Editing one of my messages: it turns into a text box, and saving sends an edit that replaces its text for both of
  // us. Delete, there, deletes it for both of us.
  function startEdit(el) {
    if (editing) return;
    const x = find(), t = x?.state.timeline.find(e => e.event === 'chat' && e.role === x.role && e.n === Number(el.dataset.n));
    if (!t) return;
    editing = true;
    el.classList.add('editing'); el.removeAttribute('role'); el.removeAttribute('tabindex');
    el.innerHTML = `<form class="msg-edit"><label class="sr-only" for="msgEditBox">Edit message</label>
      <textarea id="msgEditBox" maxlength="2000" rows="2" required>${esc(t.text)}</textarea>
      <div class="btns"><button type="button" class="btn small" data-delete-msg>Delete</button><span class="grow"></span>
        <button type="button" class="btn ghost small" data-cancel>Cancel</button><button class="btn small">Save</button></div></form>`;
    const box = el.querySelector('textarea');
    box.focus(); box.setSelectionRange(box.value.length, box.value.length);
    const done = () => { editing = false; drawn = ''; drawMsgs(find()); };
    el.querySelector('[data-cancel]').onclick = done;
    el.querySelector('[data-delete-msg]').onclick = async () => {
      if (!confirm(`Delete this message? It's deleted for ${name} too.`)) return;
      try { await loadMail().catch(() => {}); await sendOn(m.ch, { type: 'delete', of: t.n }); done(); }
      catch (err) { toast(err.message); }
    };
    el.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const text = box.value.trim();
      if (!text || text === t.text) return done();
      try { await loadMail().catch(() => {}); await sendOn(m.ch, { type: 'edit', of: t.n, text }); done(); }
      catch (err) { toast(err.message); }
    };
  }
  msgsEl.addEventListener('click', (e) => { if (e.target.closest('a')) return; const el = e.target.closest('.msg.editable'); if (el && !el.classList.contains('editing')) startEdit(el); });
  msgsEl.addEventListener('keydown', (e) => {
    const el = e.target.closest?.('.msg.editable');
    if (el && e.target === el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); startEdit(el); }
  });
  // Anything that changes the buttons (a re-confirm request, the other side leaving, …) redraws the whole chat.
  const shape = (x) => `${x?.status}|${x?.reconfirm}|${x?.other}`;
  const poll = setInterval(async () => {
    if (state.chat !== id || !document.body.contains(msgsEl)) return clearInterval(poll);
    await loadMail().catch(() => {});
    const x = find();
    if (shape(x) !== shape(m)) { clearInterval(poll); return render(); }
    drawMsgs(x);
  }, 5000);

  const act = async (fields, done) => {
    try { await sendOn(m.ch, fields); if (done) toast(done); shellRefreshBadges(); render(); }
    catch (err) { toast(err.message); }
  };
  v.querySelector('#composer')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = e.target.body;
    // Read first, so this message counts as coming after everything already here.
    try { await loadMail().catch(() => {}); await sendOn(m.ch, { type: 'chat', text: input.value }); input.value = ''; drawMsgs(find()); }
    catch (err) { toast(err.message); }
  });
  v.querySelector('#stillIn')?.addEventListener('click', () => act({ type: 'reconfirm', yes: true }, `Told ${name} you're still in`));
  v.querySelector('#cantGo')?.addEventListener('click', () => {
    if (confirm(`Drop out of “${m.title}”? ${name} will be told you can't make it.`)) act({ type: 'reconfirm', yes: false }, "You've dropped out");
  });
  v.querySelector('#leave')?.addEventListener('click', () => {
    if (confirm(`Drop out of “${m.title}”? ${name} will be told, and your spot goes to the next person on the waitlist.`)) act({ type: 'leave' }, "You've dropped out");
  });
  v.querySelector('#happened')?.addEventListener('click', () => {
    if (confirm(`Mark “${m.title}” as done with ${name}?`)) act({ type: 'happened' }, `Glad it went well! Thanks, ${name}.`);
  });
  // Cancelling the plan cancels the whole post, for everyone in it, not just this chat.
  v.querySelector('#cancelPlan')?.addEventListener('click', async () => {
    const h = mailView()?.hosting.find(x => x.post.pid === m.post.pid);
    const others = (h?.requests || []).filter(r => ['pending', 'waitlisted', 'accepted'].includes(r.status)).length;
    if (!confirm(`Cancel “${m.title}”? ${others > 1 ? `Everyone who asked to join (${others} people) will be told` : `${name} will be told`}, and the post is removed.`)) return;
    try { await cancelPost(m.post.pid); toast('Cancelled. Everyone in it has been told.'); shellRefreshBadges(); render(); }
    catch (err) { toast(err.message); }
  });
}

// Unique ids for <label for=…>, since a post form and an edit sheet can be open at once.
let fieldSeq = 0;
const fieldId = (name) => `f-${name}-${++fieldSeq}`;

function eventFormFields(t = {}) {
  const val = (k) => esc(t[k] ?? '');
  const tagsId = fieldId('tags'), locId = fieldId('location');
  return `
      <label>Title
        <input name="title" placeholder="e.g. Pick up compost & spread it on my garden" required maxlength="100" value="${val('title')}"></label>
      <label>Details
        <textarea name="details" class="details-input" placeholder="e.g. Bring gloves if you have them. I'll provide tools, snacks, and beer." maxlength="1000">${val('details')}</textarea></label>
      <div class="tag-editor" data-tags="${esc(JSON.stringify(t.tags || []))}">
        <label for="${tagsId}">Tags</label>
        <input type="hidden" name="tags">
        <div class="tag-box"><input id="${tagsId}" class="tag-input" placeholder="e.g. gardening, hauling" maxlength="30" enterkeyhint="done"></div>
        <div class="tag-suggest"></div>
      </div>
      <fieldset class="seg-pick"><legend>Where</legend><div class="seg">
        <label><input type="radio" name="online" value="0" ${t.online ? '' : 'checked'}><span>In person</span></label>
        <label><input type="radio" name="online" value="1" ${t.online === 1 ? 'checked' : ''}><span>Online</span></label>
        <label><input type="radio" name="online" value="2" ${t.online === 2 ? 'checked' : ''}><span>Both</span></label>
      </div></fieldset>
      <div class="field loc-place" ${t.online === 1 ? 'hidden' : ''}>
        <label for="${locId}">Place</label>
        <div class="loc-field">
          <input id="${locId}" name="location_name" maxlength="100" value="${val('location_name')}" autocomplete="off"
            placeholder="${t.location && !t.location_name ? 'Spot picked on the map (no name yet)' : 'Type a place and press Enter to search'}" enterkeyhint="search">
          <input type="hidden" name="location" value="${val('location')}">
          <button type="button" class="loc-pick" aria-label="Pick on a map" title="Pick on a map">${PIN_SVG}</button>
        </div>
      </div>
      ${whenInputs(t.when_text, t.end_text)}
      ${costInputs(t)}
      ${audienceInputs(t)}
      <label>Max attendees
        <input name="max_attendees" type="number" inputmode="numeric" step="1" min="${Math.max(1, t.matched || 0)}" max="${MAX_ATTENDEES_LIMIT}"
          placeholder="e.g. 4, or blank for no limit" value="${t.max_attendees ?? ''}"></label>`;
}

// "When": the browser's date and time picker for the first (or only) time, an optional end, and a Repeats menu whose
// choices follow the date picked (see public/when.js).
const repeatOptionsHtml = (start, selected) => repeatOptions(start)
  .map(o => `<option value="${o.rule}" data-kind="${o.kind}" ${o.kind === selected ? 'selected' : ''}>${esc(o.label)}</option>`).join('');
// Quick picks above the start and end times, like filters: each fills in its field (see mountWhenFields). Starts
// are from now; ends are from the start, so they need one first.
const START_PICKS = [['now', 'Now'], ['30m', 'In 30 min'], ['1h', 'In an hour'], ['afternoon', 'This afternoon'], ['evening', 'This evening']];
const END_PICKS = [['30m', '30 minutes'], ['1h', '1 hour'], ['2h', '2 hours'], ['4h', '4 hours'], ['sunset', 'Sunset'], ['midnight', 'Midnight']];
const quickPicks = (which, picks) => `<div class="quick-picks" role="group" aria-label="Quick picks">${picks.map(([k, label]) =>
  `<button type="button" class="chip filter" data-pick-${which}="${k}">${label}</button>`).join('')}</div>`;
function whenInputs(v = '', end = '') {
  const w = parseWhen(v), e = parseEnd(v, end), startId = fieldId('start'), endId = fieldId('end');
  return `
      <div class="time-field"><label for="${startId}">Starts</label>
        ${quickPicks('start', START_PICKS)}
        <input id="${startId}" name="when_text" type="datetime-local" value="${esc(w?.start ?? '')}"></div>
      <div class="time-field"><label for="${endId}">Ends</label>
        ${quickPicks('end', END_PICKS)}
        <input id="${endId}" name="end_text" type="datetime-local" value="${esc(e?.end ?? '')}" min="${esc(w?.start ?? '')}"></div>
      <label>Repeats
        <select name="when_repeat" ${w ? '' : 'disabled'}>${repeatOptionsHtml(w?.start, w?.repeat.kind)}</select></label>`;
}
// New date → new repeat choices, keeping the same kind of repeat where it still exists. "The Nth weekday" and
// "the last weekday" stand in for each other, since a date near the end of a month may offer only one of them.
// Moving the start moves the end with it, so the length stays the same.
function mountWhenFields(form) {
  const input = form.querySelector('input[name=when_text]'), sel = form.querySelector('select[name=when_repeat]');
  const endIn = form.querySelector('input[name=end_text]');
  if (!input || !sel) return;
  let before = input.value;
  input.addEventListener('input', () => {
    if (endIn) {
      if (endIn.value) endIn.value = shiftEnd(before, input.value, endIn.value);
      endIn.min = input.value;
    }
    before = input.value;
    const kind = sel.selectedOptions[0]?.dataset.kind || 'once', kinds = repeatOptions(input.value).map(o => o.kind);
    const keep = kinds.includes(kind) ? kind
      : ['nthday', 'lastday'].includes(kind) ? kinds.find(k => k === 'nthday' || k === 'lastday') : 'once';
    sel.innerHTML = repeatOptionsHtml(input.value, keep);
    sel.disabled = !input.value;
  });
  mountTimePicks(form, input, endIn);
}

// A Date as a datetime-local value ("YYYY-MM-DDTHH:MM", this device's wall clock), and back.
const toWall = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const fromWall = (s) => (s ? new Date(s) : null); // datetime-local values are read as local time
// Up to the next 5 minutes, so "in 30 min" reads as 7:35, not 7:33.
const roundUp5 = (d) => { const r = new Date(d); r.setSeconds(0, 0); r.setMinutes(Math.ceil(r.getMinutes() / 5) * 5); return r; };
const atToday = (h) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d; };
// What a quick pick means right now: a Date, or a reason it can't be used ({ off: 'why' }).
function startPick(k, now = new Date()) {
  if (k === 'now') { const d = new Date(now); d.setSeconds(0, 0); return d; }
  if (k === '30m') return roundUp5(new Date(+now + 30 * 60e3));
  if (k === '1h') return roundUp5(new Date(+now + 60 * 60e3));
  const d = atToday(k === 'afternoon' ? 14 : 18);
  return d > now ? d : { off: `${k === 'afternoon' ? '2' : '6'}:00 PM has already passed today` };
}
function endPick(k, start, loc) {
  if (!start) return { off: 'Pick a start time first' };
  const mins = { '30m': 30, '1h': 60, '2h': 120, '4h': 240 }[k];
  if (mins) return new Date(+start + mins * 60e3);
  if (k === 'midnight') { const d = new Date(start); d.setHours(24, 0, 0, 0); return d; }
  // Sunset where the post is, on the day it starts.
  const ll = parseLatLon(loc);
  if (!ll) return { off: 'Pick a place first, so sunset can be worked out' };
  const at = sunsetAt(toWall(start).slice(0, 10), ...ll);
  if (at == null) return { off: "The sun doesn't set there that day" };
  return at > +start ? new Date(at) : { off: 'Sunset is before it starts' };
}
// The quick picks: a pick fills in its field and is shown as picked until the field changes some other way. Picks
// that can't be used right now (a start time that's passed, an end before there's a start) are disabled, with why.
function mountTimePicks(form, startIn, endIn) {
  const startBtns = [...form.querySelectorAll('[data-pick-start]')], endBtns = [...form.querySelectorAll('[data-pick-end]')];
  const locIn = form.querySelector('input[name=location]');
  const set = (input, value, btns, b) => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true })); // the start's listener moves the end and the repeats
    btns.forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
    refresh();
  };
  function refresh() {
    for (const b of startBtns) { const r = startPick(b.dataset.pickStart); b.disabled = Boolean(r.off); b.title = r.off || toWall(r).replace('T', ' '); }
    for (const b of endBtns) { const r = endPick(b.dataset.pickEnd, fromWall(startIn.value), locIn?.value); b.disabled = Boolean(r.off); b.title = r.off || ''; }
  }
  startBtns.forEach(b => b.onclick = () => { const r = startPick(b.dataset.pickStart); if (!r.off) set(startIn, toWall(r), startBtns, b); });
  endBtns.forEach(b => b.onclick = () => { const r = endPick(b.dataset.pickEnd, fromWall(startIn.value), locIn?.value); if (!r.off) set(endIn, toWall(r), endBtns, b); });
  // Typing a time yourself unpicks; the end picks also depend on the start and the place.
  startIn.addEventListener('change', () => { startBtns.forEach(x => { x.classList.remove('on'); x.removeAttribute('aria-pressed'); }); refresh(); });
  endIn?.addEventListener('change', () => endBtns.forEach(x => { x.classList.remove('on'); x.removeAttribute('aria-pressed'); }));
  startIn.addEventListener('input', refresh);
  // "Now" moves on, and the place may have been picked meanwhile: check again whenever the time fields are used.
  form.querySelectorAll('.time-field').forEach(f => f.addEventListener('focusin', refresh));
  refresh();
}

// While you type a title or details, say if they look like they have contact info or ID numbers (which the server
// refuses, so the form won't submit) or a street address (just a warning). The checker, public/pii.js with its phone
// number data, loads the first time it's needed. If it can't load, the server still checks.
let piiModule;
function mountPiiCheck(form) {
  for (const [name, field] of [['title', 'Title'], ['details', 'Details']]) {
    const input = form.querySelector(`[name=${name}]`);
    if (!input) continue;
    const msg = document.createElement('p');
    msg.className = 'notice warn pii-notice'; msg.hidden = true; msg.setAttribute('aria-live', 'polite');
    input.closest('label').after(msg);
    const check = async () => {
      piiModule ||= import('./pii.js');
      const { error, warning } = (await piiModule).piiProblems(field, input.value, { instagramPosts: name === 'details' });
      input.setCustomValidity(error || '');
      msg.textContent = error || warning || '';
      msg.hidden = !msg.textContent;
    };
    let timer;
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => check().catch(() => {}), 300); });
    if (input.value) check().catch(() => {}); // editing a post written before the check existed
  }
}

// Cost: an amount (blank or 0 = free) and a currency, which defaults to the last one picked.
function costInputs(t = {}) {
  const cur = t.cost_currency || lastCurrency(), costId = fieldId('cost');
  return `
      <div class="cost-field">
        <label for="${costId}">Cost
          <input id="${costId}" name="cost_amount" type="number" inputmode="decimal" min="0" step="any" placeholder="e.g. 10, or blank for free"
            value="${t.cost_amount ? esc(t.cost_amount) : ''}"></label>
        <label>Currency
          <select name="cost_currency" title="${esc(currencyName(cur))}">
            ${CURRENCIES.map(c => `<option value="${c}" ${c === cur ? 'selected' : ''}>${c} · ${esc(currencyName(c))}</option>`).join('')}
          </select></label>
      </div>`;
}
function mountCostFields(form) {
  const sel = form.querySelector('select[name=cost_currency]');
  sel?.addEventListener('change', () => {
    sel.title = currencyName(sel.value);
    try { localStorage.setItem('currency', sel.value); } catch {}
  });
}

// Chip-style tag input inside eventFormFields. Keeps the hidden "tags" input in sync (comma-separated).
// Enter or comma adds a tag, Backspace on an empty box removes the last, suggestions add with one tap.
// ---------- who can see a post ----------
// Public posts show in everyone's Discover, even guests'. Private ones only for the contacts and groups (contact
// tags) the host picks. Contacts live only in the encrypted vault, so the browser expands the pick into GUIDs and
// shares the post with each of them (public/mail.js), and keeps the pick with the post in the vault (posts[pid]) to
// share it again when group membership changes (syncAudiences).
const emptyAudience = () => ({ groups: [], contacts: [] });
function audienceGuids({ groups = [], contacts = [] }) {
  const all = vault.data.contacts;
  return [...new Set([...contacts.filter(g => all[g]), ...Object.keys(all).filter(g => (all[g].tags || []).some(t => groups.includes(t)))])]
    .filter(g => !isBlocked({ guid: g })); // blocked contacts stop getting my private posts
}
const contactGroups = () => {
  const counts = {};
  for (const c of Object.values(vault.data.contacts)) for (const t of c.tags || []) counts[t] = (counts[t] || 0) + 1;
  return Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
};

// Private posts are shared with contacts, so without any, new posts are public. A posted post (t.id) keeps its kind:
// a private post was only ever sent to its audience, and a public one may already be on anyone's device.
function audienceInputs(t = {}) {
  const noContacts = !Object.keys(vault.data.contacts).length, posted = Boolean(t.id);
  const vis = t.visibility || (noContacts ? 'public' : 'private');
  const lockPrivate = (noContacts && vis !== 'private') || (posted && vis === 'public');
  const lockPublic = posted && vis === 'private';
  return `
      <fieldset class="seg-pick"><legend>Who can see it?</legend><div class="seg">
        <label><input type="radio" name="visibility" value="private" ${vis === 'private' ? 'checked' : ''} ${lockPrivate ? 'disabled' : ''}><span>Private</span></label>
        <label><input type="radio" name="visibility" value="public" ${vis === 'public' ? 'checked' : ''} ${lockPublic ? 'disabled' : ''}><span>Public</span></label>
      </div></fieldset>
      ${posted ? `<p class="note">A post stays ${vis} once it's posted. To change who can see it, remove it and post it again.</p>`
      : lockPrivate ? `<p class="note">To create a Private post, you need to have some contacts. Create an invitation and send
        it to your friends to connect with them!</p>` : ''}
      <div class="audience" ${vis === 'public' ? 'hidden' : ''} data-audience="${esc(JSON.stringify(t.audience || emptyAudience()))}"></div>`;
}

// Draws the group and contact chips; form.audience() returns the current pick.
function mountAudience(form) {
  const box = form.querySelector('.audience');
  if (!box) return;
  const pick = JSON.parse(box.dataset.audience);
  const radios = form.querySelectorAll('input[name=visibility]');
  // A new post's button says who'll see it: "Post it publicly", or "Post it to 3 people" (disabled until someone's
  // picked, since a private post has to go to someone).
  const postBtn = form.querySelector('[data-post-button]');
  const label = () => {
    if (!postBtn) return;
    const n = audienceGuids(pick).length, isPublic = form.querySelector('input[name=visibility]:checked')?.value === 'public';
    postBtn.textContent = isPublic ? 'Post it publicly' : n ? `Post it to ${n === 1 ? '1 person' : `${n} people`}` : 'Pick who can see it';
    postBtn.disabled = !isPublic && !n;
  };
  const draw = () => {
    const groups = contactGroups();
    const contacts = Object.keys(vault.data.contacts).sort((a, b) => displayName(a).localeCompare(displayName(b)));
    const n = audienceGuids(pick).length;
    const chip = (kind, value, label, on) =>
      `<button type="button" class="chip filter ${on ? 'on' : ''}" data-${kind}="${esc(value)}" aria-pressed="${on}">${label}</button>`;
    box.innerHTML = !contacts.length
      ? `<p class="note">You don't have any contacts yet: people become contacts when you both say yes to an invitation
          to connect. Until then, make it public to find people.</p>`
      : `${groups.length ? `<div class="filter-row stacked" role="group" aria-label="Groups"><span class="label">Groups</span>
          ${groups.map(([g, count]) => chip('group', g, `#${esc(g)} <span class="n">${count}</span>`, pick.groups.includes(g))).join('')}</div>` : ''}
        <div class="filter-row stacked" role="group" aria-label="Contacts"><span class="label">People</span>
          ${contacts.map(g => chip('contact', g, esc(displayName(g)), pick.contacts.includes(g))).join('')}</div>
        <p class="note">${n ? `Only you and ${n === 1 ? '1 person' : `${n} people`} can see this.` : 'Pick at least one person or group to post it.'}
          ${pick.groups.length ? 'People you add to these groups later will see it too.' : ''}</p>`;
    label();
  };
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const [list, v] = b.dataset.group ? [pick.groups, b.dataset.group] : [pick.contacts, b.dataset.contact];
    const i = list.indexOf(v);
    if (i >= 0) list.splice(i, 1); else list.push(v);
    draw();
  });
  radios.forEach(r => r.addEventListener('change', () => { box.hidden = form.querySelector('input[name=visibility]:checked').value === 'public'; label(); }));
  form.audience = () => (form.querySelector('input[name=visibility]:checked')?.value === 'public' ? null : pick);
  draw();
}

// Create or update a post from its form, including who can see it (public/mail.js): private posts encrypted for
// their audience, public ones signed. id is "m:<pid>" when editing.
async function saveEvent(form, id) {
  const pick = form.audience?.() ?? null;
  // A private post has to go to someone: nobody picked (or only blocked people) can't be posted.
  if (pick && !audienceGuids(pick).length) throw new Error('Pick at least one person or group to share this private post with.');
  // A new public post asks first: anyone can see it, and it can't be made private later.
  if (!pick && !id && !confirm("Post this publicly? Anyone can see it, including people who aren't signed in, and it stays public.")) throw new Error('Not posted.');
  const pid = id ? String(id).replace(/^m:/, '') : null;
  const h = pid && mailView()?.hosting.find(x => x.post.pid === pid);
  const fields = await postFields(formData(form), { matched: h ? h.counts.accepted + h.counts.attended : 0 });
  return savePost({
    pid, kind: pick ? 'private' : 'public', fields,
    audience: pick ? { groups: [...pick.groups], contacts: [...pick.contacts] } : null, guids: pick ? audienceGuids(pick) : [],
  });
}

// What a new post's audience is, for the toast after posting. r is what saveEvent returned.
function postedMessage(form, r = {}) {
  const pick = form.audience?.();
  if (!pick) return 'Posted! Anyone can now swipe on it.';
  const n = r.shared ?? audienceGuids(pick).length;
  const later = r.missing ? ` ${r.missing === 1 ? '1 person gets' : `${r.missing} people get`} it once they open Bored again.` : '';
  return (n ? `Posted! ${n === 1 ? '1 person' : `${n} people`} can now swipe on it.` : 'Posted. Only you can see it until you share it with someone.') + later;
}

// After contacts' groups change, share each private post again with whoever's new in its audience, including
// contacts who couldn't be reached before.
async function syncAudiences() {
  for (const [pid, p] of Object.entries(vault.data.posts || {})) {
    await reshare(pid, audienceGuids(p.audience || emptyAudience())).catch(err => console.warn(err));
  }
}

// suggestions: tags offered as one-tap chips (post tags by default; contacts use CONTACT_TAGS).
function mountTagEditor(root, suggestions = TAGS) {
  const hidden = root.querySelector('input[name=tags]'), box = root.querySelector('.tag-box');
  const input = root.querySelector('.tag-input'), suggest = root.querySelector('.tag-suggest');
  let tags = JSON.parse(root.dataset.tags || '[]');

  function draw() {
    hidden.value = tags.join(',');
    box.querySelectorAll('.chip').forEach(c => c.remove());
    input.insertAdjacentHTML('beforebegin', tags.map((t, i) =>
      `<span class="chip tag">#${esc(t)}<button type="button" data-rm="${i}" aria-label="Remove ${esc(t)}">✕</button></span>`).join(''));
    const full = tags.length >= MAX_TAGS;
    input.hidden = full;
    suggest.innerHTML = full ? `<small>That's the max of ${MAX_TAGS} tags.</small>`
      : suggestions.filter(t => !tags.includes(t))
        .map(t => `<button type="button" class="chip suggest" data-add="${t}">#${t}</button>`).join('');
  }
  function add(raw) {
    const t = normalizeTag(raw);
    if (t && !tags.includes(t) && tags.length < MAX_TAGS) tags.push(t);
    input.value = '';
    draw();
  }
  input.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ',') && input.value.trim()) { e.preventDefault(); add(input.value); }
    else if (e.key === ',') e.preventDefault();
    else if (e.key === 'Backspace' && !input.value && tags.length) { tags.pop(); draw(); }
  });
  input.addEventListener('input', () => { if (input.value.includes(',')) input.value.split(',').forEach(add); });
  input.addEventListener('blur', () => { if (input.value.trim()) add(input.value); });
  root.addEventListener('tag:add', (e) => add(e.detail)); // lets other form controls add a tag
  box.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { tags.splice(Number(rm.dataset.rm), 1); draw(); } else input.focus();
  });
  suggest.addEventListener('click', (e) => { const b = e.target.closest('[data-add]'); if (b) add(b.dataset.add); });
  draw();
}

// Bottom sheet with the post form. With t.id it edits that post; without, it creates a new one pre-filled from t.
function openPostSheet(t = {}) {
  const editing = Boolean(t.id);
  const { sheet, close } = openSheet(`
    <form class="stack panel post-form" id="sheetForm">
      <h2>${editing ? 'Edit post' : 'New post'}</h2>
      ${eventFormFields(t)}
      ${editing && t.matched ? `<p class="note">Anyone you've matched with will get a message about what changed and be asked to re-confirm.</p>` : ''}
      ${editing ? '' : `<p class="note">Tweak anything you like, then post it.</p>`}
      <div class="two">
        <button type="button" class="btn ghost" id="cancelSheet">Cancel</button>
        <button class="btn" ${editing ? '' : 'data-post-button'}>${editing ? 'Save changes' : 'Post it'}</button>
      </div>
    </form>`);
  sheet.querySelectorAll('.tag-editor').forEach(el => mountTagEditor(el));
  mountAudience(sheet.querySelector('form'));
  mountLocationField(sheet.querySelector('form'));
  mountWhenFields(sheet.querySelector('form'));
  mountPiiCheck(sheet.querySelector('form'));
  mountCostFields(sheet.querySelector('form'));
  sheet.querySelector('#cancelSheet').onclick = close;
  sheet.querySelector('#sheetForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      if (editing) {
        const r = await saveEvent(e.target, t.id);
        toast(r.notified ? `Saved. Asked ${r.notified} attendee${r.notified > 1 ? 's' : ''} to re-confirm.` : 'Saved');
      } else {
        const r = await saveEvent(e.target);
        toast(postedMessage(e.target, r));
      }
      close();
      render();
    } catch (err) { toast(err.message); }
  };
  sheet.querySelector('input[name=title]').focus();
}

// Cycle through POST_IDEAS; pauses while hovered, while the form has focus, or while a sheet is open.
// Tap the idea to open its template; tap ‹ or › to step back or ahead.
function rotatePostIdeas(el) {
  const text = el.querySelector('.text');
  let i = Math.floor(Math.random() * POST_IDEAS.length);
  const show = () => {
    text.classList.remove('in'); text.offsetWidth; // restart the fade-in
    text.textContent = POST_IDEAS[i].prompt; text.classList.add('in');
  };
  const next = () => { i = (i + 1) % POST_IDEAS.length; show(); };
  const prev = () => { i = (i - 1 + POST_IDEAS.length) % POST_IDEAS.length; show(); };
  show();
  // An idea fills in the Post form under it (asking first if you've already started one).
  el.querySelector('.idea-open').onclick = () => {
    const form = document.getElementById('newEvent');
    if (!form) return;
    const started = ['title', 'details'].some(n => form.elements[n]?.value.trim());
    if (started && !confirm('Replace what you\'ve written with this idea?')) return;
    const { when, ...t } = POST_IDEAS[i].template;
    fillPostForm(form, { ...t, when_text: when ? nextAt(...when) : '' });
    form.elements.title?.focus();
    toast('Tweak anything you like, then post it.');
  };
  el.querySelector('.idea-next').onclick = next;
  el.querySelector('.idea-prev').onclick = prev;
  const timer = setInterval(() => {
    if (!document.body.contains(el)) return clearInterval(timer);
    if (el.matches(':hover') || document.activeElement?.closest('#newEvent') || document.querySelector('.sheet')) return;
    next();
  }, POST_IDEA_MS);
}

// The Post tab's form, drawn (again) with a post's fields filled in: empty, or from a post idea.
function fillPostForm(form, t = {}) {
  form.innerHTML = `${eventFormFields(t)}<button class="btn" data-post-button>Post it</button>`;
  form.querySelectorAll('.tag-editor').forEach(el => mountTagEditor(el));
  mountAudience(form);
  mountLocationField(form);
  mountWhenFields(form);
  mountPiiCheck(form);
  mountCostFields(form);
}

// One of my posts (an entry of the mail view's hosting), as Your posts shows it and openPostSheet edits it.
const hostedPost = (h) => ({
  ...h.post, id: `m:${h.post.pid}`, visibility: h.post.kind, tags: h.post.tags || [], status: h.status,
  pending: h.counts.pending, matched: h.counts.accepted + h.counts.attended, waitlisted: h.counts.waitlisted, awaiting: h.counts.reconfirm,
  viewers: vault.data.posts?.[h.post.pid]?.sharedWith.length || 0, audience: vault.data.posts?.[h.post.pid]?.audience,
});

async function viewPost(v) {
  const mail = await loadMail().catch(() => mailView());
  // Removed posts are cancelled (everyone's told); past ones I deleted are just hidden from me (deletedPosts).
  const deletedPosts = new Set(vault.data.deletedPosts || []);
  const mine = (mail?.hosting || []).filter(h => h.post.status !== 'cancelled' && !deletedPosts.has(h.post.pid)).map(hostedPost);
  // Sorted by state.postSort. Posts made before they recorded `created` count as older than any that did, in the
  // order they were saved (the vault keeps them in that order). "Soonest" goes by start time, with undated posts last.
  const saved = Object.keys(vault.data.posts || {});
  const age = (t) => [t.created || 0, saved.indexOf(t.pid)];
  const newer = (a, b) => { const [x, y] = [age(a), age(b)]; return y[0] - x[0] || y[1] - x[1]; };
  const startOf = (t) => parseWhen(t.when_text)?.date.getTime() ?? Infinity;
  const SORTS = {
    newest: newer,
    oldest: (a, b) => newer(b, a),
    soonest: (a, b) => (startOf(a) - startOf(b)) || newer(a, b),
    interested: (a, b) => (b.pending - a.pending) || (b.matched - a.matched) || newer(a, b),
    title: (a, b) => String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base' }) || newer(a, b),
  };
  const events = mine.sort(SORTS[state.postSort] || newer);
  // Full cards, like Discover's: labelled with where the post stands, and who can see it and who's in at the bottom.
  const label = (t) => ({
    open: t.pending ? ['warn', `${t.pending} interested`] : ['done', 'Looking'],
    full: ['in', "It's on"],
    past: ['done', 'Done'],
  }[t.status] || ['done', t.status]);
  const who = (t) => `${avatar(state.me.guid)}
    <div><b>${t.visibility === 'public' ? 'Public' : t.viewers ? `${t.viewers} can see` : 'Only you'} · ${t.max_attendees == null ? `${t.matched} matched · no limit` : `${t.matched}/${t.max_attendees} matched`}</b>
      ${t.waitlisted || t.awaiting ? `<small>${[t.waitlisted && `${t.waitlisted} waitlisted`, t.awaiting && `${t.awaiting} to re-confirm`].filter(Boolean).join(' · ')}</small>` : ''}</div>`;
  const card = (t) => {
    const [cls, text] = label(t);
    return `
        <div class="card flat post-card" data-search-item data-id="${t.id}">
          <span class="label ${cls}">${esc(text)}</span>
          ${eventCard(mailCard(t), { who: who(t), mine: true })}
          <div class="card-actions">${t.status !== 'past' ? `
            <button class="btn ghost small" data-edit="${t.id}">Edit</button>
            <button class="btn small" data-del="${t.id}">Remove</button>`
            : `<button class="btn small" data-delete-post="${esc(t.pid)}">Delete</button>`}
          </div>
        </div>`;
  };
  v.innerHTML = `
    <div class="section-title">Post something</div>
    <div class="idea" id="postIdea">
      <button type="button" class="idea-prev" aria-label="Previous idea" title="Previous idea">‹</button>
      <button type="button" class="idea-open" title="Fill in the form with this idea">
        <span class="text" aria-live="polite"></span>
      </button>
      <button type="button" class="idea-next" aria-label="Next idea" title="Next idea">›</button>
    </div>
    <form class="stack post-form" id="newEvent"></form>
    <div class="section-title">Your posts</div>
    ${events.length > 1 ? searchBoxHtml('Search your posts') : ''}
    ${events.length > 1 ? `<label class="post-sort">Sort by
      <select id="postSort">${Object.entries(POST_SORTS).map(([k, label]) =>
        `<option value="${k}"${k === state.postSort ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></label>` : ''}
    <p class="note" data-search-none hidden></p>
    <div class="list" id="yourPosts">
      ${events.length ? events.map(card).join('') : `<p style="color:var(--muted)">Nothing yet. What would you like to host?</p>`}
    </div>`;
  // The search looks through Your posts, not the form above them.
  mountSearch(v, (words) => filterShown(v, words));
  filterShown(v, searchWords(searchQuery()));
  fillPostForm(v.querySelector('#newEvent'));
  rotatePostIdeas(v.querySelector('#postIdea'));
  v.querySelector('#postSort')?.addEventListener('change', (e) => {
    state.postSort = e.target.value;
    try { localStorage.setItem('postSort', JSON.stringify(state.postSort)); } catch {}
    // Just reorder the cards, so a post half-written in the form above stays as it is.
    const list = v.querySelector('#yourPosts');
    events.sort(SORTS[state.postSort]).forEach(t => list.append(list.querySelector(`.post-card[data-id="${CSS.escape(t.id)}"]`)));
  });
  v.querySelector('#newEvent').onsubmit = async (e) => {
    e.preventDefault();
    try { const r = await saveEvent(e.target); toast(postedMessage(e.target, r)); render(); }
    catch (err) { toast(err.message); }
  };
  v.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openPostSheet(events.find(t => String(t.id) === b.dataset.edit)));
  v.querySelectorAll('.post-card [data-ics]').forEach(b => b.onclick = () => addToCalendar(events.find(t => String(t.id) === b.dataset.ics)));
  v.querySelectorAll('[data-delete-post]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this past post from Posts? Only you stop seeing it.')) return;
    const pid = b.dataset.deletePost;
    try { await vault.update(api, (d) => { d.deletedPosts = [...new Set([...(d.deletedPosts || []), pid])]; }); toast('Deleted'); render(); }
    catch (err) { toast(err.message); }
  });
  v.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Remove this post? Anyone who asked to join or is in will be told it\'s cancelled.')) return;
    try { await cancelPost(b.dataset.del.slice(2)); } catch (err) { return toast(err.message); }
    render();
  });
}

// ---------- moderation ----------
// Everything here is the person's own choice, kept in their encrypted vault (moderation in public/moderation.js), and
// only changes what they see. Guests get the defaults: the built-in word list and every report reason, on.
const mod = () => moderationSettings(hasKeys() ? vault.data.moderation : null);
const saveMod = (fn) => vault.update(api, (d) => { d.moderation = moderationSettings(d.moderation); fn(d.moderation); });
// The built-in word list (profanity-list, served from node_modules), loaded once at startup (loadBuiltinWords).
// Until it's loaded, or if it can't be, only the person's own lists apply.
let builtinWords = builtinTerms([]);
async function loadBuiltinWords() {
  try { builtinWords = builtinTerms(await (await fetch('/vendor/profanity-en.json')).json()); wordCache = { key: null }; }
  catch (err) { console.warn("Couldn't load the built-in word list", err); }
}
const MAX_REPORTED = 1000; // posts whose reports the vault remembers, for the report sheet

// The word lists that are on, as term sets: all of them (to star words out) and the ones that hide whole posts.
// Built again only when the lists change.
let wordCache = { key: null };
function wordFilters() {
  const m = mod(), key = JSON.stringify([m.builtin, m.lists]);
  if (wordCache.key !== key) {
    const on = [...(m.builtin.on ? [{ set: builtinWords.set, hide: m.builtin.hide }] : []),
      ...m.lists.filter(l => l.on).map(l => ({ set: ownTerms(l.words), hide: l.hide }))];
    wordCache = { key, all: on.map(x => x.set), hide: on.filter(x => x.hide).map(x => x.set) };
  }
  return wordCache;
}
// On my own post: which of its words the built-in word list stars out for everyone else. The list is on unless they
// turn it off (and some set it to hide such posts), so it's how most people see the post; their own word lists
// aren't known. '' when it has none.
const andList = (items) => items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
function starredNote(t) {
  const found = new Set();
  for (const text of [t.title, t.details, t.location_name, ...(t.tags || [])]) {
    for (const { start, end } of findTerms(String(text ?? ''), [builtinWords.set])) found.add(text.slice(start, end).toLowerCase());
  }
  if (!found.size) return '';
  const words = [...found].map(w => `“${esc(w)}”`);
  return `<p class="note starred-note">People using the built-in word list see ${andList(words)} starred out, and anyone
    who hides posts with ${found.size === 1 ? 'that word' : 'those words'} won't see this post.</p>`;
}
// Someone else's text with the filtered words starred out.
const clean = (text) => censor(String(text ?? ''), wordFilters().all);
const postText = (p) => [p.title, p.details, p.location_name, ...(p.tags || [])].join('\n');

// Blocking: people are blocked by GUID (contacts) or signing key (the host of a public post I don't know), and a
// contact is also blocked by any key saved for them, so their public posts are caught too.
const sameKey = (a, b) => Boolean(a && b && a.x === b.x && a.y === b.y);
function isBlocked({ guid = null, sign = null } = {}) {
  const b = Object.values(mod().blocked);
  if (!b.length) return false;
  const key = sign || (guid && vault.data.contacts[guid]?.keys?.sign);
  return b.some(x => (guid && x.guid === guid) || (key && sameKey(x.sign, key)));
}
const postBlocked = (p) => isBlocked({ guid: p.host || contactBySign(p.signer) || null, sign: p.signer || null });
// Block or unblock someone: { guid?, sign?, name }. Blocking a contact also stops sharing private posts with them.
async function setBlocked(who, on) {
  const sign = who.sign || (who.guid && vault.data.contacts[who.guid]?.keys?.sign) || null;
  await saveMod((m) => {
    for (const [k, x] of Object.entries(m.blocked)) if ((who.guid && x.guid === who.guid) || (sign && sameKey(x.sign, sign))) delete m.blocked[k];
    if (on) m.blocked[who.guid || `k:${sign.x}.${sign.y}`] = { guid: who.guid || null, sign, name: String(who.name || '').slice(0, 80), at: Date.now() };
  });
  syncAudiences().catch(err => toast(err.message));
}
// After a moderation change: refresh the view on screen without starting a deck over.
function moderationChanged() {
  if (fresh && document.body.contains(fresh.el)) Promise.resolve().then(fresh.refresh).catch(err => console.warn(err));
  else render();
}

// Report counts for public posts (POST /api/public/reports, without cookies), kept for a minute.
const REPORTS_TTL = 60_000;
const reportCache = new Map(); // pid → { at, counts }
async function reportCounts(pids) {
  const now = Date.now(), need = pids.filter(p => !(now - (reportCache.get(p)?.at || 0) < REPORTS_TTL));
  for (let i = 0; i < need.length; i += 500) {
    const part = need.slice(i, i + 500);
    try {
      const res = await fetch('/api/public/reports', { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pids: part }) });
      const { reports = {} } = await res.json();
      for (const p of part) reportCache.set(p, { at: now, counts: reports[p] || null });
    } catch { break; } // try again next time; until then nothing is hidden for its reports
  }
  return Object.fromEntries(pids.map(p => [p, reportCache.get(p)?.counts || null]));
}
// Which posts my settings hide, and why: Map pid → 'blocked' | 'words' | a report reason.
async function moderatePosts(posts) {
  const m = mod(), hide = wordFilters().hide, out = new Map();
  const counts = await reportCounts(posts.filter(p => p.kind === 'public').map(p => p.pid));
  for (const p of posts) {
    const why = postBlocked(p) ? 'blocked' : reportedFor(counts[p.pid], m.reports) || (hide.length && mentions(postText(p), hide) ? 'words' : null);
    if (why) out.set(p.pid, why);
  }
  return out;
}

// Report a post and/or block its host. Only public posts can be reported (the server keeps the counts for them);
// a private post's host is one of my contacts, who I can block.
function openReportSheet(pid) {
  const post = mailView()?.posts.get(pid);
  if (!post) return toast('That post is gone.');
  const m = mod(), mine = m.reported[pid] || [], isPublic = post.kind === 'public';
  const hostGuid = post.host || contactBySign(post.signer) || null;
  const who = { guid: hostGuid, sign: post.signer || null, name: hostGuid ? displayName(hostGuid) : `Host of “${post.title}”` };
  const blocked = isBlocked(who);
  const hostName = hostGuid ? esc(displayName(hostGuid)) : 'this host';
  const { sheet, close } = openSheet(`
    <form class="stack panel" id="reportForm">
      <h2>Report or block</h2>
      ${isPublic ? `<fieldset class="checks"><legend>Report this post for</legend>
        ${Object.entries(REPORT_REASONS).map(([r, label]) => `<label class="check"><input type="checkbox" name="reason" value="${r}" ${mine.includes(r) ? 'checked' : ''}> ${esc(label)}</label>`).join('')}
      </fieldset>
      <p class="note">Nobody else, including the host, learns who reported a post. The server counts reports, and
        each person's own moderation settings decide how many reports it takes to hide a post from them. A post you
        report goes to your discard pile.</p>`
      : `<p class="note">This post was shared with you privately, so it can't be reported. You can block whoever shared it.</p>`}
      <label class="check"><input type="checkbox" name="block" ${blocked ? 'checked' : ''}> Block ${hostName}: hide their posts${hostGuid ? ' and stop sharing your private posts with them' : ''}</label>
      <div class="two">
        <button type="button" class="btn ghost" id="cancelSheet">Cancel</button>
        <button class="btn">Save</button>
      </div>
    </form>`);
  sheet.querySelector('#cancelSheet').onclick = close;
  sheet.querySelector('#reportForm').onsubmit = async (e) => {
    e.preventDefault();
    const reasons = [...e.target.querySelectorAll('input[name=reason]:checked')].map(i => i.value);
    const block = e.target.block.checked, said = [];
    e.target.querySelector('.btn:not(.ghost)').disabled = true;
    try {
      if (isPublic && (reasons.length !== mine.length || reasons.some(r => !mine.includes(r)))) {
        await api('/api/public/report', { method: 'POST', body: { pid, reasons } });
        reportCache.delete(pid); // count my report the next time posts are checked
        await saveMod((x) => {
          delete x.reported[pid];
          if (reasons.length) x.reported[pid] = reasons; // newest last, and only the newest MAX_REPORTED kept
          x.reported = Object.fromEntries(Object.entries(x.reported).slice(-MAX_REPORTED));
        });
        if (reasons.length && mailView()?.deck.some(p => p.pid === pid)) await pass(pid);
        said.push(reasons.length ? 'Reported' : 'Report taken back');
      }
      if (block !== blocked) { await setBlocked(who, block); said.push(block ? 'Blocked' : 'Unblocked'); }
      close();
      if (said.length) { toast(said.join(' and ')); moderationChanged(); }
    } catch (err) { toast(err.message); e.target.querySelector('.btn:not(.ghost)').disabled = false; }
  };
}
document.addEventListener('click', (e) => {
  const r = e.target.closest('[data-report]');
  if (r) openReportSheet(r.dataset.report);
});

// Delete a contact: out of my vault (and any invitation connection on the server), and out of my posts' audiences.
// They aren't told, and keep me as their contact; blocking is what keeps their posts away.
async function deleteContact(guid) {
  await api('/api/connections/remove', { method: 'POST', body: { guid } });
  await vault.update(api, (d) => {
    delete d.contacts[guid];
    for (const p of Object.values(d.posts || {})) if (p.audience?.contacts) p.audience.contacts = p.audience.contacts.filter(g => g !== guid);
  });
  syncAudiences().catch(err => toast(err.message));
}

// Edit the nickname and tags you keep for a contact. Saved only in your encrypted vault.
function openContactSheet(guid, onSaved) {
  const c = vault.data.contacts[guid] || { nickname: '', tags: [] };
  const { sheet, close } = openSheet(`
    <form class="stack panel" id="contactForm">
      <h2>Contact</h2>
      <p class="note">Only you see the nickname and tags you give them. They pick their own name for you.</p>
      <label>Nickname
        <input name="nickname" maxlength="60" placeholder="e.g. Robert from work" value="${esc(c.nickname)}"></label>
      <div class="tag-editor" data-tags="${esc(JSON.stringify(c.tags || []))}">
        <label for="contactTags">Tags</label>
        <input type="hidden" name="tags">
        <div class="tag-box"><input id="contactTags" class="tag-input" placeholder="e.g. family, work" maxlength="30"></div>
        <div class="tag-suggest"></div>
      </div>
      <div class="two">
        <button type="button" class="btn ghost" id="cancelSheet">Cancel</button>
        <button class="btn">Save</button>
      </div>
      ${isContact(guid) ? `<div class="two">
        <button type="button" class="btn small" id="blockContact">${isBlocked({ guid }) ? 'Unblock' : 'Block'}</button>
        <button type="button" class="btn small" id="deleteContact">Delete contact</button>
      </div>
      <p class="note">Blocking hides their posts and messages and stops sharing your private posts with them. Deleting
        takes them out of your contacts. Neither one tells them.</p>` : ''}
    </form>`);
  sheet.querySelectorAll('.tag-editor').forEach(el => mountTagEditor(el, CONTACT_TAGS));
  const label = c.nickname || 'this contact';
  sheet.querySelector('#blockContact')?.addEventListener('click', async () => {
    const on = !isBlocked({ guid });
    if (on && !confirm(`Block ${label}? You won't see their posts or messages, and your private posts won't be shared with them. They aren't told.`)) return;
    try { await setBlocked({ guid, name: c.nickname }, on); close(); toast(on ? `Blocked ${label}` : `Unblocked ${label}`); moderationChanged(); }
    catch (err) { toast(err.message); }
  });
  sheet.querySelector('#deleteContact')?.addEventListener('click', async () => {
    if (!confirm(`Delete ${label} from your contacts? Your nickname and tags for them are deleted, and your private posts stop being shared with them. They aren't told. To stop seeing their posts too, block them instead.`)) return;
    try { await deleteContact(guid); close(); toast(`Deleted ${label}`); onSaved?.(); }
    catch (err) { toast(err.message); }
  });
  sheet.querySelector('#cancelSheet').onclick = close;
  sheet.querySelector('#contactForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    const nickname = String(f.nickname || '').trim().slice(0, 60);
    const tags = String(f.tags || '').split(',').filter(Boolean);
    try {
      await vault.update(api, (d) => {
        d.contacts[guid] = { ...(d.contacts[guid] || { added: new Date().toISOString() }), nickname, tags };
      });
      close(); toast('Saved. Only you can see this.');
      syncAudiences().catch(err => toast(err.message));
      onSaved?.();
    } catch (err) { toast(err.message); }
  };
  sheet.querySelector('input[name=nickname]').focus();
}

async function viewProfile(v) {
  const idMode = state.config.authMode === '6j0';
  await syncConnections();
  const [passkeys, invites] = await Promise.all([idMode || isDemo() ? [] : api('/api/passkeys'), api('/api/invites'), loadMail().catch(() => {}),
    api('/api/me').then(m => { state.me = m; }, () => {})]); // fresh badges
  const me = state.me, st = mailView()?.stats || {};
  // Badges from the server, as cards with the stats: Tester once a developer has marked any of your feedback as done,
  // with how many, and Developer (DEVELOPER_GUIDS in server.js).
  const tested = me.badges?.tester || 0;
  const badges = [
    tested ? `<div class="stat badge-stat" title="${tested === 1 ? '1 piece' : `${tested} pieces`} of your feedback marked done"><b>${tested}</b><span>Tester: feedback done</span></div>` : '',
    me.badges?.developer ? `<div class="stat badge-stat" title="Builds Bored"><b class="word">Developer</b><span>builds Bored</span></div>` : '',
  ].join('');
  // Worked out here from the mail: the server doesn't know who did what with whom.
  const history = Object.fromEntries(Object.entries(mailView()?.together || {}).map(([guid, together]) => [guid, { together }]));
  const contacts = Object.entries(vault.data.contacts).map(([guid, c]) => ({ guid, ...c, ...(history[guid] || {}) }))
    .sort((a, b) => (a.nickname || '~').localeCompare(b.nickname || '~'));
  const allTags = [...new Set(contacts.flatMap(c => c.tags || []))].sort();
  state.contactTags ||= new Set();
  for (const t of state.contactTags) if (!allTags.includes(t)) state.contactTags.delete(t);
  const sel = state.contactTags;
  const shown = sel.size ? contacts.filter(c => (c.tags || []).some(t => sel.has(t))) : contacts;
  const fmt = (iso) => iso ? new Date(iso.replace(' ', 'T') + 'Z').toLocaleDateString() : 'never';

  // The search finds invitations and contacts (by name and tag); while it's on, the rest of Profile is hidden.
  v.innerHTML = `
    ${searchBoxHtml('Search contacts and invitations')}
    <div class="profile-body">
    <p class="note" data-search-none hidden></p>
    <div class="search-hide">
    <div class="me-head">${avatar(me.guid)}
      <div class="grow">
        <label class="sr-only" for="myName">Your name</label>
        <input id="myName" class="name-input" maxlength="60" placeholder="Your name" value="${esc(myName())}" autocomplete="nickname">
        <p class="note">This is the name you'll use to introduce yourself.</p>
      </div>
    </div>
    <div class="stats">
      <div class="stat"><b>${st.hosted ?? 0}</b><span>events hosted</span></div>
      <div class="stat"><b>${st.attended ?? 0}</b><span>events attended</span></div>
      <div class="stat"><b>${st.helped ?? 0}</b><span>${st.helped === 1 ? 'person' : 'people'} helped</span></div>
      ${badges}
    </div>

    <div class="section-title">Notifications</div>
    <div class="stack" id="pushSettings"></div>
    <div class="stack" id="ntfySettings"></div>
    ${state.me?.discoverNews?.perDay ? `<label class="check" style="margin-top: 14px"><input type="checkbox" id="discoverNews" ${state.me.discoverNews.on ? 'checked' : ''}>
      <span>Tell me about new posts in Discover<small>At most ${state.me.discoverNews.perDay === 1 ? 'once' : state.me.discoverNews.perDay === 2 ? 'twice' : `${state.me.discoverNews.perDay} times`} a day, when
        someone has posted something since the last one. It doesn't know your Discover filters, so some may be too
        far away or not your thing.</small></span></label>` : ''}
    </div>

    <section data-search-group>
    <div class="section-title">Invitations</div>
    <p class="note">Send people a link to connect. When someone opens it and asks to connect, they show up in your
      Confirm tab; once you say yes, you're in each other's contacts and can share private posts. Anyone with the link
      can use it until you delete it; deleting it doesn't disconnect anyone.</p>
    ${invites.length ? `<div class="list">${invites.map((inv, i) => `
      <div class="row" data-search-item>
        <div class="grow"><div class="title">${inviteOf(inv.id)?.name ? `${inviteOf(inv.id).direct ? 'Sent to a host as' : 'As'} “${esc(inviteOf(inv.id).name)}”` : `Invitation ${invites.length - i}`}</div>
          <div class="sub">Created ${fmt(inv.created_at)} · ${inv.uses === 1 ? '1 person' : `${inv.uses} people`} connected</div></div>
        <button class="btn ghost small" data-share-invite="${inv.id}">Share</button>
        <button class="btn small" data-del-invite="${inv.id}">Delete</button>
      </div>`).join('')}</div>` : ''}
    <button class="btn" id="newInvite">Create an invitation</button>
    </section>

    <section data-search-group>
    <div class="section-title">Contacts</div>
    <p class="note">People you've connected with: you both said yes to an invitation. Names and tags here are yours alone: they're encrypted with your passkey, and nobody else, including the server, can read them.</p>
    ${allTags.length ? `<div class="filter-row" role="group" aria-label="Filter contacts by tag"><span class="label">Tags</span>
      ${allTags.map(t => `<button type="button" class="chip filter ${sel.has(t) ? 'on' : ''}" data-ctag="${esc(t)}" aria-pressed="${sel.has(t)}">#${esc(t)}</button>`).join('')}
      ${sel.size ? `<button type="button" class="chip filter clear" data-cclear>Clear</button>` : ''}</div>` : ''}
    <div class="list">
      ${shown.length ? shown.map(c => `
        <button class="row" data-search-item data-contact="${esc(c.guid)}">${avatar(c.guid)}
          <div class="grow"><div class="title">${esc(c.nickname || 'Unnamed contact')}</div>
            <div class="sub">${isBlocked({ guid: c.guid }) ? 'Blocked · ' : ''}${(c.tags || []).map(t => '#' + esc(t)).join(' ')}${c.tags?.length ? ' · ' : ''}${c.together || 0} event${c.together === 1 ? '' : 's'} together</div></div>
          </button>`).join('')
        : `<p style="color:var(--muted)">${contacts.length ? 'No contacts with those tags.' : "No contacts yet. Invite someone to connect from a plan's chat, or share an invitation above. Once you both say yes, they'll show up here."}</p>`}
    </div>
    </section>

    <div class="search-hide">
    <div class="section-title">Settings</div>
    <form class="stack" id="prefsForm">
      <label>Distance units
        <select name="distanceUnit">
          <option value="km" ${useMiles() ? '' : 'selected'}>Kilometers</option>
          <option value="mi" ${useMiles() ? 'selected' : ''}>Miles</option>
        </select></label>
      <label class="check"><input type="checkbox" name="tutorial" id="tutorialPref" ${tour || !vault.data.prefs?.tutorialSeen ? 'checked' : ''}>
        <span>Show the tutorial<small>The five steps, from Connect to Plan, in a box above the tabs.</small></span></label>
    </form>

    ${moderationHtml()}

    ${isDemo() ? `<div class="section-title">Demo</div>
    <div class="notice">This is a demo account, made just for this browser. It's deleted after a day, and everything
      resets when the server restarts. Start over to get a fresh account with the demo content back.</div>`
    : idMode ? `<div class="section-title">Sign-in</div>
    <div class="notice">You sign in with your 6j0.org identity. Manage your password at
      <a href="${esc(state.config.idOrigin)}/">${esc(idHost())}</a>. Keep it in a password manager: nobody can reset it.</div>` : `
    <div class="section-title">Passkeys</div>
    <div class="notice ${passkeys.length < 2 ? 'warn' : ''}">${passkeys.length < 2
      ? `<b>You only have one passkey.</b> If you lose it, your account is gone for good. Add another one: on your phone (scan the QR code your browser offers) or on a security key.`
      : `You have ${passkeys.length} passkeys, so losing one device won't lock you out.`}</div>
    <div class="list">
      ${passkeys.map((p, i) => `<div class="row">
        <div class="grow"><div class="title">Passkey ${i + 1}</div><div class="sub">Added ${fmt(p.created_at)} · last used ${fmt(p.last_used_at)}</div></div>
        ${passkeys.length > 1 ? `<button class="btn small" data-rmkey="${p.id}" aria-label="Remove passkey">✕</button>` : ''}</div>`).join('')}
    </div>
    <button class="btn" id="addKey">Add another passkey</button>`}

    <div class="section-title">Developer settings</div>
    <fieldset class="seg-pick" id="themePick"><legend>Theme (on this device)</legend><div class="seg">
      ${[['auto', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']].map(([value, label]) =>
        `<label><input type="radio" name="theme" value="${value}" ${(window.boredTheme?.get() || 'auto') === value ? 'checked' : ''}><span>${label}</span></label>`).join('')}
    </div></fieldset>

    <button class="btn" id="logout" style="margin-top:24px">${isDemo() ? 'Start over' : 'Sign out'}</button>
    ${deleteAccountHtml(idMode)}
    <p class="note account-id" id="accountId">Account ID: <code>${esc(me.guid)}</code></p>
    </div>
    </div>`;
  const profileBody = v.querySelector('.profile-body');
  const searchProfile = (words) => { profileBody.classList.toggle('searching', words.length > 0); filterShown(profileBody, words); };
  mountSearch(v, searchProfile);
  searchProfile(searchWords(searchQuery()));

  v.querySelector('#newInvite').addEventListener('click', createInvite);
  v.querySelector('#myName').addEventListener('change', async (e) => {
    const name = e.target.value.trim().slice(0, 60);
    try { await vault.update(api, (d) => { d.profile = { ...d.profile, name }; }); toast('Saved'); }
    catch (err) { toast(err.message); }
  });
  v.querySelectorAll('[data-share-invite]').forEach(b => b.onclick = () => {
    const inv = inviteOf(b.dataset.shareInvite);
    if (inv?.token && inv.key) shareInvite(inv);
    else toast("This invitation's link wasn't saved to your account. Delete it and create a new one.");
  });
  v.querySelectorAll('[data-del-invite]').forEach(b => b.onclick = async () => {
    if (!confirm("Delete this invitation? Its link will stop working. People who already connected through it stay connected.")) return;
    try {
      await api(`/api/invites/${b.dataset.delInvite}`, { method: 'DELETE' });
      // Keep its key and name a while: requests already made through it still need them to show their nickname.
      await vault.update(api, (d) => { const e = d.invites?.[b.dataset.delInvite]; if (e) d.invites[b.dataset.delInvite] = { key: e.key, name: e.name }; }).catch(() => {});
      toast('Invitation deleted'); render();
    } catch (err) { toast(err.message); }
  });
  drawPushSettings(v.querySelector('#pushSettings'));
  drawNtfySettings(v.querySelector('#ntfySettings'));
  // Discover news is per account (server.js), for every device with notifications on and for ntfy.
  v.querySelector('#discoverNews')?.addEventListener('change', async (e) => {
    const box = e.target;
    try { ({ discoverNews: state.me.discoverNews } = await api('/api/me/discover-news', { method: 'PUT', body: { on: box.checked } })); toast('Saved'); }
    catch (err) { box.checked = !box.checked; toast(err.message); }
  });
  // The theme stays on this device (public/theme.js), unlike the settings below, which are saved in your vault.
  v.querySelector('#themePick').addEventListener('change', (e) => window.boredTheme?.set(e.target.value));
  v.querySelector('#prefsForm').addEventListener('change', async (e) => {
    if (e.target.name === 'tutorial') return setTutorial(e.target.checked);
    const { distanceUnit } = formData(e.currentTarget);
    try { await vault.update(api, (d) => { d.prefs = { ...d.prefs, distanceUnit }; }); toast('Saved'); }
    catch (err) { toast(err.message); }
  });
  v.querySelectorAll('[data-contact]').forEach(b => b.onclick = () => openContactSheet(b.dataset.contact, () => render()));
  v.querySelectorAll('[data-ctag]').forEach(b => b.onclick = () => {
    sel.has(b.dataset.ctag) ? sel.delete(b.dataset.ctag) : sel.add(b.dataset.ctag); render();
  });
  v.querySelector('[data-cclear]')?.addEventListener('click', () => { sel.clear(); render(); });
  v.querySelector('#addKey')?.addEventListener('click', async () => {
    try {
      toast('First confirm with a passkey you already have, then create the new one.');
      await addPasskey(api, nextStep);
      toast('Passkey added. You now have a backup.'); render();
    } catch (e) {
      toast(e instanceof PrfUnsupportedError ? "That passkey manager can't create the encryption key (some, including Bitwarden, don't support it). Try a security key or your phone."
        : e?.name === 'NotAllowedError' ? 'Passkey request was cancelled.' : e?.name === 'InvalidStateError' ? 'That device already has a passkey for this account.' : e.message);
    }
  });
  v.querySelectorAll('[data-rmkey]').forEach(b => b.onclick = async () => {
    if (!confirm("Remove this passkey? You won't be able to sign in with it anymore.")) return;
    try { await api(`/api/passkeys/${b.dataset.rmkey}`, { method: 'DELETE' }); render(); } catch (e) { toast(e.message); }
  });
  v.querySelector('#logout').onclick = signOut;
  mountDeleteAccount(v);
  mountModeration(v);
  if (state.focus === 'moderation') { state.focus = null; v.querySelector('#moderation')?.scrollIntoView(); }
}

// Profile's Moderation section: word lists, report thresholds, and the people I've blocked.
function moderationHtml() {
  const m = mod(), fmt = (ms) => new Date(ms).toLocaleDateString();
  const check = (name, on, label) => `<label class="check"><input type="checkbox" name="${name}" ${on ? 'checked' : ''}> <span>${label}</span></label>`;
  const HIDE = 'Hide whole posts that use them, instead of starring the words out';
  const blocked = Object.entries(m.blocked).sort(([, a], [, b]) => (b.at || 0) - (a.at || 0));
  return `
    <div class="section-title" id="moderation">Moderation</div>
    <p class="note">Your own rules for what you see. They only change what you see, and they're kept in your encrypted
      vault, so nobody else, including the server, can read them.</p>
    <form class="stack" id="modForm">
      <h3 class="sub-title">Word lists</h3>
      <div class="mod-list">
        ${check('builtinOn', m.builtin.on, `<b>Built-in list of offensive words</b><small>${builtinWords.entries || 'About 400'} slurs, sexual terms, and other
          offensive words and phrases, from <a href="https://github.com/dsojevic/profanity-list" target="_blank" rel="noopener">profanity-list</a>. Mild words aren't on it.</small>`)}
        ${check('builtinHide', m.builtin.hide, HIDE)}
      </div>
      ${m.lists.map((l, i) => `
      <div class="mod-list" data-list="${i}">
        <div class="mod-list-head">
          <input name="name" maxlength="60" placeholder="List name" aria-label="List name" value="${esc(l.name)}">
          <button type="button" class="btn small" data-del-list="${i}">Delete</button>
        </div>
        <label>Words and phrases, one per line or separated by commas. Add * after a letter that may repeat (so*o).
          <textarea name="words" rows="3" spellcheck="false">${esc(l.words.join('\n'))}</textarea></label>
        ${check('on', l.on, 'On')}
        ${check('hide', l.hide, HIDE)}
      </div>`).join('')}
      ${m.lists.length < MAX_LISTS ? '<button type="button" class="btn" id="addList">Add a word list</button>' : ''}

      <h3 class="sub-title">Reports</h3>
      <p class="note">People can report public posts. Hide a post from you, in Discover and its discard pile, once this
        many people have reported it for that reason.</p>
      ${Object.entries(REPORT_REASONS).map(([r, label]) => `
      <div class="mod-report">
        ${check(`rep-${r}`, m.reports[r].on, esc(label))}
        <label class="count">at least <input type="number" name="count-${r}" min="1" max="${MAX_THRESHOLD}" step="1" value="${m.reports[r].count}" aria-label="${esc(label)}: number of reports"> ${m.reports[r].count === 1 ? 'report' : 'reports'}</label>
      </div>`).join('')}
    </form>

    <h3 class="sub-title">Blocked</h3>
    ${blocked.length ? `<div class="list">${blocked.map(([key, b]) => `
      <div class="row">${avatar(b.guid || (b.sign ? `${b.sign.x}.${b.sign.y}` : null))}
        <div class="grow"><div class="title">${esc((b.guid && isContact(b.guid) && displayName(b.guid)) || b.name || 'Someone')}</div>
          <div class="sub">Blocked ${b.at ? fmt(b.at) : ''}</div></div>
        <button type="button" class="btn small" data-unblock="${esc(key)}">Unblock</button>
      </div>`).join('')}</div>`
    : '<p class="note">Nobody. Block someone from a post (Report or block) or from their contact info.</p>'}`;
}

function mountModeration(v) {
  const form = v.querySelector('#modForm');
  if (!form) return;
  // Read the whole form back into the settings.
  const read = (m) => {
    m.builtin = { on: form.builtinOn.checked, hide: form.builtinHide.checked };
    m.lists = [...form.querySelectorAll('[data-list]')].map((el, i) => ({
      ...m.lists[i], name: el.querySelector('[name=name]').value.trim().slice(0, 60),
      words: parseTerms(el.querySelector('[name=words]').value),
      on: el.querySelector('[name=on]').checked, hide: el.querySelector('[name=hide]').checked,
    }));
    for (const r of Object.keys(REPORT_REASONS)) {
      const count = reportThreshold(form[`count-${r}`].value) ?? m.reports[r].count;
      form[`count-${r}`].value = count; // a number it can't take goes back to what was saved
      m.reports[r] = { on: form[`rep-${r}`].checked, count };
    }
  };
  form.addEventListener('change', async () => {
    try {
      await saveMod(read);
      const long = [...form.querySelectorAll('[name=words]')].some(t => parseTerms(t.value).length >= MAX_LIST_WORDS);
      toast(long ? `Saved. Each list keeps up to ${MAX_LIST_WORDS} words.` : 'Saved');
    } catch (err) { toast(err.message); }
  });
  form.querySelector('#addList')?.addEventListener('click', async () => {
    try {
      await saveMod((m) => { read(m); m.lists.push({ id: b64u.enc(crypto.getRandomValues(new Uint8Array(9))), name: `My list ${m.lists.length + 1}`, words: [], on: true, hide: false }); });
      state.focus = 'moderation'; render();
    } catch (err) { toast(err.message); }
  });
  form.querySelectorAll('[data-del-list]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this word list?')) return;
    try { await saveMod((m) => { read(m); m.lists.splice(Number(b.dataset.delList), 1); }); state.focus = 'moderation'; render(); } catch (err) { toast(err.message); }
  });
  v.querySelectorAll('[data-unblock]').forEach(b => b.onclick = async () => {
    const who = mod().blocked[b.dataset.unblock];
    try { if (who) await setBlocked(who, false); toast('Unblocked'); render(); } catch (err) { toast(err.message); }
  });
}

// Refresh the view on screen by scrolling up: Discover, Confirm, and Plans each hand keepFresh their element and a
// refresh. It runs when someone scrolls back up to the top of the page, or pulls down (or scrolls up with a wheel)
// while already there, and the view gives a little bump to show it. At most once every couple of seconds, and never
// while a sheet or overlay is open or a text field has focus. A new view's keepFresh replaces the last one's;
// render() clears it.
const FRESH_GAP = 2000, PULL = 60; // ms between refreshes; px to pull down at the top
let fresh = null;
function keepFresh(el, refresh) {
  if (!document.body.contains(el)) return; // a view left before it finished loading doesn't count
  fresh = { el, refresh, last: fresh?.el === el ? fresh.last : 0 }; // the same view redrawing itself keeps its last refresh
}
function stopFresh() { fresh = null; }
function pullFresh() {
  const f = fresh;
  if (!f || Date.now() - f.last < FRESH_GAP) return;
  if (!document.body.contains(f.el)) return stopFresh();
  if (document.querySelector('.overlay, .sheet') || document.activeElement?.matches('input, textarea, select')) return;
  f.last = Date.now();
  const view = document.getElementById('view');
  view?.classList.remove('bump'); void view?.offsetWidth; view?.classList.add('bump'); // restart the animation
  Promise.resolve().then(f.refresh).catch(err => console.warn('refresh', err));
}
const atTop = () => window.scrollY <= 0;
// Scrolled back up to the top.
let lastY = window.scrollY;
window.addEventListener('scroll', () => { if (lastY > 0 && atTop()) pullFresh(); lastY = window.scrollY; }, { passive: true });
// A wheel or trackpad scrolling up while already at the top.
window.addEventListener('wheel', (e) => { if (e.deltaY < 0 && atTop()) pullFresh(); }, { passive: true });
// A finger pulling down while already at the top. Not on the deck, where dragging a card moves the card.
let pullY = null;
window.addEventListener('touchstart', (e) => {
  pullY = atTop() && e.touches.length === 1 && !e.target.closest('.deck') ? e.touches[0].clientY : null;
}, { passive: true });
window.addEventListener('touchmove', (e) => {
  if (pullY !== null && atTop() && e.touches[0].clientY - pullY > PULL) { pullY = null; pullFresh(); }
}, { passive: true });
window.addEventListener('touchend', () => { pullY = null; }, { passive: true });

// Keep badges fresh without re-rendering the current view.
setInterval(async () => {
  if (!state.me || !hasKeys()) return;
  await refreshMe();
  if (state.me?.counts?.confirm) await api('/api/connection-requests').then(confirmDirectInvites).catch(() => {});
  await loadMail().catch(() => {});
  if (state.me) shellRefreshBadges();
}, 20000);

// Boot: restore the session and, if this browser still holds the keys, the vault.
initMail(api);
await Promise.all([api('/api/config').then(c => { state.config = c; }, () => {}), loadBuiltinWords()]);
// An invitation link (#invite=…): remember it through sign-in, and take it out of the address bar.
{
  const frag = new URLSearchParams(location.hash.slice(1)), token = frag.get('invite');
  if (token) {
    try { sessionStorage.setItem(PENDING_INVITE, JSON.stringify({ token, key: frag.get('key'), name: (frag.get('name') || '').slice(0, 60) })); } catch {}
    history.replaceState(null, '', location.pathname + location.search);
  }
}
if (state.config.authMode === '6j0' && hasIdCallback()) {
  // Back from the 6j0.org identity server with a token and this app's key.
  try {
    const res = await finishIdSignIn(api);
    await enterApp(res.created ? 'profile' : 'discover');
    toast(res.created ? 'Account created!' : 'Welcome back!');
  } catch (e) {
    await refreshMe();
    if (state.me && !hasKeys()) state.tab = 'account';
    render(); toast(e.message);
  }
} else {
  // Network trouble is retried, then shown as such: it never signs anyone out or deletes this browser's keys. Only
  // the server saying I'm signed out, or keys that don't open the vault, do that.
  let offline = false;
  try {
    await retrying(async () => { try { state.me = await api('/api/me'); } catch (e) { if (transient(e)) throw e; state.me = null; } });
    if (state.me && await loadKeys(state.me.guid)) {
      try { await retrying(async () => { await vault.load(api); await ensureKeys(api); }); }
      catch (e) { if (transient(e)) throw e; await clearKeys(); }
      if (hasKeys()) {
        keepStorage();
        await syncConnections().catch(err => console.warn(err));
        await loadMail().catch(err => console.warn(err));
      }
    }
  } catch (e) {
    if (!transient(e)) throw e;
    offline = true; showOffline();
  }
  if (!offline) {
    // Demo mode: nobody signs in. Without a usable account in this browser, make a new one.
    if (isDemo() && !(state.me && hasKeys())) {
      try { if (state.me) await api('/api/logout', { method: 'POST' }); await startDemo(); } catch (e) { toast(e.message); }
    }
    render();
    offerPendingInvite();
    syncPush();
  }
}

// iOS Safari sometimes leaves fixed and sticky things (the tab bar, the chat's message box) floating where the top of
// the keyboard was after the keyboard closes, with the page showing below them, until the next scroll. Scrolling a
// pixel and back when the keyboard goes away (the visible area grows taller, or a text field loses focus) makes it
// put them back.
if (window.visualViewport) {
  let last = visualViewport.height, pending = 0;
  const nudge = () => {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      const y = window.scrollY;
      window.scrollTo(window.scrollX, y + 1);
      window.scrollTo(window.scrollX, y);
    });
  };
  visualViewport.addEventListener('resize', () => {
    const h = visualViewport.height;
    if (h > last + 100) nudge(); // much taller than a moment ago: the keyboard just closed
    last = h;
  });
  document.addEventListener('focusout', (e) => {
    if (e.target.matches?.('input, textarea, select, [contenteditable]')) setTimeout(nudge, 300); // after the keyboard animates away
  });
}

// The service worker shows notifications; tapping one opens the app at ?open=… or messages an open window.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'open') openScreen(e.data.open); });
}
{
  const open = new URLSearchParams(location.search).get('open');
  if (open) { history.replaceState(null, '', location.pathname + location.hash); openScreen(open); }
}
