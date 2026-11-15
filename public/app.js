// Bored? — vanilla JS front-end.
import {
  prfSupport, createAccount, signIn, addPasskey, loadKeys, clearKeys, hasKeys, vault,
  encryptMessage, decryptMessage, PrfUnsupportedError, startIdSignIn, finishIdSignIn, hasIdCallback,
} from './secure.js';

// Well-known tags: offered as one-tap suggestions, and the first one on a post picks its icon and color (.tag-<name>).
// Posts can also use any other tag; those show with ✨ and a neutral color.
const TAG_ICONS = {
  social: '🎉', outdoors: '🥾', events: '🎟️', food: '🍽️', garden: '🌱', hauling: '🚚', moving: '📦',
  repair: '🔧', pets: '🐕', tech: '💻', cooking: '🍲', errands: '🛒',
};
const MAX_TAGS = 5;
// Cost levels (must match COSTS in db.js).
const COSTS = { free: 'Free', low: '$', medium: '$$', high: '$$$' };
const MAX_ATTENDEES_LIMIT = 500; // must match db.js
const attendeesLabel = (max) => (max == null ? 'No limit' : max === 1 ? '1 person' : `Up to ${max} people`);
const COST_HINTS = { free: 'Free', low: 'Under about $20', medium: 'About $20–50', high: 'Over about $50' };
const tagLook = (tags = []) => {
  const known = tags.find(t => TAG_ICONS[t]);
  return known ? { ico: TAG_ICONS[known], cls: `tag-${known}` } : { ico: '✨', cls: 'tag-none' };
};
const tagChips = (tags = []) => tags.map(t => `<span class="chip tag">#${esc(t)}</span>`).join('');
// Mirror of the server's normalizeTag (db.js) so chips show what will be saved.
const normalizeTag = (raw) => String(raw ?? '').toLowerCase().trim().replace(/^#+/, '')
  .replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
// Suggested tags for organizing your contacts (private, stored only in your encrypted vault).
const CONTACT_TAGS = { family: '👪', friends: '🫶', neighbors: '🏡', work: '💼' };

// Signed-out guests can browse Discover; everything else needs an account.
const GUEST_TABS = [
  { id: 'discover', ico: '🤝', label: 'Discover' },
  { id: 'account', ico: '🔑', label: 'Sign in' },
];
const TABS = [
  { id: 'discover', ico: '🤝', label: 'Discover' },
  { id: 'confirm', ico: '🙋', label: 'Confirm' },
  { id: 'plans', ico: '💬', label: 'Plans' },
  { id: 'post', ico: '📝', label: 'Post' },
  { id: 'profile', ico: '⭐', label: 'Profile' },
];

// Rotating ideas shown above the form in the Post tab. Tapping one opens a new post pre-filled with its template.
const POST_IDEAS = [
  {
    prompt: "Is there a local restaurant you've been meaning to check out?",
    template: {
      title: 'Try out a local restaurant together',
      details: "There's a place nearby I've been meaning to check out. Want to come along? We can each get our own check.",
      tags: ['food', 'social'], max_attendees: 2, when_text: 'This week, dinner', cost: 'medium',
    },
  },
  {
    prompt: 'Want some company on a walk around the neighborhood?',
    template: {
      title: 'Walk around the neighborhood',
      details: 'Looking for some company on a walk. Easy pace, about an hour. Dogs welcome!',
      tags: ['social', 'outdoors'], max_attendees: 1, when_text: 'This evening',
    },
  },
  {
    prompt: 'Need some help tending the garden?',
    template: {
      title: 'Help tending the garden',
      details: "Weeding, watering and some general tidying. I'll provide gloves, tools and something cold to drink.",
      tags: ['garden', 'outdoors'], max_attendees: 1, when_text: 'Saturday morning',
    },
  },
  {
    prompt: "Time to do some grocery shopping? It's more fun with a friend!",
    template: {
      title: 'Grocery run together',
      details: "Heading to the grocery store. Come along and we'll make a trip of it. Happy to share a ride.",
      tags: ['errands', 'social'], max_attendees: 1, when_text: 'This weekend',
    },
  },
  {
    prompt: 'Need help building a piece of furniture?',
    template: {
      title: 'Help assembling some furniture',
      details: "Got a flat-pack piece that's a two-person job. I have the instructions and an Allen key; a drill would be a bonus. Should take an hour or two.",
      tags: ['repair'], max_attendees: 1, when_text: 'This weekend',
    },
  },
  {
    prompt: 'Want to go for a hike?',
    template: {
      title: 'Go for a hike',
      details: "Thinking of hitting a trail nearby. Moderate pace, a few hours. Bring water and good shoes, and we can carpool to the trailhead.",
      tags: ['outdoors', 'social'], max_attendees: 2, when_text: 'Sunday morning',
    },
  },
  {
    prompt: 'Any interesting events happening around town?',
    template: {
      title: 'Check out an event around town',
      details: "There's something happening around town that looks fun. Say what it is and where to find details, and anyone who's interested can come along.",
      tags: ['events', 'social'], public_event: true, when_text: '',
    },
  },
];
const POST_IDEA_MS = 5000;

// config.authMode: 'local' (Bored? passkeys) | '6j0' (sign in with a 6j0.org identity at config.idOrigin).
const state = { config: { authMode: 'local' }, me: null, tab: 'discover', chat: null, discoverTags: loadSet('discoverTags'), discoverCosts: loadSet('discoverCosts') };
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
// connected (matched); everyone else is "A neighbor". Your own nickname for yourself is also private to you.
const isContact = (guid) => Boolean(vault.data.contacts[guid]);
function displayName(guid) {
  if (state.me && guid === state.me.guid) return vault.data.self.nickname || 'You';
  const c = vault.data.contacts[guid];
  return c ? (c.nickname || 'Unnamed contact') : 'A neighbor';
}
function hue(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
// Color comes from the GUID; the letter from your nickname for them (strangers get a plain dot).
const avatar = (guid, cls = '') => {
  const named = (state.me && guid === state.me.guid && vault.data.self.nickname) || vault.data.contacts[guid]?.nickname;
  return `<div class="avatar ${cls}" style="background:hsl(${hue(guid)} 55% 45%)">${named ? esc([...named][0].toUpperCase()) : '•'}</div>`;
};

// Add anyone I've matched with to my contacts (unnamed until I give them a nickname).
async function ensureContacts(matches) {
  const missing = [...new Set(matches.map(m => m.other))].filter(g => !isContact(g));
  if (!missing.length) return;
  await vault.update(api, (d) => { for (const g of missing) d.contacts[g] ||= { nickname: '', tags: [], added: new Date().toISOString() }; });
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
          <span class="ico">${t.ico}</span>${t.label}${n ? `<span class="badge">${n}</span>` : ''}</button>`;
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
  state.tab = tab; state.chat = null;
  render();
}

const PASSKEY_ADVICE = `Your passkey <b>is</b> your account: there's no email or password to recover it with.
  Keep it in a password manager like <b>Bitwarden</b>, or add a second device in Profile, so losing one device
  doesn't lose your account.`;
const UPGRADE_ADVICE = `Bored? encrypts your contacts and chats with a key that only your passkey can make, and this
  browser or passkey manager can't do that yet. Please update to the latest <b>Chrome</b>, <b>Edge</b>, <b>Safari</b>
  (macOS/iOS 18 or newer) or <b>Firefox</b>, or store your passkey in <b>Bitwarden</b>, then try again.`;

const idHost = () => new URL(state.config.idOrigin).host;

// AUTH_MODE=6j0: one button for sign-in, sign-up and unlock; the identity server handles the passkey.
function viewAccountId(v) {
  const unlocking = Boolean(state.me);
  v.innerHTML = `
    <div class="account stack">
      <p class="lead">${unlocking ? 'Unlock your account with your 6j0.org identity to see your contacts and chats.'
        : `Swipe through what's happening nearby, and when you and the host both say yes, it's on.
           Join something fun, or host your own.`}</p>
      <button class="btn" id="idSignIn">🔑 ${unlocking ? 'Unlock' : 'Continue'} with ${esc(idHost())}</button>
      <div class="error" id="authErr"></div>
      <div class="notice"><b>No usernames, passwords or email.</b> Bored? uses your anonymous 6j0.org identity: one
        passkey for every 6j0.org app. New here? You can create one on the next screen.
        Nobody sees a name for you unless they've connected with you, and then only the nickname <em>they</em> chose.
        Your contacts and chats are encrypted with a key only your passkey can unlock.</div>
      ${unlocking ? `<button class="btn danger" id="logout">Sign out</button>` : ''}
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
      ${unlocking ? `<button class="btn" id="signIn">🔓 Unlock with passkey</button>` : `
        <button class="btn" id="signIn">🔑 Sign in with passkey</button>
        <button class="btn ghost" id="create" ${support === false ? 'disabled' : ''}>✨ Create an account</button>`}
      <div class="error" id="authErr"></div>
      <div class="notice ${support === false ? 'warn' : ''}" id="authNote">${support === false ? UPGRADE_ADVICE : `
        <b>No usernames, passwords or email.</b> You get an anonymous account protected by a passkey.
        Nobody sees a name for you unless they've connected with you, and then only the nickname <em>they</em> chose.
        <br><br>${PASSKEY_ADVICE}`}</div>
      ${unlocking ? `<button class="btn danger" id="logout">Sign out</button>` : ''}
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
      <h2>🔑 One more step</h2><p class="note">${esc(message)}</p>
      <div class="two"><button type="button" class="btn ghost" id="stepCancel">Cancel</button>
        <button type="button" class="btn" id="stepGo">${esc(button)}</button></div></div>`;
    document.body.appendChild(sheet);
    sheet.querySelector('#stepGo').onclick = () => { sheet.remove(); resolve(); };
    sheet.querySelector('#stepCancel').onclick = () => { sheet.remove(); reject(Object.assign(new Error('Cancelled'), { name: 'NotAllowedError' })); };
    sheet.querySelector('#stepGo').focus();
  });
}

async function signOut() {
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  await clearKeys();
  state.me = null; state.tab = 'discover'; state.chat = null;
  render();
}

function eventCard(t) {
  return `
    <div class="hero ${tagLook(t.tags).cls}">${tagLook(t.tags).ico}</div>
    <div class="body">
      <h2>${esc(t.title)}</h2>
      ${t.tags.length ? `<div class="meta">${tagChips(t.tags)}</div>` : ''}
      <div class="meta">
        ${t.location ? `<span class="chip">📍 ${esc(t.location)}</span>` : ''}
        ${t.when_text ? `<span class="chip">🗓 ${esc(t.when_text)}</span>` : ''}
        <span class="chip" title="${esc(COST_HINTS[t.cost])}">💵 ${esc(COSTS[t.cost] || 'Free')}</span>
        <span class="chip">${t.public_event ? '🎟️ Open to everyone' : `👥 ${attendeesLabel(t.max_attendees)}`}</span>
      </div>
      ${t.details ? `<div class="details">${esc(t.details)}</div>` : ''}
      <div class="who">${avatar(t.host.guid)}
        <div><b>${esc(displayName(t.host.guid))}</b>
          <small>Hosted ${t.host.hosted} · Attended ${t.host.attended}</small></div>
      </div>
    </div>`;
}

async function viewDiscover(v) {
  v.innerHTML = `<div class="filters" id="filters"></div><div class="deck-host" id="deckHost"></div>`;
  const filtersEl = v.querySelector('#filters'), host = v.querySelector('#deckHost');
  let options = { tags: [], costs: [] };

  function drawFilters() {
    const selTags = state.discoverTags, selCosts = state.discoverCosts;
    // Keep selected tags visible even when no open posts carry them right now.
    const tags = [...options.tags, ...[...selTags].filter(t => !options.tags.some(a => a.tag === t)).map(tag => ({ tag, count: 0 }))];
    const chip = (kind, value, label, count, on, title = '') => `
      <button type="button" class="chip filter ${on ? 'on' : ''}" data-${kind}="${esc(value)}" aria-pressed="${on}" ${title ? `title="${esc(title)}"` : ''}>
        ${label} <span class="n">${count}</span></button>`;
    filtersEl.innerHTML = `
      ${tags.length ? `<div class="filter-row" role="group" aria-label="Filter by tag"><span class="label">Tags</span>
        ${tags.map(({ tag, count }) => chip('tag', tag, `${TAG_ICONS[tag] || '#'} ${esc(tag)}`, count, selTags.has(tag))).join('')}</div>` : ''}
      <div class="filter-row" role="group" aria-label="Filter by cost"><span class="label">Cost</span>
        ${options.costs.map(({ cost, count }) => chip('cost', cost, esc(COSTS[cost]), count, selCosts.has(cost), COST_HINTS[cost])).join('')}
        ${selTags.size || selCosts.size ? `<button type="button" class="chip filter clear" data-clear>Clear all</button>` : ''}
      </div>`;
  }

  async function load() {
    const params = new URLSearchParams();
    if (state.discoverTags.size) params.set('tags', [...state.discoverTags].join(','));
    if (state.discoverCosts.size) params.set('cost', [...state.discoverCosts].join(','));
    const [events, opts] = await Promise.all([api('/api/discover' + (params.size ? `?${params}` : '')), api('/api/discover/filters')]);
    options = opts;
    drawFilters();
    mountDeck(host, deckOptions(events, { tags: [...state.discoverTags], costs: [...state.discoverCosts] }));
  }
  const clearAll = () => { state.discoverTags.clear(); state.discoverCosts.clear(); };
  const toggle = (set, value) => (set.has(value) ? set.delete(value) : set.add(value));

  filtersEl.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-clear')) clearAll();
    else if (b.dataset.tag) toggle(state.discoverTags, b.dataset.tag);
    else if (b.dataset.cost) toggle(state.discoverCosts, b.dataset.cost);
    saveDiscoverFilters();
    load().catch(err => toast(err.message));
  });
  v.addEventListener('click', (e) => {
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
      if (yes) toast(`Asked to join “${t.title}”! You'll match if the host swipes yes too.`);
    },
    onUndo: async (t, yes) => {
      if (state.me) await api(`/api/events/${t.id}/swipe`, { method: 'DELETE' });
      toast(yes ? `Took back your request to join “${t.title}”` : 'Undone');
    },
    empty: filters.tags.length || filters.costs.length
      ? `<div class="empty"><div class="big">🔎</div><h3>No matches for these filters</h3>
          <p>${[filters.tags.length && filters.tags.map(t => '#' + esc(t)).join(' or '), filters.costs.length && filters.costs.map(c => esc(COSTS[c])).join(' or ')].filter(Boolean).join(' · ')}</p>
          <p>Nothing open matches right now. Try other filters, or see everything.</p>
          <button class="btn" id="clearFilters">Show all posts</button></div>`
      : `<div class="empty"><div class="big">🌤</div><h3>Still bored?</h3>
          <p>Nothing new right now. Check back later, or post something you think people would enjoy.</p>
          <button class="btn" id="goPost">Post something</button></div>`,
  };
}

