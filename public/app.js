// Bored? — vanilla JS front-end.
import {
  prfSupport, createAccount, signIn, addPasskey, loadKeys, clearKeys, hasKeys, vault,
  encryptMessage, decryptMessage, PrfUnsupportedError, startIdSignIn, finishIdSignIn, hasIdCallback,
  newInviteKey, sealForInvite, openForInvite, sha1Hex, b64u,
} from './secure.js';
import { locationHtml, mountLocationField, pickLocation, PIN_SVG } from './location.js';
import { parseWhen, repeatOptions, whenLabel as fmtWhen, localToday } from './when.js';
import { CURRENCIES, DEFAULT_CURRENCY, costLabel } from './cost.js';
import { toSvg as identicon } from './vendor/jdenticon.js';
import { addToCalendar } from './ics.js';

// Well-known tags, offered as one-tap suggestions. Posts can also use any other tag.
const TAGS = ['outdoors', 'events', 'food', 'garden', 'hauling', 'moving',
  'repair', 'pets', 'tech', 'cooking', 'errands', 'fitness', 'games', 'movies'];
const MAX_TAGS = 5;
const MAX_ATTENDEES_LIMIT = 500; // must match db.js
const attendeesLabel = (max) => (max == null ? 'No limit' : max === 1 ? '1 person' : `Up to ${max} people`);
const whenLabel = (s) => fmtWhen(s, { today: localToday() });
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
// The server only ever gets a rough spot, rounded to 2 decimals (about a kilometre).
const roughSpot = ({ lat, lon }) => `${lat.toFixed(2)},${lon.toFixed(2)}`;

// Discover's date filter (pick one): day ranges in your own calendar, worked out each time they're used.
const DATE_FILTERS = { today: 'Today', tomorrow: 'Tomorrow', weekend: 'This weekend', week: 'Next 7 days' };
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
// AGPL-3.0 section 13: people using the app over the network must be offered its source.
const SOURCE_URL = 'https://codeberg.org/6j0-org/bored';
const ABOUT_LINKS = `<p class="note" style="margin-top:20px;text-align:center"><a href="/about">About Bored?</a> · 
  <a href="${SOURCE_URL}">Source code</a> (free software, AGPL-3.0)</p>`;

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
      tags: ['outdoors'], max_attendees: 1, when: [18],
    },
  },
  {
    prompt: 'Need some help tending the garden?',
    template: {
      title: 'Help tending the garden',
      details: "Weeding, watering, and some general tidying. I'll provide gloves, tools, and something cold to drink.",
      tags: ['garden', 'outdoors'], max_attendees: 1, when: [10, 6],
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
      tags: ['repair'], max_attendees: 1, when: [14, 0],
    },
  },
  {
    prompt: 'Want to go for a hike?',
    template: {
      title: 'Go for a hike',
      details: "Thinking of hitting a trail nearby. Moderate pace, a few hours. Bring water and good shoes, and we can carpool to the trailhead.",
      tags: ['outdoors'], max_attendees: 2, when: [9, 0],
    },
  },
  {
    prompt: 'Any interesting events happening around town?',
    template: {
      title: 'Check out an event around town',
      details: "There's something happening around town that looks fun. Say what it is and where to find details, and anyone who's interested can come along.",
      tags: ['events'], visibility: 'public',
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
      tags: ['games'], max_attendees: 1, when: [20],
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

// config.authMode: 'local' (Bored? passkeys) | '6j0' (sign in with a 6j0.org identity at config.idOrigin).
const state = { config: { authMode: 'local' }, me: null, tab: 'discover', chat: null, discoverTags: loadSet('discoverTags'), discoverCosts: new Set([...loadSet('discoverCosts')].filter(c => c in COST_FILTERS)),
  discoverDate: (() => { try { const d = localStorage.getItem('discoverDate'); return d in DATE_FILTERS ? d : ''; } catch { return ''; } })(),
  discoverNear: (() => { const n = loadJson('discoverNear', null); return n && Number.isFinite(n.lat) && Number.isFinite(n.lon) ? n : null; })(),
  discoverOnline: loadJson('discoverOnline', false) === true,
  discoverRadius: (() => { const r = Number(loadJson('discoverRadius', 0)); return RADII.includes(r) ? r : 0; })(),
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

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : method !== 'GET' ? '{}' : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.me && !path.startsWith('/api/passkey/') && !path.startsWith('/api/id/')) { state.me = null; await clearKeys(); render(); }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2400);
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

// Add people to my contacts, unnamed unless names[guid] gives a nickname to start with.
async function addContacts(guids, names = {}) {
  const missing = [...new Set(guids)].filter(g => g && !isContact(g));
  if (!missing.length) return;
  await vault.update(api, (d) => {
    for (const g of missing) d.contacts[g] ||= { nickname: names[g] || '', tags: [], added: new Date().toISOString() };
  });
}
// Anyone I've matched with…
const ensureContacts = (matches) => addContacts(matches.map(m => m.other));
// …or connected with through an invitation (theirs or mine). An inviter I asked to connect with gets the nickname I
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
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.innerHTML = `
    <form class="stack panel">
      <h2>New invitation</h2>
      <label>What should they call you?
        <input name="name" required maxlength="60" placeholder="e.g. Evan from the garden club" autocomplete="off"></label>
      <p class="note">This is in the link, as a suggested nickname for you. They can change it; only they see what they pick.</p>
      <div class="two">
        <button type="button" class="btn ghost" data-cancel>Cancel</button>
        <button class="btn">Create and share</button>
      </div>
    </form>`;
  document.body.appendChild(sheet);
  sheet.querySelector('[data-cancel]').onclick = () => sheet.remove();
  sheet.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    if (!name) return;
    try {
      const inv = await api('/api/invites', { method: 'POST' });
      const entry = { token: inv.token, key: newInviteKey(), name };
      await vault.update(api, (d) => { d.invites ||= {}; d.invites[inv.id] = entry; });
      sheet.remove();
      await shareInvite(entry);
      render();
    } catch (err) { toast(err.message); }
  };
  sheet.querySelector('input').focus();
}
async function shareInvite(entry) {
  const url = inviteLink(entry);
  if (navigator.share) {
    try { await navigator.share({ title: 'Connect with me on Bored?', text: "Here's a link to connect with me on Bored?:", url }); return; }
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
  try { info = await api('/api/invites/preview', { method: 'POST', body: { token } }); }
  catch (e) { dropPendingInvite(); return toast(e.message); }
  if (info.mine) { dropPendingInvite(); return toast("That's your own invitation link. Share it with someone else."); }
  if (info.connected) { dropPendingInvite(); return toast("You're already connected with them."); }
  if (info.requested) { dropPendingInvite(); return toast("You've already asked to connect. They'll see it in their Confirm tab."); }
  const ready = state.me && hasKeys();
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.innerHTML = `
    <form class="panel stack">
      <h2>Invitation to connect</h2>
      <div class="invite-from">${avatar(info.icon, 'big')}</div>
      <p>${name ? `<b>${esc(name)}</b> invited you` : 'Someone invited you'} to connect. If you say yes, they'll be asked
        to confirm. Once they do, you'll be in each other's contacts and can share private posts with each other.</p>
      ${ready ? `
      <label>Your nickname for them
        <input name="theirName" required maxlength="60" placeholder="e.g. Evan from the garden club" value="${esc(name || '')}" autocomplete="off"></label>
      <label>What should they call you?
        <input name="myName" required maxlength="60" placeholder="e.g. Sam from book club" autocomplete="off"></label>
      <p class="note">Nicknames are private: only you see the one you give them, and only they see the one they give
        you. What you suggest is encrypted so only they can read it.</p>`
      : '<p class="note">Sign in or create an account first. This invitation will be waiting.</p>'}
      <div class="two">
        <button type="button" class="btn ghost" data-no>No thanks</button>
        <button class="btn">${ready ? 'Ask to connect' : 'Sign in'}</button>
      </div>
    </form>`;
  document.body.appendChild(sheet);
  sheet.querySelector('[data-no]').onclick = () => { sheet.remove(); dropPendingInvite(); };
  sheet.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    if (!ready) { sheet.remove(); return go('account'); } // enterApp offers it again after sign-in
    const theirName = e.target.theirName.value.trim(), myName = e.target.myName.value.trim();
    if (!theirName || !myName) return;
    try {
      const note = await sealForInvite(key, myName);
      const { status } = await api('/api/invites/accept', { method: 'POST', body: { token, note } });
      await vault.update(api, (d) => { d.pendingNames ||= {}; d.pendingNames[info.icon] = theirName; });
      sheet.remove();
      dropPendingInvite();
      if (status === 'connected') { await syncConnections(); return toast("You're already connected with them."); }
      toast("Request sent. You'll be connected once they confirm.");
    } catch (err) { toast(err.message); }
  };
}
const formData = (form) => Object.fromEntries(new FormData(form));

