// The sample deck on the introduction page: the demo's example posts (public/examples.js), drawn exactly like a
// Discover card in the app (eventCard in public/app.js). Drag a card (mouse or touch), tap Pass or I'm in, or use
// the arrow keys. It loops forever and saves nothing.
import { EXAMPLES, exampleWhen } from './examples.js';
import { whenLabel, localToday } from './when.js';
import { costLabel } from './cost.js';
import { locationHtml } from './location.js';
import { toSvg as identicon } from './vendor/jdenticon.js';

const deck = document.querySelector('.deck');
const FLING = 100; // px of drag that counts as a swipe, as in the app
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const attendeesLabel = (max) => (max == null ? 'No limit' : max === 1 ? '1 person' : `Up to ${max} people`);
// A fresh shuffle on every visit (Fisher-Yates), so the deck doesn't always open on the same post.
const DECK = [...EXAMPLES];
for (let i = DECK.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [DECK[i], DECK[j]] = [DECK[j], DECK[i]]; }
let index = 0;

function cardHtml(e) {
  const fact = (label, value) => `<dt>${label}</dt><dd>${value}</dd>`;
  return `
    <div class="stamp yes" aria-hidden="true">I'm in</div><div class="stamp no" aria-hidden="true">Pass</div>
    <div class="body">
      <h2>${esc(e.title)}</h2>
      <dl class="facts">
        ${e.when ? fact('When', `<span class="when">${esc(whenLabel(exampleWhen(e.when), { today: localToday() }))}</span>`) : ''}
        ${e.location || e.place ? fact('Where', locationHtml(e.location, '', { name: e.place })) : ''}
        ${fact('Cost', esc(costLabel(e.cost || 0, e.currency || 'USD')))}
        ${fact('Max attendees', attendeesLabel(e.max))}
        ${e.tags.length ? fact('Tags', e.tags.map(x => '#' + esc(x)).join(' ')) : ''}
      </dl>
      <div class="details">${esc(e.details)}</div>
      <div class="who"><div class="avatar icon">${identicon(e.host, 100)}</div></div>
    </div>`;
}

let current;
function show() {
  const e = DECK[index % DECK.length];
  deck.innerHTML = `<div class="card back2"></div><div class="card back1"></div>
    <div class="card front" tabindex="0" aria-roledescription="example post"
      aria-label="Example post ${index % DECK.length + 1} of ${DECK.length}: ${esc(e.title)}. Swipe, or use the left and right arrow keys.">
      ${cardHtml(e)}</div>`;
  current = deck.querySelector('.front');
  current.onkeydown = (ev) => {
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); swipe(current, -1); }
    if (ev.key === 'ArrowRight') { ev.preventDefault(); swipe(current, 1); }
  };
  drag(current);
  return current;
}

// Show a stamp in proportion to how far the card has moved: right "I'm in", left "Pass".
function stamps(card, dx) {
  card.querySelector('.stamp.yes').style.opacity = Math.max(0, Math.min(1, dx / FLING));
  card.querySelector('.stamp.no').style.opacity = Math.max(0, Math.min(1, -dx / FLING));
}

function swipe(card, dir) {
  if (!card || card.dataset.gone) return;
  card.dataset.gone = '1';
  stamps(card, dir * FLING);
  const refocus = card.contains(document.activeElement);
  const next = () => { index++; const fresh = show(); if (refocus) fresh.focus(); };
  if (reduceMotion) return void setTimeout(next, 250);
  card.style.transition = 'transform .35s ease-in, opacity .35s ease-in';
  card.style.transform = `translate(${dir * 140}%, 40px) rotate(${dir * 30}deg)`;
  card.style.opacity = '0';
  card.addEventListener('transitionend', next, { once: true });
}

function drag(card) {
  let start = null, dx = 0;
  card.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('a, button')) return;
    start = { x: e.clientX, y: e.clientY }; dx = 0;
    card.setPointerCapture(e.pointerId);
    card.classList.add('dragging');
  });
  card.addEventListener('pointermove', (e) => {
    if (!start) return;
    dx = e.clientX - start.x;
    card.style.transform = `translate(${dx}px, ${(e.clientY - start.y) * .2}px) rotate(${dx / 18 - 1.5}deg)`;
    stamps(card, dx);
  });
  const end = () => {
    if (!start) return;
    start = null; card.classList.remove('dragging');
    if (Math.abs(dx) > FLING) return swipe(card, Math.sign(dx));
    card.style.transform = ''; stamps(card, 0);
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', end);
}

if (deck) {
  deck.removeAttribute('aria-hidden');
  show();
  const actions = document.querySelector('.deck-actions');
  if (actions) {
    actions.hidden = false;
    actions.querySelector('.round.no').onclick = () => swipe(current, -1);
    actions.querySelector('.round.yes').onclick = () => swipe(current, 1);
  }
}
