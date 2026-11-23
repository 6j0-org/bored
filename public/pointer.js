// The word for pressing something, to match how this device points: "tap" on a touchscreen with no mouse or
// trackpad, "click" with a mouse or trackpad and no touchscreen, and "tap or click" when it has both (a touchscreen
// laptop) or can't tell. Steps that only ever happen on a phone (Safari's Share button, the ntfy app) just say "tap".
const has = (q) => { try { return matchMedia(q).matches; } catch { return false; } };
const touch = has('(any-pointer: coarse)'), mouse = has('(any-pointer: fine)');
const [base, ing] = touch && !mouse ? ['tap', 'tapping'] : mouse && !touch ? ['click', 'clicking'] : ['tap or click', 'tapping or clicking'];
const cap = (s) => s[0].toUpperCase() + s.slice(1);

export const tap = base, Tap = cap(base), tapping = ing, Tapping = cap(ing);