// ---------- swipe deck ----------
const KEEP_CARD = Symbol('keep card'); // onSwipe can return this to leave the card in place
// items: array; renderCard(item) -> inner HTML; onSwipe(item, yes) -> Promise;
// onUndo(item, yes) -> Promise reverses a swipe; labels for stamps.
function mountDeck(root, { items, renderCard, onSwipe, onUndo, yesLabel, noLabel, empty }) {
  root.innerHTML = `
    <div class="deck-wrap">
      <div class="deck"></div>
      <div class="actions">
        <button class="round undo" aria-label="Undo last swipe" title="Undo (Z)" disabled>↶</button>
        <button class="round no" aria-label="${esc(noLabel)}">✕</button>
        <button class="round yes" aria-label="${esc(yesLabel)}">♥</button>
      </div>
      <div class="hint">Swipe right for <b>${esc(yesLabel)}</b>, left for <b>${esc(noLabel)}</b> · or use ← → · Z to undo</div>
    </div>`;
  const wrap = root.querySelector('.deck-wrap');
  const deck = root.querySelector('.deck');
  const undoBtn = root.querySelector('.round.undo');
  const queue = [...items];
  const history = []; // [{ item, yes }], most recent last
  let busy = false;

  function draw() {
    deck.innerHTML = '';
    undoBtn.disabled = !history.length;
    wrap.classList.toggle('is-empty', !queue.length);
    if (!queue.length) { deck.innerHTML = empty; return; }
    queue.slice(0, 2).reverse().forEach((item, i, arr) => {
      const el = document.createElement('div');
      el.className = 'card ' + (i === arr.length - 1 ? 'top' : 'second');
      el.innerHTML = `<div class="stamp yes">${esc(yesLabel)}</div><div class="stamp no">${esc(noLabel)}</div>` + renderCard(item);
      deck.appendChild(el);
    });
    attachDrag(deck.querySelector('.card.top'));
  }

  const flyout = (yes) => `translate(${yes ? 600 : -600}px, 40px) rotate(${yes ? 30 : -30}deg)`;

  async function decide(yes, el = deck.querySelector('.card.top')) {
    if (busy || !el || !queue.length) return;
    busy = true;
    const item = queue[0];
    el.style.transform = flyout(yes);
    el.style.opacity = '0';
    try {
      if ((await onSwipe(item, yes)) === KEEP_CARD) {
        // e.g. a guest swiped yes: put the card back instead of using it up.
        el.style.transform = ''; el.style.opacity = '';
        el.querySelectorAll('.stamp').forEach(st => { st.style.opacity = 0; });
        busy = false;
        return;
      }
      history.push({ item, yes });
    } catch (e) {
      toast(e.message); // stale card (e.g. event closed): drop it anyway, nothing to undo
    }
    queue.shift();
    setTimeout(() => { busy = false; draw(); }, 250);
  }

  async function undo() {
    if (busy || !history.length || !onUndo) return;
    busy = true;
    const last = history.pop();
    try {
      await onUndo(last.item, last.yes);
      queue.unshift(last.item);
      draw();
      // Fly the card back in from the side it left.
      const el = deck.querySelector('.card.top');
      if (el) {
        el.classList.add('dragging');
        el.style.transform = flyout(last.yes); el.style.opacity = '0';
        el.offsetWidth; // force reflow so the transition runs
        el.classList.remove('dragging');
        el.style.transform = ''; el.style.opacity = '';
      }
    } catch (e) {
      toast(e.message);
      draw();
    }
    busy = false;
  }

  function attachDrag(el) {
    if (!el) return;
    const yesS = el.querySelector('.stamp.yes'), noS = el.querySelector('.stamp.no');
    let sx = 0, sy = 0, dx = 0, dy = 0, dragging = false;
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('a,button')) return;
      dragging = true; sx = e.clientX; sy = e.clientY; dx = dy = 0;
      el.setPointerCapture(e.pointerId); el.classList.add('dragging');
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      dx = e.clientX - sx; dy = e.clientY - sy;
      el.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`;
      yesS.style.opacity = Math.max(0, Math.min(1, dx / 100));
      noS.style.opacity = Math.max(0, Math.min(1, -dx / 100));
    });
    const end = () => {
      if (!dragging) return;
      dragging = false; el.classList.remove('dragging');
      if (Math.abs(dx) > 100) decide(dx > 0, el);
      else { el.style.transform = ''; yesS.style.opacity = noS.style.opacity = 0; }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  root.querySelector('.round.yes').onclick = () => decide(true);
  root.querySelector('.round.no').onclick = () => decide(false);
  undoBtn.onclick = undo;
  mountDeck.keyHandler = (e) => {
    if (e.target.matches('input, textarea, select') || document.querySelector('.overlay, .sheet')) return;
    if (e.key === 'ArrowRight') decide(true);
    if (e.key === 'ArrowLeft') decide(false);
    if (e.key === 'z' || e.key === 'Z' || e.key === 'Backspace') { e.preventDefault(); undo(); }
  };
  draw();
}
document.addEventListener('keydown', (e) => mountDeck.keyHandler?.(e));

// ---------- views ----------

function shell(content) {
  const me = state.me, c = me?.counts || {};
  const tabs = me ? TABS : GUEST_TABS;
  app.innerHTML = `
    <header class="top">
      <div class="logo board wide">Bored?</div>
    </header>
    <main id="view"></main>
    <nav class="tabs">
      ${tabs.map(t => {
        const n = t.id === 'confirm' ? c.confirm : t.id === 'plans' ? c.plans : 0;
        return `<button data-tab="${t.id}" class="${state.tab === t.id ? 'active' : ''}">
          ${t.label}${n ? `<span class="badge">${n}</span>` : ''}</button>`;
      }).join('')}
    </nav>`;
  app.querySelectorAll('nav.tabs button').forEach(b => b.onclick = () => go(b.dataset.tab));
  content(document.getElementById('view'));
}

function go(tab) { state.tab = tab; state.chat = null; render(); }

async function refreshMe() {
  try { state.me = await api('/api/me'); } catch { state.me = null; }
}

async function render() {
  mountDeck.keyHandler = null;
  // Signed in, but this browser doesn't hold the keys (e.g. keys were cleared): unlock with a passkey first.
  if (state.me && !hasKeys()) state.tab = 'account';
  if (!state.me && !GUEST_TABS.some(t => t.id === state.tab)) state.tab = 'discover';
  const views = {
    discover: viewDiscover, confirm: viewConfirm, plans: viewPlans, post: viewPost, profile: viewProfile, account: viewAccount,
  };
  shell((v) => views[state.tab](v).catch(err => toast(err.message)));
}

// After any successful sign-in/sign-up/unlock.
async function enterApp(tab = 'discover') {
  await refreshMe();
  await vault.load(api);
  await syncConnections();
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
  const sub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u.dec(publicKey) });
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
// Go where a tapped notification says: 'confirm', 'plans', 'profile', 'discover', or 'chat:<matchId>'.
function openScreen(open) {
  if (!open || !state.me) return;
  const [tab, id] = String(open).split(':');
  if (tab === 'chat' && Number(id)) { state.tab = 'plans'; state.chat = Number(id); }
  else if (['confirm', 'plans', 'profile', 'discover'].includes(tab)) { state.tab = tab; state.chat = null; }
  else return;
  render();
}
// Profile's Notifications section, which depends on the browser and this device's state.
async function drawPushSettings(el) {
  const ios = isIos(), standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  let note = '', on = false, canToggle = false;
  if (!pushSupported()) {
    note = ios && !standalone
      ? 'On iPhone and iPad, first add Bored? to your Home Screen (Share, then Add to Home Screen), open it from there, and turn notifications on here.'
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
    ${canToggle ? `<div class="two">
      <button type="button" class="btn ${on ? 'ghost' : ''}" data-push-toggle>${on ? 'Turn off' : 'Turn on notifications'}</button>
      ${on ? '<button type="button" class="btn ghost" data-push-test>Send a test</button>' : ''}</div>` : ''}`;
  el.querySelector('[data-push-toggle]')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { if (on) { await turnOffPush(); toast('Notifications off for this device'); } else { await turnOnPush(); toast('Notifications on'); } }
    catch (err) { toast(err.message); }
    drawPushSettings(el);
  });
  el.querySelector('[data-push-test]')?.addEventListener('click', () =>
    api('/api/push/test', { method: 'POST' }).then(() => toast('Sent. It should arrive in a moment.'), err => toast(err.message)));
}

