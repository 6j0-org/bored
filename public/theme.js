// Theme: automatic (follow the device), light, or dark.
// Loaded as a plain script in <head>, so the theme is applied as <html data-theme="light|dark"> before the page draws
// (no flash of the wrong theme), on the app and the intro page alike. Automatic is worked out here from the device's
// setting, and follows it when it changes, so the stylesheets only need a [data-theme="dark"] palette. The choice is
// kept in this browser only; the app sets it from Profile through window.boredTheme.
(() => {
  const KEY = 'theme', ORDER = ['auto', 'light', 'dark'];
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const saved = () => { try { const t = localStorage.getItem(KEY); return ORDER.includes(t) ? t : 'auto'; } catch { return 'auto'; } };
  const apply = (t) => { document.documentElement.dataset.theme = t === 'auto' ? (dark.matches ? 'dark' : 'light') : t; };
  const set = (t) => {
    if (!ORDER.includes(t)) return;
    try { if (t === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, t); } catch {}
    apply(t);
  };
  apply(saved());
  window.boredTheme = { get: saved, set };
  // The device went light or dark, or another tab changed the choice.
  dark.addEventListener('change', () => apply(saved()));
  addEventListener('storage', (e) => { if (e.key === KEY) apply(saved()); });
})();