async function viewConfirm(v) {
  const interested = await api('/api/confirm');
  mountDeck(v, {
    items: interested,
    renderCard: (o) => `
      <div class="hero ${tagLook(o.tags).cls}">
        ${avatar(o.attendee.guid, 'big')}
      </div>
      <div class="body">
        <div class="meta"><span class="chip">${tagLook(o.tags).ico} wants to join: <b>${esc(o.title)}</b></span></div>
        <h2>${esc(displayName(o.attendee.guid))}</h2>
        ${o.note ? `<div class="details">“${esc(o.note)}”</div>` : ''}
        <div class="who" style="justify-content:space-around;text-align:center">
          <div><b>${o.attendee.hosted}</b><small>events hosted</small></div>
          <div><b>${o.attendee.attended}</b><small>events attended</small></div>
        </div>
      </div>`,
    yesLabel: "Let's do it", noLabel: 'No thanks',
    onSwipe: async (o, yes) => {
      const r = await api(`/api/confirm/${o.id}/respond`, { method: 'POST', body: { yes } });
      await refreshMe();
      shellRefreshBadges();
      if (r.match) showMatch(o.attendee.guid, o.title, r.matchId);
    },
    onUndo: async (o, yes) => {
      await api(`/api/confirm/${o.id}/undo`, { method: 'POST' });
      await refreshMe();
      shellRefreshBadges();
      toast(yes ? `Unmatched with ${displayName(o.attendee.guid)}` : 'Undone');
    },
    empty: `<div class="empty"><div class="big">🙋</div><h3>Nobody to confirm</h3>
      <p>When someone swipes yes on one of your posts, they'll show up here for you to swipe back.</p></div>`,
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
    if (m.last_message && m.last_kind === 'user') m.last_message = await decryptMessage(m.id, m.other_pubkey, m.last_message) ?? '🔒';
  }));
  if (!matches.length) {
    v.innerHTML = `<div class="empty"><div class="big">💬</div><h3>No plans yet</h3>
      <p>Swipe right on something you'd like to join. When the host swipes yes on you, you'll match.</p>
      <button class="btn" id="goD">Find something to do</button></div>`;
    v.querySelector('#goD').onclick = () => go('discover');
    return;
  }
  const active = matches.filter(m => m.status === 'accepted'), past = matches.filter(m => m.status !== 'accepted');
  const pill = (m) =>
    m.status === 'attended' ? `<span class="pill">Happened ✓</span>`
    : m.status === 'withdrawn' ? `<span class="pill">Dropped out</span>`
    : m.reconfirm ? `<span class="pill warn">${m.role === 'attendee' ? 'Re-confirm?' : 'Awaiting OK'}</span>`
    : `<span class="pill go">It's on</span>`;
  const row = (m) => `
    <button class="row" data-id="${m.id}">
      <div class="dot ${tagLook(m.tags).cls}">${tagLook(m.tags).ico}</div>
      <div class="grow">
        <div class="title">${esc(m.title)}</div>
        <div class="sub">${m.role === 'attendee' ? `Hosted by ${esc(displayName(m.other))}` : `${esc(displayName(m.other))} is going`}${m.last_message ? ' · ' + esc(m.last_message) : ''}</div>
      </div>
      ${pill(m)}
    </button>`;
  v.innerHTML = `
    ${active.length ? `<div class="section-title">Happening</div><div class="list">${active.map(row).join('')}</div>` : ''}
    ${past.length ? `<div class="section-title">Past</div><div class="list">${past.map(row).join('')}</div>` : ''}`;
  v.querySelectorAll('.row').forEach(r => r.onclick = () => { state.chat = Number(r.dataset.id); render(); });
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
          <div class="sub" style="color:var(--muted);font-size:.85rem">${tagLook(m.tags).ico} ${esc(m.title)}${m.when_text ? ' · ' + esc(m.when_text) : ''}${m.location ? ' · ' + esc(m.location) : ''}</div>
        </div>
        ${m.role === 'host' && m.status === 'accepted' ? `<button class="btn small" id="happened">It happened</button>` : ''}
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
          <input name="body" placeholder="Say hi, sort out the details…" autocomplete="off" maxlength="2000" required>
          <button class="btn">Send</button>
        </form>` : ''}
    </div>`;
  v.querySelector('.back').onclick = () => { state.chat = null; render(); };
  v.querySelector('#rename').onclick = () => openContactSheet(m.other, () => render());

  const msgsEl = v.querySelector('#msgs');
  async function loadMsgs() {
    const msgs = await api(`/api/matches/${id}/messages`);
    const sys = m.role === 'attendee'
      ? `You asked to join and ${esc(name)} said yes!`
      : `${esc(name)} asked to join and you said yes!`;
    const tail = m.status === 'attended' ? '<div class="msg sys">✅ Marked as happened. Hope it was fun!</div>'
      : m.status === 'accepted' && m.reconfirm && m.role === 'host' ? `<div class="msg sys">⏳ Waiting for ${esc(name)} to re-confirm</div>`
      : '';
    msgsEl.innerHTML = `<div class="msg sys">🤝 ${sys}</div>` +
      (await Promise.all(msgs.map(async x => {
        if (x.kind === 'system') return `<div class="msg sys notice">${esc(x.body)}</div>`;
        const text = await decryptMessage(id, m.other_pubkey, x.body);
        return `<div class="msg ${x.mine ? 'mine' : ''}">${text === null ? '🔒 <i>Couldn\'t decrypt this message</i>' : esc(text)}</div>`;
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
  v.querySelector('#stillIn')?.addEventListener('click', () => reconfirm(true));
  v.querySelector('#cantGo')?.addEventListener('click', () => reconfirm(false));
  v.querySelector('#happened')?.addEventListener('click', async () => {
    if (!confirm(`Mark “${m.title}” as happened with ${name}?`)) return;
    await api(`/api/matches/${id}/happened`, { method: 'POST' });
    await refreshMe();
    toast(`🎉 Glad it happened! Thanks, ${name}.`);
    render();
  });
}

function eventFormFields(t = {}) {
  const val = (k) => esc(t[k] ?? '');
  return `
      <input name="title" placeholder="e.g. Pick up compost & spread it on my garden" required maxlength="100" value="${val('title')}">
      <textarea name="details" placeholder="Details: what's involved, what you'll provide (tools, snacks, beer…)" maxlength="1000">${val('details')}</textarea>
      <div class="tag-editor" data-tags="${esc(JSON.stringify(t.tags || []))}">
        <input type="hidden" name="tags">
        <div class="tag-box"><input class="tag-input" placeholder="Add tags, e.g. garden, social" aria-label="Add a tag" maxlength="30" enterkeyhint="done"></div>
        <div class="tag-suggest"></div>
      </div>
      <div class="two">
        <input name="location" placeholder="📍 Where" maxlength="100" value="${val('location')}">
        <input name="when_text" placeholder="🗓 When" maxlength="100" value="${val('when_text')}">
      </div>
      <fieldset class="cost-pick"><legend style="float:left;margin-right:10px">💵 Cost</legend><div class="seg">
        ${Object.entries(COSTS).map(([k, label]) => `<label title="${esc(COST_HINTS[k])}"><input type="radio" name="cost" value="${k}" ${(t.cost || 'free') === k ? 'checked' : ''}><span>${label}</span></label>`).join('')}
      </div></fieldset>
      <label class="switch-row"><input type="checkbox" name="public_event" ${t.public_event ? 'checked' : ''}>
        🎟️ Open to everyone <small>Public, or ticketed elsewhere, so no attendee cap</small></label>
      <label class="inline max-attendees" ${t.public_event ? 'hidden' : ''}>👥 Max attendees
        <input name="max_attendees" type="number" inputmode="numeric" step="1" min="${Math.max(1, t.matched || 0)}" max="${MAX_ATTENDEES_LIMIT}"
          placeholder="No limit" value="${t.max_attendees ?? ''}">
        <small>Leave blank for no limit</small></label>`;
}

// Chip-style tag input inside eventFormFields. Keeps the hidden "tags" input in sync (comma-separated).
// Enter or comma adds a tag, Backspace on an empty box removes the last, suggestions add with one tap.
// Open-to-everyone switch: hides the attendee cap (the server ignores it too) and adds #events as a convenience.
function mountPublicEventSwitch(form) {
  const box = form.querySelector('input[name=public_event]'), cap = form.querySelector('.max-attendees');
  if (!box || !cap) return;
  box.addEventListener('change', () => {
    cap.hidden = box.checked;
    if (box.checked) form.querySelector('.tag-editor')?.dispatchEvent(new CustomEvent('tag:add', { detail: 'events' }));
  });
}

// suggestions: { tag: icon } offered as one-tap chips (post tags by default; contacts use CONTACT_TAGS).
function mountTagEditor(root, suggestions = TAG_ICONS) {
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
      : Object.keys(suggestions).filter(t => !tags.includes(t))
        .map(t => `<button type="button" class="chip suggest" data-add="${t}">${suggestions[t]} ${t}</button>`).join('');
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
  mountPublicEventSwitch(sheet.querySelector('form'));
  const close = () => sheet.remove();
  sheet.querySelector('#cancelSheet').onclick = close;
  sheet.onclick = (e) => { if (e.target === sheet) close(); };
  sheet.querySelector('#sheetForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      if (editing) {
        const r = await api(`/api/events/${t.id}`, { method: 'PATCH', body: formData(e.target) });
        toast(r.notified ? `Saved. Asked ${r.notified} attendee${r.notified > 1 ? 's' : ''} to re-confirm.` : 'Saved');
      } else {
        await api('/api/events', { method: 'POST', body: formData(e.target) });
        toast('Posted! Neighbors can now swipe on it.');
      }
      close();
      render();
    } catch (err) { toast(err.message); }
  };
  sheet.querySelector('input[name=title]').focus();
}

// Cycle through POST_IDEAS; pauses while hovered, while the form has focus, or while a sheet is open.
// Tap the idea to open its template; tap › to skip ahead.
function rotatePostIdeas(el) {
  const text = el.querySelector('.text');
  let i = Math.floor(Math.random() * POST_IDEAS.length);
  const show = () => {
    text.classList.remove('in'); text.offsetWidth; // restart the fade-in
    text.textContent = POST_IDEAS[i].prompt; text.classList.add('in');
  };
  const next = () => { i = (i + 1) % POST_IDEAS.length; show(); };
  show();
  el.querySelector('.idea-open').onclick = () => openPostSheet({ ...POST_IDEAS[i].template });
  el.querySelector('.idea-next').onclick = next;
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
      <button type="button" class="idea-open" title="Start a post from this idea">
        <span class="ico">💡</span><span class="text" aria-live="polite"></span>
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
          <div class="dot ${tagLook(t.tags).cls}">${tagLook(t.tags).ico}</div>
          <div class="grow">
            <div class="title">${esc(t.title)}</div>
            ${t.tags.length ? `<div class="sub">${t.tags.map(x => '#' + esc(x)).join(' ')}</div>` : ''}
            <div class="sub">${t.public_event ? `${t.matched} going · open to everyone` : t.max_attendees == null ? `${t.matched} matched · no limit` : `${t.matched}/${t.max_attendees} matched`}${t.awaiting ? ` · ${t.awaiting} to re-confirm` : ''}${t.when_text ? ' · ' + esc(t.when_text) : ''}</div>
          </div>
          ${statusPill(t)}
          ${t.status !== 'past' ? `<button class="btn ghost small" data-edit="${t.id}" aria-label="Edit">✎</button>
            <button class="btn danger small" data-del="${t.id}" aria-label="Remove">✕</button>` : ''}
        </div>`).join('') : `<p style="color:var(--muted)">Nothing yet. What would you like to host?</p>`}
    </div>`;
  rotatePostIdeas(v.querySelector('#postIdea'));
  v.querySelectorAll('.tag-editor').forEach(mountTagEditor);
  mountPublicEventSwitch(v.querySelector('#newEvent'));
  v.querySelector('#newEvent').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/api/events', { method: 'POST', body: formData(e.target) }); toast('Posted! Neighbors can now swipe on it.'); render(); }
    catch (err) { toast(err.message); }
  };
  v.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openPostSheet(events.find(t => t.id === Number(b.dataset.edit))));
  v.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Remove this post?')) return;
    await api(`/api/events/${b.dataset.del}`, { method: 'DELETE' });
    render();
  });
}