const PASSKEY_ADVICE = `Your passkey <b>is</b> your account: there's no email or password to recover it with.
  Add a second passkey in Profile (another device or a security key), so losing one device doesn't lose your account.`;
const UPGRADE_ADVICE = `Bored? encrypts your contacts and chats with a key that only your passkey can make, using a
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
      <div class="notice"><b>No names or email.</b> Bored? uses your anonymous 6j0.org identity: one sign-in, with a
        passkey or a username and password, for every 6j0.org app. New here? You can create one on the next screen.
        Nobody sees a name for you unless they've connected with you, and then only the nickname <em>they</em> chose.
        Your contacts and chats are encrypted with a key only you can unlock.</div>
      ${unlocking ? `<button class="btn danger" id="logout">Sign out</button>` : ''}
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
        <button class="btn ghost" id="create" ${support === false ? 'disabled' : ''}>Create an account</button>`}
      <div class="error" id="authErr"></div>
      <div class="notice ${support === false ? 'warn' : ''}" id="authNote">${support === false ? UPGRADE_ADVICE : `
        <b>No usernames, passwords, or email.</b> You get an anonymous account protected by a passkey.
        Nobody sees a name for you unless they've connected with you, and then only the nickname <em>they</em> chose.
        <br><br>${PASSKEY_ADVICE}`}</div>
      ${unlocking ? `<button class="btn danger" id="logout">Sign out</button>` : ''}
      ${ABOUT_LINKS}
    </div>`;
  const err = v.querySelector('#authErr'), note = v.querySelector('#authNote');
  const fail = (e) => {
    if (e instanceof PrfUnsupportedError) {
      note.classList.add('warn');
      note.innerHTML = UPGRADE_ADVICE + `<br><br>If a "Bored?" passkey was just saved, you can delete it from your passkey manager.`;
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
    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    sheet.innerHTML = `<div class="stack panel" role="dialog" aria-live="polite">
      <h2>One more step</h2><p class="note">${esc(message)}</p>
      <div class="two"><button type="button" class="btn ghost" id="stepCancel">Cancel</button>
        <button type="button" class="btn" id="stepGo">${esc(button)}</button></div></div>`;
    document.body.appendChild(sheet);
    sheet.querySelector('#stepGo').onclick = () => { sheet.remove(); resolve(); };
    sheet.querySelector('#stepCancel').onclick = () => { sheet.remove(); reject(Object.assign(new Error('Cancelled'), { name: 'NotAllowedError' })); };
    sheet.querySelector('#stepGo').focus();
  });
}

async function signOut() {
  await turnOffPush().catch(() => {}); // a signed-out device shouldn't get this account's notifications
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  await clearKeys();
  state.me = null; state.tab = 'discover'; state.chat = null;
  render();
}

// Where a post happens, as HTML: its place (linked to the map), "Online", or both ("City Hall and online").
// e.online: 0 in person, 1 online only, 2 both. '' when nothing is known.
function whereHtml(e) {
  const place = e.online !== 1 && (e.location || e.location_name) ? locationHtml(e.location, '', { name: e.location_name }) : '';
  return e.online === 1 ? 'Online' : e.online === 2 ? `${place || 'In person'} and online` : place;
}

// A Discover card: each detail has a label, and no emoji.
function eventCard(t) {
  const fact = (label, value) => `<dt>${label}</dt><dd>${value}</dd>`;
  return `
    <div class="body">
      <h2>${esc(t.title)}</h2>
      ${t.status === 'full' ? `<div class="meta"><span class="chip warn" title="Say yes to join the waitlist">Full: join the waitlist</span></div>` : ''}
      <dl class="facts">
        ${t.when_text ? fact('When', `<button type="button" class="link" data-ics="${t.id}" title="Add to your calendar">${esc(whenLabel(t.when_text))}</button>`) : ''}
        ${whereHtml(t) ? fact('Where', whereHtml(t)) : ''}
        ${fact('Cost', esc(costLabel(t.cost_amount, t.cost_currency)))}
        ${fact('Max attendees', attendeesLabel(t.max_attendees))}
        ${fact('Who can see it', t.visibility === 'private' ? 'Private: the host shared it with you' : 'Public')}
        ${t.tags.length ? fact('Tags', t.tags.map(x => '#' + esc(x)).join(' ')) : ''}
      </dl>
      ${t.details ? `<div class="details">${esc(t.details)}</div>` : ''}
      <div class="who">${avatar(t.host.guid || t.host.icon)}
        <div>${contactName(t.host.guid) ? `<b>${esc(contactName(t.host.guid))}</b>` : '<b>Host</b>'}
          <small>Hosted ${t.host.hosted} · Attended ${t.host.attended}</small></div>
      </div>
    </div>`;
}

async function viewDiscover(v) {
  v.innerHTML = `<div class="filters" id="filters"></div><div class="deck-host" id="deckHost"></div>`;
  const filtersEl = v.querySelector('#filters'), host = v.querySelector('#deckHost');
  let options = { tags: [], costs: [], dates: [] }, events = [];

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
      <details class="filter-box" ${state.filtersOpen ? 'open' : ''}>
        <summary>Filters${on ? ` <span class="badge">${on}</span>` : ''}</summary>
        <div class="filter-body">
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
            ${on ? `<button type="button" class="chip filter clear" data-clear>Clear all</button>` : ''}
          </div>
        </div>
      </details>`;
    filtersEl.querySelector('details').addEventListener('toggle', (e) => { state.filtersOpen = e.target.open; });
  }

  async function load() {
    const params = new URLSearchParams();
    if (state.discoverTags.size) params.set('tags', [...state.discoverTags].join(','));
    if (state.discoverCosts.size) params.set('cost', [...state.discoverCosts].join(','));
    if (state.discoverDate) { const [from, to] = dateFilterRange(state.discoverDate); params.set('from', from); params.set('to', to); }
    const near = state.discoverNear;
    if (near && state.discoverRadius) { params.set('near', roughSpot(near)); params.set('km', String(state.discoverRadius * kmPerUnit())); }
    if (state.discoverOnline) params.set('online', '1');
    const fp = new URLSearchParams({ dates: Object.keys(DATE_FILTERS).map(k => [k, ...dateFilterRange(k)].join(':')).join(',') });
    if (near) { fp.set('near', roughSpot(near)); fp.set('radii', RADII.map(r => r * kmPerUnit()).join(',')); }
    let opts;
    [events, opts] = await Promise.all([api('/api/discover' + (params.size ? `?${params}` : '')), api(`/api/discover/filters?${fp}`)]);
    options = opts;
    drawFilters();
    mountDeck(host, deckOptions(events, { tags: [...state.discoverTags], costs: [...state.discoverCosts], date: state.discoverDate,
      near: [near && state.discoverRadius && `Within ${fmtDistance(state.discoverRadius)} of ${near.label.toLowerCase()}`,
        state.discoverOnline && 'online'].filter(Boolean).join(' or ').replace(/^online$/, 'Online') }));
  }
  // Clearing the filters keeps your location; it only turns the distance off.
  const clearAll = () => { state.discoverTags.clear(); state.discoverCosts.clear(); state.discoverDate = ''; state.discoverRadius = 0; state.discoverOnline = false; };
  const setNear = (lat, lon, label) => {
    state.discoverNear = { lat, lon, label };
    if (!state.discoverRadius) state.discoverRadius = DEFAULT_RADIUS;
  };
  const refresh = () => { saveDiscoverFilters(); load().catch(err => toast(err.message)); };
  const toggle = (set, value) => (set.has(value) ? set.delete(value) : set.add(value));

  filtersEl.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-near-pick')) {
      const n = state.discoverNear;
      const v = await pickLocation(n ? `${n.lat},${n.lon}` : '', '', {
        title: 'Your location', nameField: false, clearLabel: 'Forget my location',
        note: 'Drop the pin where you are, to see posts nearby. It stays on this device; the server only gets a rough spot, to within about a kilometre.',
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
    if (cal) addToCalendar(events.find(t => t.id === Number(cal.dataset.ics)));
    if (e.target.id === 'goPost') go('post');
    if (e.target.id === 'clearFilters') { clearAll(); saveDiscoverFilters(); load().catch(err => toast(err.message)); }
  });
  await load();
}

