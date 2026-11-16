// Event locations are stored as "lat,lon", e.g. "32.719649,-117.220272".
// This module parses them, links them to the viewer's maps app, and provides a small OpenStreetMap picker.
// Posts can also carry a friendly name for the spot ("Ocean Beach Pier"), shown instead of the coordinates. The
// picker suggests one from OpenStreetMap's Nominatim, asked through our own server (/api/places/reverse).
// The picker uses no library. Its tiles come from tile.openstreetmap.org, and only while it is open: that is the
// only third-party request the browser makes, so the rest of the app never talks to OSM directly.

// A location pin (the teardrop map marker), drawn in the current text color. Used for the Where field's map button.
export const PIN_SVG = '<svg class="pin-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21.5s-7-6.1-7-11.6a7 7 0 0 1 14 0c0 5.5-7 11.6-7 11.6z"/>' +
  '<circle cx="12" cy="9.8" r="2.6"/></svg>';
// The same pin, filled, marking the spot on the picker's map. Its tip is at the bottom center.
const MAP_PIN_SVG = '<svg viewBox="0 0 24 24" width="36" height="36" aria-hidden="true"><path fill="#e11d48" stroke="#fff" stroke-width="1.5" ' +
  'd="M12 22.5s-7.5-6.4-7.5-12.3a7.5 7.5 0 0 1 15 0c0 5.9-7.5 12.3-7.5 12.3z"/><circle cx="12" cy="10" r="2.8" fill="#fff"/></svg>';

const COORDS = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

// "lat,lon" → [lat, lon], or null if it isn't valid coordinates.
export function parseLatLon(s) {
  const m = COORDS.exec(String(s ?? ''));
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lat, lon] : null;
}

const fmt = (lat, lon) => `${lat.toFixed(6)},${lon.toFixed(6)}`;

