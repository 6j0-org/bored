// Theme: automatic (follow the device), light, or dark.
// Loaded as a plain script in <head>, so a saved choice is applied as <html data-theme="light|dark"> before the page
// draws (no flash of the wrong theme), on the app and the intro page alike. The choice is kept in this browser only;
// the app sets it from Profile through window.boredTheme.
(() => {
  const KEY = 'theme', ORDER = ['auto', 'light', 'dark'];
  const saved = () => { try { const t = localStorage.getItem(KEY); return ORDER.includes(t) ? t : 'auto'; } catch { return 'auto'; } };
  const apply = (t) => {
    if (t === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
  };
  const set = (t) => {
    if (!ORDER.includes(t)) return;
    try { if (t === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, t); } catch {}
    apply(t);
  };
  apply(saved());
  window.boredTheme = { get: saved, set };
  // Another tab changed it.
  addEventListener('storage', (e) => { if (e.key === KEY) apply(saved()); });
})();