function deckOptions(events, filters) {
  return {
    items: events,
    renderCard: eventCard,
    yesLabel: "I'm in", noLabel: 'Pass',
    onSwipe: async (t, yes) => {
      if (!state.me) {
        // Guests can browse; passing is just local, but saying yes needs an account.
        if (yes) { toast('Sign in or create an account to say yes.'); go('account'); return KEEP_CARD; }
        return;
      }
      await api(`/api/events/${t.id}/swipe`, { method: 'POST', body: { yes } });
      if (yes) toast(t.status === 'full'
        ? `Asked to join the waitlist for “${t.title}”. If the host says yes, you'll get the next open spot.`
        : `Asked to join “${t.title}”! You'll match if the host swipes yes too.`);
    },
    onUndo: async (t, yes) => {
      if (state.me) await api(`/api/events/${t.id}/swipe`, { method: 'DELETE' });
      toast(yes ? `Took back your request to join “${t.title}”` : 'Undone');
    },
    empty: filters.tags.length || filters.costs.length || filters.date || filters.near
      ? `<div class="empty"><h3>No matches for these filters</h3>
          <p>${[filters.near && esc(filters.near), filters.date && esc(DATE_FILTERS[filters.date]), filters.tags.length && filters.tags.map(t => '#' + esc(t)).join(' or '), filters.costs.length && filters.costs.map(c => esc(COST_FILTERS[c])).join(' or ')].filter(Boolean).join(' · ')}</p>
          <p>Nothing open matches right now. Try other filters, or see everything.</p>
          <button class="btn" id="clearFilters">Show all posts</button></div>`
      : `<div class="empty"><h3>Still bored?</h3>
          ${state.me
            ? `<p>Nothing new right now. Check back later, or post something you think people would enjoy.</p>
          <button class="btn" id="goPost">Post something</button>`
            : `<p>Nothing new right now. Check back later.</p>`}</div>`,
  };
}

// Confirm: people asking to join my posts, and people asking to connect through my invitation links.
function connectCard(c) {
  return `
      <div class="hero">${avatar(c.requester.icon, 'big')}</div>
      <div class="body">
        <div class="meta"><span class="chip">Wants to connect${c.via ? ` through your invitation as “${esc(c.via)}”` : ''}</span></div>
        <h2>${c.suggested ? esc(c.suggested) : 'Someone'}</h2>
        ${c.suggested ? '<p class="note">The nickname they suggest for themselves. You can change it after you connect.</p>' : ''}
        <p>They opened one of your invitation links and asked to connect. If you say yes, you'll be in each other's
          contacts and can share private posts with each other.</p>
        <div class="who" style="justify-content:space-around;text-align:center">
          <div><b>${c.requester.hosted}</b><small>events hosted</small></div>
          <div><b>${c.requester.attended}</b><small>events attended</small></div>
        </div>
      </div>`;
}

async function viewConfirm(v) {
  const [interested, requests] = await Promise.all([api('/api/confirm'), api('/api/connection-requests')]);
  // Their suggested nickname, decrypted with the key of the invitation they used (kept in my vault).
  for (const c of requests) {
    const inv = c.invite_id && inviteOf(c.invite_id);
    c.via = inv?.name || '';
    c.suggested = inv?.key && c.note ? await openForInvite(inv.key, c.note) : null;
  }
  mountDeck(v, {
    items: [...requests.map(c => ({ ...c, kind: 'connect' })), ...interested],
    renderCard: (o) => o.kind === 'connect' ? connectCard(o) : `
      <div class="hero">
        ${avatar(o.attendee.guid || o.attendee.icon, 'big')}
      </div>
      <div class="body">
        <div class="meta"><span class="chip">${contactName(o.attendee.guid) ? 'wants' : 'Wants'} to join: <b>${esc(o.title)}</b></span></div>
        ${contactName(o.attendee.guid) ? `<h2>${esc(contactName(o.attendee.guid))}</h2>` : ''}
        ${o.note ? `<div class="details">“${esc(o.note)}”</div>` : ''}
        ${o.full ? `<p class="note">This post is full, so saying yes puts them on the waitlist. They'll be matched automatically when a spot opens.</p>` : ''}
        <div class="who" style="justify-content:space-around;text-align:center">
          <div><b>${o.attendee.hosted}</b><small>events hosted</small></div>
          <div><b>${o.attendee.attended}</b><small>events attended</small></div>
        </div>
      </div>`,
    yesLabel: "Let's do it", noLabel: 'No thanks',
    onSwipe: async (o, yes) => {
      if (o.kind === 'connect') {
        const r = await api(`/api/connection-requests/${o.id}/respond`, { method: 'POST', body: { yes } });
        await refreshMe();
        shellRefreshBadges();
        if (r.connected) {
          o.added = !isContact(r.guid) && r.guid; // so an undo can take back a contact this just added
          await addContacts([r.guid], o.suggested ? { [r.guid]: o.suggested } : {});
          toast(o.suggested ? `Connected with ${o.suggested}! Change their nickname if you like.` : "Connected! Give them a nickname only you'll see.");
          openContactSheet(r.guid, () => {});
        }
        return;
      }
      const r = await api(`/api/confirm/${o.id}/respond`, { method: 'POST', body: { yes } });
      await refreshMe();
      shellRefreshBadges();
      if (r.match) showMatch(r.other, o.title, r.matchId);
      else if (r.waitlisted) toast(`Added ${contactName(o.attendee.guid) || 'them'} to the waitlist for “${o.title}”`);
    },
    onUndo: async (o, yes) => {
      if (o.kind === 'connect') {
        await api(`/api/connection-requests/${o.id}/undo`, { method: 'POST' });
        if (o.added) await vault.update(api, (d) => { delete d.contacts[o.added]; }).catch(() => {});
        await refreshMe();
        shellRefreshBadges();
        return toast(yes ? 'Disconnected' : 'Undone');
      }
      await api(`/api/confirm/${o.id}/undo`, { method: 'POST' });
      await refreshMe();
      shellRefreshBadges();
      toast(yes ? (contactName(o.attendee.guid) ? `Unmatched with ${contactName(o.attendee.guid)}` : 'Unmatched') : 'Undone');
    },
    empty: `<div class="empty"><h3>Nobody to confirm</h3>
      <p>When someone swipes yes on one of your posts, or asks to connect through one of your invitation links,
        they'll show up here for you to answer.</p></div>`,
  });
}

