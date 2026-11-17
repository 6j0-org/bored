// The sample deck on the introduction page: the demo's example posts (public/examples.js), one card at a time.
// Drag a card (mouse or touch), tap "Nah" or "I'm in", or use the arrow keys. It loops forever and saves nothing.
import { EXAMPLES, exampleWhen } from './examples.js';
import { whenLabel, localToday } from './when.js';
import { costLabel } from './cost.js';

const deck = document.querySelector('.deck');
const FLING = 90; // px of drag that counts as a swipe
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
let index = 0;

function cardHtml(e) {
  const free = !e.cost;
  const tags = [...e.tags, ...(free ? ['free'] : [])].map(t => `<span class="chip">${esc(t)}</span>`).join('');
  const people = e.max == null ? 'Any number of people' : e.max === 1 ? 'Just 1 person' : `Up to ${e.max} people`;
  return `
    <div class="tags">${tags}</div>
    <h3>${esc(e.title)}</h3>
    <p class="meta">${esc(whenLabel(exampleWhen(e.when), { today: localToday() }))}</p>
    <p class="meta">${esc(e.place)}</p>
    <p class="meta">${esc(people)}${free ? '' : ` · ${esc(costLabel(e.cost, e.currency || 'USD'))}`}</p>
    <div class="swipe"><button type="button" class="no">Nah</button><button type="button" class="yes">I'm in</button></div>
    <span class="stamp yes" aria-hidden="true">I'm in!</span><span class="stamp no" aria-hidden="true">Nah</span>`;
}

function show() {
  deck.innerHTML = `<div class="card back2"></div><div class="card back1"></div>
    <div class="card front" tabindex="0" aria-roledescription="example post"
      aria-label="Example post ${index % EXAMPLES.length + 1} of ${EXAMPLES.length}. Swipe, or use the left and right arrow keys.">
      ${cardHtml(EXAMPLES[index % EXAMPLES.length])}</div>`;
  const card = deck.querySelector('.front');
  card.querySelector('.no').onclick = () => swipe(card, -1);
  card.querySelector('.yes').onclick = () => swipe(card, 1);
  card.onkeydown = (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); swipe(card, -1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); swipe(card, 1); }
  };
  drag(card);
  return card;
}

// Show a stamp in proportion to how far the card has moved: right "I'm in!", left "Nah".
function stamps(card, dx) {
  card.querySelector('.stamp.yes').style.opacity = Math.max(0, Math.min(1, dx / FLING));
  card.querySelector('.stamp.no').style.opacity = Math.max(0, Math.min(1, -dx / FLING));
}

function swipe(card, dir) {
  if (card.dataset.gone) return;
  card.dataset.gone = '1';
  stamps(card, dir * FLING);
  const refocus = card.contains(document.activeElement);
  const next = () => { index++; const fresh = show(); if (refocus) fresh.focus(); };
  if (reduceMotion) return void setTimeout(next, 250);
  card.style.transition = 'transform .35s ease-in, opacity .35s ease-in';
  card.style.transform = `translate(${dir * 140}%, -4%) rotate(${dir * 24}deg)`;
  card.style.opacity = '0';
  card.addEventListener('transitionend', next, { once: true });
}

function drag(card) {
  let start = null, dx = 0;
  card.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    start = { x: e.clientX, y: e.clientY }; dx = 0;
    card.setPointerCapture(e.pointerId);
    card.classList.add('dragging');
  });
  card.addEventListener('pointermove', (e) => {
    if (!start) return;
    dx = e.clientX - start.x;
    card.style.transform = `translate(${dx}px, ${(e.clientY - start.y) * .2}px) rotate(${dx / 14 - 1.5}deg)`;
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

if (deck) { deck.removeAttribute('aria-hidden'); show(); }
