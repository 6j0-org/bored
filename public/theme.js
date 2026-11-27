// Theme: automatic (follow the device), light, or dark; and the title board's look (below).
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

// The look: the surfboard with its sand theme (the default), the cartoon board, or the photo board, as
// <html data-board="surf|planed|rough"> (public/boards.css). Kept in this browser, like the theme; the app sets it
// from Profile through window.boredBoard.
(() => {
  const KEY = 'board', ORDER = ['surf', 'planed', 'rough'];
  const saved = () => { try { const b = localStorage.getItem(KEY); return ORDER.includes(b) ? b : 'surf'; } catch { return 'surf'; } };
  const apply = (b) => { document.documentElement.dataset.board = b; };
  const set = (b) => {
    if (!ORDER.includes(b)) return;
    try { if (b === 'surf') localStorage.removeItem(KEY); else localStorage.setItem(KEY, b); } catch {}
    apply(b);
  };
  apply(saved());
  window.boredBoard = { get: saved, set };
  addEventListener('storage', (e) => { if (e.key === KEY) apply(saved()); });
})();