function showMatch(otherGuid, title, matchId) {
  const known = isContact(otherGuid);
  const o = document.createElement('div');
  o.className = 'overlay';
  o.innerHTML = `
    <h1>It's on!</h1>
    <div class="pair">${avatar(state.me.guid)}${avatar(otherGuid)}</div>
    <p>You and <b>${esc(known ? displayName(otherGuid) : 'a new contact')}</b> are teaming up on<br><b>${esc(title)}</b></p>
    ${known ? '' : `<p style="opacity:.8;font-size:.9rem">They're in your contacts now. Give them a nickname from the chat; only you will see it.</p>`}
    <button class="btn" id="mChat">Send a message</button>
    <button class="btn ghost" id="mKeep">Keep swiping</button>`;
  document.body.appendChild(o);
  o.querySelector('#mKeep').onclick = () => { o.remove(); shellRefreshBadges(); };
  o.querySelector('#mChat').onclick = () => { o.remove(); state.tab = 'plans'; state.chat = matchId; render(); };
}

function shellRefreshBadges() {
  // Re-render only the nav badges without disturbing the current deck.
  const c = state.me.counts || {};
  app.querySelectorAll('nav.tabs button').forEach(b => {
    b.querySelector('.badge')?.remove();
    const n = b.dataset.tab === 'confirm' ? c.confirm : b.dataset.tab === 'plans' ? c.plans : 0;
    if (n) b.insertAdjacentHTML('beforeend', `<span class="badge">${n}</span>`);
  });
}

async function viewPlans(v) {
  if (state.chat) return viewChat(v, state.chat);
  const matches = await api('/api/matches');
  await ensureContacts(matches);
  // Decrypt the last-message previews (only you and the other person can read them).
  await Promise.all(matches.map(async m => {
    if (m.last_message && m.last_kind === 'user') m.last_message = await decryptMessage(m.id, m.other_pubkey, m.last_message) ?? 'Encrypted message';
  }));
  if (!matches.length) {
    v.innerHTML = `<div class="empty"><h3>No plans yet</h3>
      <p>Swipe right on something you'd like to join. When the host swipes yes on you, you'll match.</p>
      <button class="btn" id="goD">Find something to do</button></div>`;
    v.querySelector('#goD').onclick = () => go('discover');
    return;
  }
  const active = matches.filter(m => m.status === 'accepted'), waiting = matches.filter(m => m.status === 'waitlisted');
  const past = matches.filter(m => !['accepted', 'waitlisted'].includes(m.status));
  const pill = (m) =>
    m.status === 'attended' ? `<span class="pill">Happened ✓</span>`
    : m.status === 'withdrawn' ? `<span class="pill">Dropped out</span>`
    : m.reconfirm ? `<span class="pill warn">${m.role === 'attendee' ? 'Re-confirm?' : 'Awaiting OK'}</span>`
    : `<span class="pill go">It's on</span>`;
  const row = (m) => `
    <button class="row" data-id="${m.id}">
      <div class="grow">
        <div class="title">${esc(m.title)}</div>
        <div class="sub">${m.role === 'attendee' ? `Hosted by ${esc(displayName(m.other))}` : `${esc(displayName(m.other))} is going`}${m.last_message ? ' · ' + esc(m.last_message) : ''}</div>
      </div>
      ${pill(m)}
    </button>`;
  // Waitlist rows have no chat yet: that opens when a spot does and they're matched.
  const waitRow = (m) => `
    <div class="row">
      <div class="grow">
        <div class="title">${esc(m.title)}</div>
        <div class="sub">${contactName(m.other) ? `Hosted by ${esc(contactName(m.other))} · ` : ''}#${m.waitlist_pos} on the waitlist</div>
      </div>
      <button class="btn ghost small" data-leave="${m.event_id}">Leave</button>
    </div>`;
  v.innerHTML = `
    ${active.length ? `<div class="section-title">Happening</div><div class="list">${active.map(row).join('')}</div>` : ''}
    ${waiting.length ? `<div class="section-title">Waitlist</div>
      <p class="note">These posts are full. You'll be matched automatically, in order, when a spot opens.</p>
      <div class="list">${waiting.map(waitRow).join('')}</div>` : ''}
    ${past.length ? `<div class="section-title">Past</div><div class="list">${past.map(row).join('')}</div>` : ''}`;
  v.querySelectorAll('button.row').forEach(r => r.onclick = () => { state.chat = Number(r.dataset.id); render(); });
  v.querySelectorAll('[data-leave]').forEach(b => b.onclick = async () => {
    if (!confirm('Leave this waitlist?')) return;
    try { await api(`/api/events/${b.dataset.leave}/swipe`, { method: 'DELETE' }); toast('Left the waitlist'); render(); }
    catch (err) { toast(err.message); }
  });
}