// A link that opens in the viewer's default maps app where the platform has a way to say "default":
// Apple devices hand maps.apple.com to Maps, and Android offers geo: URIs to the default (or a chooser).
// Elsewhere there is no reliable handler for geo:, so open the spot on openstreetmap.org.
export function mapLink(lat, lon) {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return { href: `geo:${lat},${lon}?q=${lat},${lon}`, external: false };
  if (/iPhone|iPad|iPod|Macintosh/.test(ua)) return { href: `https://maps.apple.com/?ll=${lat},${lon}&q=${lat},${lon}`, external: true };
  return { href: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`, external: true };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// HTML for a location: its name (or, without one, the coordinates), linked to the map when there are coordinates.
// cls is the link/span's class. icon: false leaves out the pin, e.g. where a "Where" label already says what it is.
export function locationHtml(loc, cls = '', { icon = true, name = '' } = {}) {
  if (!loc && !name) return '';
  const pin = icon ? '📍 ' : '';
  const ll = parseLatLon(loc);
  if (!ll) return `<span class="${cls}">${pin}${esc(name || loc)}</span>`;
  const { href, external } = mapLink(...ll);
  return `<a class="${cls} map-link" href="${esc(href)}" ${external ? 'target="_blank" rel="noopener noreferrer"' : ''}
    title="Open in your maps app">${pin}${esc(name || fmt(...ll))}</a>`;
}

// A suggested name for a spot, or '' if none could be found.
async function lookUpName([lat, lon]) {
  try {
    const r = await fetch(`/api/places/reverse?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}`, { credentials: 'same-origin' });
    return r.ok ? (await r.json()).name || '' : '';
  } catch { return ''; }
}

// ---------- picker ----------

const TILE = 256, MIN_Z = 2, MAX_Z = 19;
const tileUrl = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;

// Web Mercator: lat/lon ↔ "world pixels" at zoom z (the whole world is TILE * 2^z pixels square).
function project(lat, lon, z) {
  const size = TILE * 2 ** z, r = Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180;
  return [(lon + 180) / 360 * size, (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * size];
}
function unproject(x, y, z) {
  const size = TILE * 2 ** z, n = Math.PI - 2 * Math.PI * y / size;
  const lon = ((x / size * 360 - 180) % 360 + 540) % 360 - 180; // wrap around the antimeridian
  return [180 / Math.PI * Math.atan(Math.sinh(n)), lon];
}

// Opens a full-screen map. Resolves to "lat,lon" for the chosen spot, '' if the person cleared the location,
// or undefined if they cancelled.
// Options: title; note (the hint under the map); nameField: false hides the place name box and never looks one up;
// clearLabel for the button that resolves to ''.
const POST_NOTE = `Tap the map to drop the pin. Anyone who can see your post can see this spot, so a nearby
  landmark may be better than your front door.`;
export function pickLocation(initial = '', initialName = '', { title = 'Where?', note = POST_NOTE, nameField = true, clearLabel = 'No location' } = {}) {
  return new Promise((resolve) => {
    let pin = parseLatLon(initial);
    let z = pin ? 16 : 3;
    let [cx, cy] = project(...(pin || [20, 0]), z); // world pixel at the center of the view

    const sheet = document.createElement('div');
    sheet.className = 'sheet map-sheet';
    sheet.innerHTML = `
      <div class="panel stack">
        <h2>${esc(title)}</h2>
        <div class="map" tabindex="0" aria-label="Map. Drag to move, tap to place the pin, plus and minus keys to zoom.">
          <div class="tiles"></div>
          <div class="pin" hidden>${MAP_PIN_SVG}</div>
          <div class="map-zoom">
            <button type="button" class="btn ghost small" data-zoom="1" aria-label="Zoom in">+</button>
            <button type="button" class="btn ghost small" data-zoom="-1" aria-label="Zoom out">−</button>
          </div>
          <div class="map-credit">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors</div>
        </div>
        <div class="map-status"><span class="coords"></span>
          <button type="button" class="btn ghost small" data-here>Use my location</button></div>
        <label ${nameField ? '' : 'hidden'}>Place name
          <input class="place-name" maxlength="100" placeholder="e.g. Ocean Beach Pier" value="${esc(initialName)}"></label>
        <p class="note">${esc(note)}</p>
        <div class="two">
          <button type="button" class="btn ghost" data-cancel>Cancel</button>
          <button type="button" class="btn" data-done>Use this spot</button>
        </div>
        <button type="button" class="btn ghost small" data-clear>${esc(clearLabel)}</button>
      </div>`;
    document.body.appendChild(sheet);
    const map = sheet.querySelector('.map'), tiles = sheet.querySelector('.tiles'), pinEl = sheet.querySelector('.pin');
    const coordsEl = sheet.querySelector('.coords'), doneBtn = sheet.querySelector('[data-done]');
    const nameEl = sheet.querySelector('.place-name');
    // Each time the pin moves, suggest a name, unless the host has typed their own since the last suggestion.
    let typed = Boolean(initialName), lookup = 0;
    nameEl.addEventListener('input', () => { typed = Boolean(nameEl.value.trim()); });
    const pinMoved = async () => {
      if (typed || !nameField) return;
      const n = ++lookup;
      nameEl.placeholder = 'Looking up a name…';
      const name = await lookUpName(pin);
      if (n !== lookup || typed) return;
      nameEl.value = name;
      nameEl.placeholder = name ? 'e.g. Ocean Beach Pier' : 'No name found. Type one, e.g. Ocean Beach Pier';
    };
    const imgs = new Map(); // "z/x/y" → <img>

    function draw() {
      const w = map.clientWidth, h = map.clientHeight, n = 2 ** z;
      const left = cx - w / 2, top = cy - h / 2;
      const seen = new Set();
      for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + h) / TILE); ty++) {
        if (ty < 0 || ty >= n) continue;
        for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + w) / TILE); tx++) {
          const key = `${z}/${tx}/${ty}`;
          seen.add(key);
          let img = imgs.get(key);
          if (!img) {
            img = document.createElement('img');
            img.alt = ''; img.draggable = false;
            // The app sends no Referer anywhere, but OSM's tile policy asks for one; send just our origin.
            img.referrerPolicy = 'strict-origin';
            img.src = tileUrl(z, ((tx % n) + n) % n, ty);
            imgs.set(key, img); tiles.appendChild(img);
          }
          img.style.transform = `translate(${tx * TILE - left}px, ${ty * TILE - top}px)`;
        }
      }
      for (const [key, img] of imgs) if (!seen.has(key)) { img.remove(); imgs.delete(key); }
      pinEl.hidden = !pin;
      if (pin) {
        const [px, py] = project(...pin, z);
        pinEl.style.transform = `translate(${px - left}px, ${py - top}px)`;
      }
      coordsEl.textContent = pin ? 'Pin dropped' : 'No spot picked yet';
      doneBtn.disabled = !pin;
    }

    // Zoom by dz steps, keeping the world point under (mx, my) (view pixels; default: center) in place.
    function zoom(dz, mx = map.clientWidth / 2, my = map.clientHeight / 2) {
      const nz = Math.max(MIN_Z, Math.min(MAX_Z, z + dz));
      if (nz === z) return;
      const k = 2 ** (nz - z), ox = mx - map.clientWidth / 2, oy = my - map.clientHeight / 2;
      cx = (cx + ox) * k - ox; cy = (cy + oy) * k - oy; z = nz;
      draw();
    }
    const viewPoint = (e) => { const r = map.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

    // Pointers: one drags (or taps to place the pin), two pinch-zoom in whole steps.
    const pointers = new Map();
    let moved = 0, pinchBase = 0;
    const spread = () => { const [a, b] = [...pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
    map.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, a')) return;
      map.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) moved = 0;
      if (pointers.size === 2) pinchBase = spread();
    });
    map.addEventListener('pointermove', (e) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      if (pointers.size === 1) { cx -= dx; cy -= dy; draw(); return; }
      if (pointers.size === 2) {
        const d = spread(), [a, b] = [...pointers.values()], r = map.getBoundingClientRect();
        const mid = [(a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top];
        if (d > pinchBase * 1.5) { zoom(1, ...mid); pinchBase = d; }
        else if (d < pinchBase / 1.5) { zoom(-1, ...mid); pinchBase = d; }
      }
    });
    const up = (e) => {
      if (!pointers.has(e.pointerId)) return;
      const tap = pointers.size === 1 && moved < 8 && e.type === 'pointerup';
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchBase = 0;
      if (tap) {
        const [mx, my] = viewPoint(e);
        pin = unproject(cx - map.clientWidth / 2 + mx, cy - map.clientHeight / 2 + my, z);
        draw(); pinMoved();
      }
      if (pointers.size) moved = Infinity; // lifting one finger of a pinch is not a tap
    };
    map.addEventListener('pointerup', up);
    map.addEventListener('pointercancel', up);
    let wheel = 0;
    map.addEventListener('wheel', (e) => {
      e.preventDefault();
      wheel += e.deltaY;
      if (Math.abs(wheel) >= 100) { zoom(wheel < 0 ? 1 : -1, ...viewPoint(e)); wheel = 0; }
    }, { passive: false });
    map.addEventListener('dblclick', (e) => { e.preventDefault(); zoom(1, ...viewPoint(e)); });
    map.addEventListener('keydown', (e) => {
      const step = 80, keys = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (keys[e.key]) { cx += keys[e.key][0]; cy += keys[e.key][1]; draw(); }
      else if (e.key === '+' || e.key === '=') zoom(1);
      else if (e.key === '-') zoom(-1);
      else if (e.key === 'Enter' || e.key === ' ') { pin = unproject(cx, cy, z); draw(); pinMoved(); } // pin the center
      else return;
      e.preventDefault();
    });
    sheet.querySelectorAll('[data-zoom]').forEach(b => b.onclick = () => zoom(Number(b.dataset.zoom)));

    sheet.querySelector('[data-here]').onclick = (e) => {
      if (!navigator.geolocation) return (coordsEl.textContent = "This browser can't share your location");
      e.target.disabled = true;
      navigator.geolocation.getCurrentPosition(({ coords }) => {
        e.target.disabled = false;
        pin = [coords.latitude, coords.longitude];
        z = Math.max(z, 16);
        [cx, cy] = project(...pin, z);
        draw(); pinMoved();
      }, () => { e.target.disabled = false; coordsEl.textContent = "Couldn't get your location"; }, { enableHighAccuracy: true, timeout: 15000 });
    };

    const finish = (value) => {
      sheet.remove(); removeEventListener('resize', draw); document.removeEventListener('keydown', onEsc, true);
      resolve(value);
    };
    const onEsc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); finish(undefined); } };
    document.addEventListener('keydown', onEsc, true);
    addEventListener('resize', draw);
    sheet.querySelector('[data-cancel]').onclick = () => finish(undefined);
    sheet.querySelector('[data-clear]').onclick = () => finish('');
    doneBtn.onclick = () => finish({ location: fmt(...pin), name: nameEl.value.trim() });
    sheet.onclick = (e) => { if (e.target === sheet) finish(undefined); };
    draw();
    map.focus();
  });
}

// Wires up the Where field: a visible place name, the hidden coordinates, and the map button that sets both.
// The name can also be typed without picking a spot.
export function mountLocationField(form) {
  const name = form.querySelector('input[name=location_name]'), coords = form.querySelector('input[name=location]');
  const btn = form.querySelector('.loc-pick');
  if (!name || !coords || !btn) return;
  // In person / Online / Both: an online-only post has no place, so the Place box hides for it.
  const place = form.querySelector('.loc-place');
  form.querySelectorAll('input[name=online]').forEach(r => r.addEventListener('change', () => {
    if (place) place.hidden = r.value === '1' && r.checked;
  }));
  // Clearing the name clears the spot too, so an empty box means no location.
  name.addEventListener('input', () => { if (!name.value.trim()) coords.value = ''; });
  btn.onclick = async () => {
    const v = await pickLocation(coords.value, name.value);
    if (v !== undefined) {
      coords.value = v ? v.location : '';
      name.value = v ? v.name : '';
    }
    name.focus();
  };
}