// Edit the nickname and tags you keep for a contact (or yourself). Saved only in your encrypted vault.
function openContactSheet(guid, onSaved) {
  const self = guid === state.me.guid;
  const c = self ? vault.data.self : (vault.data.contacts[guid] || { nickname: '', tags: [] });
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.innerHTML = `
    <form class="stack panel" id="contactForm">
      <h2>${self ? 'Your nickname' : 'Contact'}</h2>
      <p class="note">${self ? 'What you call yourself here. Only you see it.'
        : 'Only you see the nickname and tags you give them. They pick their own name for you.'}</p>
      <input name="nickname" maxlength="60" placeholder="${self ? 'e.g. BigPeePeeMan2000' : 'e.g. Robert from work'}" value="${esc(c.nickname)}">
      ${self ? '' : `
      <div class="tag-editor" data-tags="${esc(JSON.stringify(c.tags || []))}">
        <input type="hidden" name="tags">
        <div class="tag-box"><input class="tag-input" placeholder="Tags, e.g. family, work" aria-label="Add a tag" maxlength="30"></div>
        <div class="tag-suggest"></div>
      </div>`}
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
        if (self) d.self.nickname = nickname;
        else d.contacts[guid] = { ...(d.contacts[guid] || { added: new Date().toISOString() }), nickname, tags };
      });
      close(); toast('Saved. Only you can see this.');
      onSaved?.();
    } catch (err) { toast(err.message); }
  };
  sheet.querySelector('input[name=nickname]').focus();
}

async function viewProfile(v) {
  const idMode = state.config.authMode === '6j0';
  const [ledger, passkeys] = await Promise.all([api('/api/ledger'), idMode ? [] : api('/api/passkeys')]);
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
      <div class="grow"><h2>${esc(vault.data.self.nickname || 'You')}</h2>
        <button type="button" class="link" id="editSelf">${vault.data.self.nickname ? 'Change' : 'Give yourself'} a nickname only you see ✎</button></div>
    </div>
    <div class="stats">
      <div class="stat"><b>${me.hosted}</b><span>events hosted</span></div>
      <div class="stat"><b>${me.attended}</b><span>events attended</span></div>
    </div>

    <div class="section-title">Contacts</div>
    <p class="note">People you've matched with. Names and tags here are yours alone: they're encrypted with your passkey, and nobody else, including the server, can read them.</p>
    ${allTags.length ? `<div class="filter-row" role="group" aria-label="Filter contacts by tag"><span class="label">Tags</span>
      ${allTags.map(t => `<button type="button" class="chip filter ${sel.has(t) ? 'on' : ''}" data-ctag="${esc(t)}" aria-pressed="${sel.has(t)}">${CONTACT_TAGS[t] || '#'} ${esc(t)}</button>`).join('')}
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
    <div class="notice">You sign in with your 6j0.org identity. Add or remove passkeys at
      <a href="${esc(state.config.idOrigin)}/">${esc(idHost())}</a>. Keep at least two, so losing one device doesn't lose your account.</div>` : `
    <div class="section-title">Passkeys</div>
    <div class="notice ${passkeys.length < 2 ? 'warn' : ''}">${passkeys.length < 2
      ? `<b>You only have one passkey.</b> If you lose it, your account is gone for good. Add another one: on your phone (scan the QR code your browser offers), on a security key, or in a password manager like <b>Bitwarden</b>.`
      : `You have ${passkeys.length} passkeys, so losing one device won't lock you out. Keep them in a password manager like <b>Bitwarden</b> for extra safety.`}</div>
    <div class="list">
      ${passkeys.map((p, i) => `<div class="row"><div class="dot tag-none">🔑</div>
        <div class="grow"><div class="title">Passkey ${i + 1}</div><div class="sub">Added ${fmt(p.created_at)} · last used ${fmt(p.last_used_at)}</div></div>
        ${passkeys.length > 1 ? `<button class="btn danger small" data-rmkey="${p.id}" aria-label="Remove passkey">✕</button>` : ''}</div>`).join('')}
    </div>
    <button class="btn ghost" id="addKey">➕ Add another passkey</button>`}

    <button class="btn danger" id="logout" style="margin-top:24px">Sign out</button>`;

  v.querySelector('#editSelf').onclick = () => openContactSheet(me.guid, () => render());
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
      toast(e instanceof PrfUnsupportedError ? "That passkey manager can't create the encryption key. Try Bitwarden, your phone, or an updated browser."
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
if (state.config.authMode === '6j0' && hasIdCallback()) {
  // Back from the 6j0.org identity server with a token and this app's key.
  try {
    const res = await finishIdSignIn(api);
    await enterApp(res.created ? 'profile' : 'discover');
    toast(res.created ? 'Account created! Give yourself a nickname only you can see.' : 'Welcome back!');
  } catch (e) {
    await refreshMe();
    if (state.me && !hasKeys()) state.tab = 'account';
    render(); toast(e.message);
  }
} else {
  await refreshMe();
  if (state.me && await loadKeys(state.me.guid)) {
    try { await vault.load(api); } catch { await clearKeys(); }
  }
  render();
}