async function viewChat(v, id) {
  const matches = await api('/api/matches');
  const m = matches.find(x => x.id === id);
  if (!m) { state.chat = null; return viewPlans(v); }
  await ensureContacts([m]);
  const name = displayName(m.other);
  v.innerHTML = `
    <div class="chat">
      <div class="chat-head">
        <button class="back" aria-label="Back">←</button>
        ${avatar(m.other)}
        <div class="grow" style="flex:1;min-width:0">
          <button type="button" class="link" id="rename" title="Change the nickname only you see">${esc(name)} ✎</button>
          <div class="sub" style="color:var(--muted);font-size:.85rem">${esc(m.title)}${m.when_text ? ` · <button type="button" class="link cal-link" id="addCal" title="Add to your calendar">${esc(whenLabel(m.when_text))}</button>` : ''}${whereHtml(m) ? ' · ' + whereHtml(m) : ''}</div>
        </div>
        ${m.role === 'host' && m.status === 'accepted' ? `<button class="btn small" id="happened">It happened</button>` : ''}
        ${m.role === 'attendee' && m.status === 'accepted' && !m.reconfirm ? `<button class="btn ghost small" id="leave">Can't make it</button>` : ''}
      </div>
      <div class="msgs" id="msgs"></div>
      ${m.status === 'accepted' && m.reconfirm && m.role === 'attendee' ? `
        <div class="reconfirm">
          <div><b>${esc(name)} changed this post.</b> Can you still make it?</div>
          <div class="btns">
            <button class="btn small" id="stillIn">I'm still in</button>
            <button class="btn danger small" id="cantGo">Can't make it</button>
          </div>
        </div>` : ''}
      ${m.status === 'accepted' ? `
        <form class="composer" id="composer">
          <label class="sr-only" for="chatBody">Message</label>
          <input id="chatBody" name="body" placeholder="Say hi, sort out the details…" autocomplete="off" maxlength="2000" required>
          <button class="btn">Send</button>
        </form>` : ''}
    </div>`;
  v.querySelector('.back').onclick = () => { state.chat = null; render(); };
  v.querySelector('#rename').onclick = () => openContactSheet(m.other, () => render());
  v.querySelector('#addCal')?.addEventListener('click', () => addToCalendar({ id: m.event_id, title: m.title, location: m.location, location_name: m.location_name, online: m.online, when_text: m.when_text }));

  const msgsEl = v.querySelector('#msgs');
  async function loadMsgs() {
    const msgs = await api(`/api/matches/${id}/messages`);
    const sys = m.role === 'attendee'
      ? `You asked to join and ${esc(name)} said yes!`
      : `${esc(name)} asked to join and you said yes!`;
    const tail = m.status === 'attended' ? '<div class="msg sys">Marked as happened. Hope it was fun!</div>'
      : m.status === 'accepted' && m.reconfirm && m.role === 'host' ? `<div class="msg sys">Waiting for ${esc(name)} to re-confirm</div>`
      : '';
    msgsEl.innerHTML = `<div class="msg sys">${sys}</div>` +
      (await Promise.all(msgs.map(async x => {
        if (x.kind === 'system') return `<div class="msg sys notice">${esc(x.body)}</div>`;
        const text = await decryptMessage(id, m.other_pubkey, x.body);
        return `<div class="msg ${x.mine ? 'mine' : ''}">${text === null ? '<i>Couldn\'t decrypt this message</i>' : esc(text)}</div>`;
      }))).join('') + tail;
    msgsEl.scrollTop = msgsEl.scrollHeight;
    window.scrollTo(0, document.body.scrollHeight);
  }
  await loadMsgs();
  const poll = setInterval(() => { if (state.chat !== id || !document.body.contains(msgsEl)) clearInterval(poll); else loadMsgs().catch(() => {}); }, 5000);

  v.querySelector('#composer')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = e.target.body;
    try {
      const body = await encryptMessage(id, m.other_pubkey, input.value); // end-to-end: the server only sees ciphertext
      await api(`/api/matches/${id}/messages`, { method: 'POST', body: { body } });
      input.value = ''; await loadMsgs();
    }
    catch (err) { toast(err.message); }
  });
  const reconfirm = async (yes) => {
    if (!yes && !confirm(`Drop out of “${m.title}”? ${name} will be told you can't make it.`)) return;
    try {
      await api(`/api/matches/${id}/reconfirm`, { method: 'POST', body: { yes } });
      toast(yes ? `Told ${name} you're still in` : `You've dropped out`);
      await refreshMe(); render();
    } catch (err) { toast(err.message); }
  };
  v.querySelector('#leave')?.addEventListener('click', async () => {
    if (!confirm(`Drop out of “${m.title}”? ${name} will be told, and your spot goes to the next person on the waitlist.`)) return;
    try { await api(`/api/matches/${id}/leave`, { method: 'POST' }); toast(`You've dropped out`); await refreshMe(); render(); }
    catch (err) { toast(err.message); }
  });
  v.querySelector('#stillIn')?.addEventListener('click', () => reconfirm(true));
  v.querySelector('#cantGo')?.addEventListener('click', () => reconfirm(false));
  v.querySelector('#happened')?.addEventListener('click', async () => {
    if (!confirm(`Mark “${m.title}” as happened with ${name}?`)) return;
    await api(`/api/matches/${id}/happened`, { method: 'POST' });
    await refreshMe();
    toast(`Glad it happened! Thanks, ${name}.`);
    render();
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
        <div class="tag-box"><input id="${tagsId}" class="tag-input" placeholder="e.g. garden, outdoors" maxlength="30" enterkeyhint="done"></div>
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
            placeholder="${t.location && !t.location_name ? 'Spot picked on the map (no name yet)' : 'e.g. Ocean Beach Pier'}">
          <input type="hidden" name="location" value="${val('location')}">
          <button type="button" class="loc-pick" aria-label="Pick on a map" title="Pick on a map">${PIN_SVG}</button>
        </div>
      </div>
      ${whenInputs(t.when_text)}
      ${costInputs(t)}
      ${audienceInputs(t)}
      <label>Max attendees
        <input name="max_attendees" type="number" inputmode="numeric" step="1" min="${Math.max(1, t.matched || 0)}" max="${MAX_ATTENDEES_LIMIT}"
          placeholder="e.g. 4, or blank for no limit" value="${t.max_attendees ?? ''}"></label>`;
}

// "When": the browser's date and time picker for the first (or only) time, plus a Repeats menu whose choices
// follow the date picked (see public/when.js).
const repeatOptionsHtml = (start, selected) => repeatOptions(start)
  .map(o => `<option value="${o.rule}" data-kind="${o.kind}" ${o.kind === selected ? 'selected' : ''}>${esc(o.label)}</option>`).join('');
function whenInputs(v = '') {
  const w = parseWhen(v);
  return `
      <label>When
        <input name="when_text" type="datetime-local" value="${esc(w?.start ?? '')}"></label>
      <label>Repeats
        <select name="when_repeat" ${w ? '' : 'disabled'}>${repeatOptionsHtml(w?.start, w?.repeat.kind)}</select></label>`;
}
// New date → new repeat choices, keeping the same kind of repeat where it still exists. "The Nth weekday" and
// "the last weekday" stand in for each other, since a date near the end of a month may offer only one of them.
function mountWhenFields(form) {
  const input = form.querySelector('input[name=when_text]'), sel = form.querySelector('select[name=when_repeat]');
  if (!input || !sel) return;
  input.addEventListener('input', () => {
    const kind = sel.selectedOptions[0]?.dataset.kind || 'once', kinds = repeatOptions(input.value).map(o => o.kind);
    const keep = kinds.includes(kind) ? kind
      : ['nthday', 'lastday'].includes(kind) ? kinds.find(k => k === 'nthday' || k === 'lastday') : 'once';
    sel.innerHTML = repeatOptionsHtml(input.value, keep);
    sel.disabled = !input.value;
  });
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
// tags) the host picks. Contacts live only in the encrypted vault, so the browser expands the pick into account
// GUIDs for the server, and keeps the pick itself in the vault (audiences[eventId]) so it can re-send the list when
// group membership changes (syncAudiences).
const emptyAudience = () => ({ groups: [], contacts: [] });
const audienceOf = (eventId) => vault.data.audiences?.[eventId] || emptyAudience();
function audienceGuids({ groups = [], contacts = [] }) {
  const all = vault.data.contacts;
  return [...new Set([...contacts.filter(g => all[g]), ...Object.keys(all).filter(g => (all[g].tags || []).some(t => groups.includes(t)))])];
}
const contactGroups = () => {
  const counts = {};
  for (const c of Object.values(vault.data.contacts)) for (const t of c.tags || []) counts[t] = (counts[t] || 0) + 1;
  return Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
};

function audienceInputs(t = {}) {
  const vis = t.visibility || 'private';
  return `
      <fieldset class="seg-pick"><legend>Who can see it?</legend><div class="seg">
        <label><input type="radio" name="visibility" value="private" ${vis === 'private' ? 'checked' : ''}><span>Private</span></label>
        <label><input type="radio" name="visibility" value="public" ${vis === 'public' ? 'checked' : ''}><span>Public</span></label>
      </div></fieldset>
      <div class="audience" ${vis === 'public' ? 'hidden' : ''} data-audience="${esc(JSON.stringify(t.id ? audienceOf(t.id) : emptyAudience()))}"></div>`;
}

// Draws the group and contact chips; form.audience() returns the current pick.
function mountAudience(form) {
  const box = form.querySelector('.audience');
  if (!box) return;
  const pick = JSON.parse(box.dataset.audience);
  const radios = form.querySelectorAll('input[name=visibility]');
  const draw = () => {
    const groups = contactGroups();
    const contacts = Object.keys(vault.data.contacts).sort((a, b) => displayName(a).localeCompare(displayName(b)));
    const n = audienceGuids(pick).length;
    const chip = (kind, value, label, on) =>
      `<button type="button" class="chip filter ${on ? 'on' : ''}" data-${kind}="${esc(value)}" aria-pressed="${on}">${label}</button>`;
    box.innerHTML = !contacts.length
      ? `<p class="note">You don't have any contacts yet; people are added when you match with them. Until then only you
          can see a private post. Make it public to find people.</p>`
      : `${groups.length ? `<div class="filter-row stacked" role="group" aria-label="Groups"><span class="label">Groups</span>
          ${groups.map(([g, count]) => chip('group', g, `#${esc(g)} <span class="n">${count}</span>`, pick.groups.includes(g))).join('')}</div>` : ''}
        <div class="filter-row stacked" role="group" aria-label="Contacts"><span class="label">People</span>
          ${contacts.map(g => chip('contact', g, esc(displayName(g)), pick.contacts.includes(g))).join('')}</div>
        <p class="note">${n ? `Only you and ${n === 1 ? '1 person' : `${n} people`} can see this.` : 'Only you can see this until you pick someone.'}
          ${pick.groups.length ? 'People you add to these groups later will see it too.' : ''}</p>`;
  };
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const [list, v] = b.dataset.group ? [pick.groups, b.dataset.group] : [pick.contacts, b.dataset.contact];
    const i = list.indexOf(v);
    if (i >= 0) list.splice(i, 1); else list.push(v);
    draw();
  });
  radios.forEach(r => r.addEventListener('change', () => { box.hidden = form.querySelector('input[name=visibility]:checked').value === 'public'; }));
  form.audience = () => (form.querySelector('input[name=visibility]:checked')?.value === 'public' ? null : pick);
  draw();
}

// Create or update a post from its form, including who can see it, and remember the pick in the vault.
async function saveEvent(form, id) {
  const pick = form.audience?.() ?? null;
  const body = { ...formData(form), viewers: pick ? audienceGuids(pick) : [] };
  const r = id ? await api(`/api/events/${id}`, { method: 'PATCH', body }) : await api('/api/events', { method: 'POST', body });
  const eventId = id || r.id;
  const had = Boolean(vault.data.audiences?.[eventId]);
  if (hasKeys() && (pick || had)) {
    await vault.update(api, (d) => {
      d.audiences ||= {};
      if (pick) d.audiences[eventId] = { groups: [...pick.groups], contacts: [...pick.contacts] };
      else delete d.audiences[eventId];
    }).catch(err => toast(err.message));
  }
  return r;
}

// What a new post's audience is, for the toast after posting.
function postedMessage(form) {
  const pick = form.audience?.();
  if (!pick) return 'Posted! Anyone can now swipe on it.';
  const n = audienceGuids(pick).length;
  return n ? `Posted! ${n === 1 ? '1 person' : `${n} people`} can now swipe on it.` : 'Posted. Only you can see it until you share it with someone.';
}

// After contacts' groups change, re-send who can see each private post shared with a group.
async function syncAudiences() {
  const entries = Object.entries(vault.data.audiences || {}).filter(([, a]) => a.groups?.length);
  const gone = [];
  await Promise.all(entries.map(([id, a]) => api(`/api/events/${id}/viewers`, { method: 'PUT', body: { viewers: audienceGuids(a) } })
    .catch(err => { if (/not found/i.test(err.message)) gone.push(id); })));
  if (gone.length) await vault.update(api, (d) => { for (const id of gone) delete d.audiences?.[id]; });
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
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.innerHTML = `
    <form class="stack panel" id="sheetForm">
      <h2>${editing ? 'Edit post' : 'New post'}</h2>
      ${eventFormFields(t)}
      ${editing && t.matched ? `<p class="note">Anyone you've matched with will get a message about what changed and be asked to re-confirm.</p>` : ''}
      ${editing ? '' : `<p class="note">Tweak anything you like, then post it.</p>`}
      <div class="two">
        <button type="button" class="btn ghost" id="cancelSheet">Cancel</button>
        <button class="btn">${editing ? 'Save changes' : 'Post it'}</button>
      </div>
    </form>`;
  document.body.appendChild(sheet);
  sheet.querySelectorAll('.tag-editor').forEach(mountTagEditor);
  mountAudience(sheet.querySelector('form'));
  mountLocationField(sheet.querySelector('form'));
  mountWhenFields(sheet.querySelector('form'));
  mountCostFields(sheet.querySelector('form'));
  const close = () => sheet.remove();
  sheet.querySelector('#cancelSheet').onclick = close;
  sheet.onclick = (e) => { if (e.target === sheet) close(); };
  sheet.querySelector('#sheetForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      if (editing) {
        const r = await saveEvent(e.target, t.id);
        toast(r.notified ? `Saved. Asked ${r.notified} attendee${r.notified > 1 ? 's' : ''} to re-confirm.` : 'Saved');
      } else {
        await saveEvent(e.target);
        toast(postedMessage(e.target));
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
  el.querySelector('.idea-open').onclick = () => {
    const { when, ...t } = POST_IDEAS[i].template;
    openPostSheet({ ...t, when_text: when ? nextAt(...when) : '' });
  };
  el.querySelector('.idea-next').onclick = next;
  el.querySelector('.idea-prev').onclick = prev;
  const timer = setInterval(() => {
    if (!document.body.contains(el)) return clearInterval(timer);
    if (el.matches(':hover') || document.activeElement?.closest('#newEvent') || document.querySelector('.sheet')) return;
    next();
  }, POST_IDEA_MS);
}

async function viewPost(v) {
  const events = await api('/api/events');
  const statusPill = (t) => ({
    open: `<span class="pill">${t.pending ? `${t.pending} interested` : 'Looking'}</span>`,
    full: `<span class="pill go">It's on</span>`,
    past: `<span class="pill">Happened ✓</span>`,
  }[t.status]);
  v.innerHTML = `
    <div class="section-title">Post something</div>
    <div class="idea" id="postIdea">
      <button type="button" class="idea-prev" aria-label="Previous idea" title="Previous idea">‹</button>
      <button type="button" class="idea-open" title="Start a post from this idea">
        <span class="text" aria-live="polite"></span>
      </button>
      <button type="button" class="idea-next" aria-label="Next idea" title="Next idea">›</button>
    </div>
    <form class="stack" id="newEvent">
      ${eventFormFields()}
      <button class="btn">Post it</button>
    </form>
    <div class="section-title">Your posts</div>
    <div class="list">
      ${events.length ? events.map(t => `
        <div class="row">
          <div class="grow">
            <div class="title">${esc(t.title)}</div>
            ${t.tags.length ? `<div class="sub">${t.tags.map(x => '#' + esc(x)).join(' ')}</div>` : ''}
            <div class="sub">${t.visibility === 'public' ? 'Public' : `${t.viewers ? `${t.viewers} can see` : 'Only you'}`} · ${t.max_attendees == null ? `${t.matched} matched · no limit` : `${t.matched}/${t.max_attendees} matched`}${t.waitlisted ? ` · ${t.waitlisted} waitlisted` : ''}${t.awaiting ? ` · ${t.awaiting} to re-confirm` : ''}${t.when_text ? ' · ' + esc(whenLabel(t.when_text)) : ''}</div>
          </div>
          ${statusPill(t)}
          ${t.status !== 'past' ? `<button class="btn ghost small" data-edit="${t.id}" aria-label="Edit">✎</button>
            <button class="btn danger small" data-del="${t.id}" aria-label="Remove">✕</button>` : ''}
        </div>`).join('') : `<p style="color:var(--muted)">Nothing yet. What would you like to host?</p>`}
    </div>`;
  rotatePostIdeas(v.querySelector('#postIdea'));
  v.querySelectorAll('.tag-editor').forEach(mountTagEditor);
  mountAudience(v.querySelector('#newEvent'));
  mountLocationField(v.querySelector('#newEvent'));
  mountWhenFields(v.querySelector('#newEvent'));
  mountCostFields(v.querySelector('#newEvent'));
  v.querySelector('#newEvent').onsubmit = async (e) => {
    e.preventDefault();
    try { await saveEvent(e.target); toast(postedMessage(e.target)); render(); }
    catch (err) { toast(err.message); }
  };
  v.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openPostSheet(events.find(t => t.id === Number(b.dataset.edit))));
  v.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Remove this post?')) return;
    await api(`/api/events/${b.dataset.del}`, { method: 'DELETE' });
    if (vault.data.audiences?.[b.dataset.del]) await vault.update(api, (d) => { delete d.audiences[b.dataset.del]; }).catch(() => {});
    render();
  });
}

// Edit the nickname and tags you keep for a contact. Saved only in your encrypted vault.
function openContactSheet(guid, onSaved) {
  const c = vault.data.contacts[guid] || { nickname: '', tags: [] };
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.innerHTML = `
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
    </form>`;
  document.body.appendChild(sheet);
  sheet.querySelectorAll('.tag-editor').forEach(el => mountTagEditor(el, CONTACT_TAGS));
  const close = () => sheet.remove();
  sheet.querySelector('#cancelSheet').onclick = close;
  sheet.onclick = (e) => { if (e.target === sheet) close(); };
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
  const [ledger, passkeys, invites] = await Promise.all([api('/api/ledger'), idMode ? [] : api('/api/passkeys'), api('/api/invites')]);
  const me = state.me;
  const history = Object.fromEntries(ledger.map(l => [l.guid, l]));
  const contacts = Object.entries(vault.data.contacts).map(([guid, c]) => ({ guid, ...c, ...(history[guid] || {}) }))
    .sort((a, b) => (a.nickname || '~').localeCompare(b.nickname || '~'));
  const allTags = [...new Set(contacts.flatMap(c => c.tags || []))].sort();
  state.contactTags ||= new Set();
  for (const t of state.contactTags) if (!allTags.includes(t)) state.contactTags.delete(t);
  const sel = state.contactTags;
  const shown = sel.size ? contacts.filter(c => (c.tags || []).some(t => sel.has(t))) : contacts;
  const fmt = (iso) => iso ? new Date(iso.replace(' ', 'T') + 'Z').toLocaleDateString() : 'never';

  v.innerHTML = `
    <div class="me-head">${avatar(me.guid)}
      <div class="grow"><h2>You</h2></div>
    </div>
    <div class="stats">
      <div class="stat"><b>${me.hosted}</b><span>events hosted</span></div>
      <div class="stat"><b>${me.attended}</b><span>events attended</span></div>
    </div>

    <div class="section-title">Notifications</div>
    <div class="stack" id="pushSettings"></div>

    <div class="section-title">Settings</div>
    <form class="stack" id="prefsForm">
      <label>Distance units
        <select name="distanceUnit">
          <option value="km" ${useMiles() ? '' : 'selected'}>Kilometers</option>
          <option value="mi" ${useMiles() ? 'selected' : ''}>Miles</option>
        </select></label>
    </form>

    <div class="section-title">Invitations</div>
    <p class="note">Send people a link to connect. When someone opens it and asks to connect, they show up in your
      Confirm tab; once you say yes, you're in each other's contacts and can share private posts. Anyone with the link
      can use it until you delete it; deleting it doesn't disconnect anyone.</p>
    ${invites.length ? `<div class="list">${invites.map((inv, i) => `
      <div class="row">
        <div class="grow"><div class="title">${inviteOf(inv.id)?.name ? `As “${esc(inviteOf(inv.id).name)}”` : `Invitation ${invites.length - i}`}</div>
          <div class="sub">Created ${fmt(inv.created_at)} · ${inv.uses === 1 ? '1 person' : `${inv.uses} people`} connected</div></div>
        <button class="btn ghost small" data-share-invite="${inv.id}">Share</button>
        <button class="btn danger small" data-del-invite="${inv.id}">Delete</button>
      </div>`).join('')}</div>` : ''}
    <button class="btn ghost" id="newInvite">Create an invitation</button>

    <div class="section-title">Contacts</div>
    <p class="note">People you've matched or connected with. Names and tags here are yours alone: they're encrypted with your passkey, and nobody else, including the server, can read them.</p>
    ${allTags.length ? `<div class="filter-row" role="group" aria-label="Filter contacts by tag"><span class="label">Tags</span>
      ${allTags.map(t => `<button type="button" class="chip filter ${sel.has(t) ? 'on' : ''}" data-ctag="${esc(t)}" aria-pressed="${sel.has(t)}">#${esc(t)}</button>`).join('')}
      ${sel.size ? `<button type="button" class="chip filter clear" data-cclear>Clear</button>` : ''}</div>` : ''}
    <div class="list">
      ${shown.length ? shown.map(c => `
        <button class="row" data-contact="${esc(c.guid)}">${avatar(c.guid)}
          <div class="grow"><div class="title">${esc(c.nickname || 'Unnamed contact')}</div>
            <div class="sub">${(c.tags || []).map(t => '#' + esc(t)).join(' ')}${c.tags?.length ? ' · ' : ''}${c.together || 0} event${c.together === 1 ? '' : 's'} together</div></div>
          <span class="pill">✎</span></button>`).join('')
        : `<p style="color:var(--muted)">${contacts.length ? 'No contacts with those tags.' : "Once you match with someone, they'll show up here for you to name and tag."}</p>`}
    </div>

    ${idMode ? `<div class="section-title">Sign-in</div>
    <div class="notice">You sign in with your 6j0.org identity. Manage your passkeys and password at
      <a href="${esc(state.config.idOrigin)}/">${esc(idHost())}</a>. Keep at least two ways to sign in, so losing one doesn't lose your account.</div>` : `
    <div class="section-title">Passkeys</div>
    <div class="notice ${passkeys.length < 2 ? 'warn' : ''}">${passkeys.length < 2
      ? `<b>You only have one passkey.</b> If you lose it, your account is gone for good. Add another one: on your phone (scan the QR code your browser offers) or on a security key.`
      : `You have ${passkeys.length} passkeys, so losing one device won't lock you out.`}</div>
    <div class="list">
      ${passkeys.map((p, i) => `<div class="row">
        <div class="grow"><div class="title">Passkey ${i + 1}</div><div class="sub">Added ${fmt(p.created_at)} · last used ${fmt(p.last_used_at)}</div></div>
        ${passkeys.length > 1 ? `<button class="btn danger small" data-rmkey="${p.id}" aria-label="Remove passkey">✕</button>` : ''}</div>`).join('')}
    </div>
    <button class="btn ghost" id="addKey">Add another passkey</button>`}

    <button class="btn danger" id="logout" style="margin-top:24px">Sign out</button>
    ${ABOUT_LINKS}`;

  v.querySelector('#newInvite').addEventListener('click', createInvite);
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
  v.querySelector('#prefsForm').addEventListener('change', async (e) => {
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
}

// Keep badges fresh without re-rendering the current view.
setInterval(async () => { if (state.me && hasKeys()) { await refreshMe(); if (state.me) shellRefreshBadges(); } }, 20000);

// Boot: restore the session and, if this browser still holds the keys, the vault.
try { state.config = await api('/api/config'); } catch {}
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
  await refreshMe();
  if (state.me && await loadKeys(state.me.guid)) {
    try { await vault.load(api); await syncConnections(); } catch { await clearKeys(); }
  }
  render();
  offerPendingInvite();
  syncPush();
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
