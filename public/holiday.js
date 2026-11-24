// Holiday season, November 1 through December 31 (by the device's own date): marks the page with
// <html data-season="holiday">, which hangs lights on the section headings' branches (style.css), and lets snow fall
// behind the page on a canvas. No snow for people who ask their device for reduced motion.
// Loaded as a plain script in <head>, like theme.js, so the lights are there from the first draw. For trying it out
// any time of year, localStorage "holiday" set to "on" (or "off") overrides the date.
(() => {
  const now = new Date();
  let force = null;
  try { force = localStorage.getItem('holiday'); } catch {}
  const on = force === 'on' || (force !== 'off' && now.getMonth() >= 10); // 10 = November, 11 = December
  if (!on) return;
  document.documentElement.dataset.season = 'holiday';
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const start = () => {
    const canvas = document.createElement('canvas');
    canvas.id = 'snow'; canvas.setAttribute('aria-hidden', 'true');
    // The About and Privacy pages don't load style.css, so the canvas carries its own placement.
    canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:-1';
    document.body.prepend(canvas);
    const ctx = canvas.getContext('2d');
    let w = 0, h = 0, flakes = [], color = '#fff';

    // White on dark pages; a soft blue-gray on light ones, where white wouldn't show.
    const pickColor = () => {
      const [r, g, b] = (getComputedStyle(document.body).backgroundColor.match(/\d+/g) || [255, 255, 255]).map(Number);
      color = 0.299 * r + 0.587 * g + 0.114 * b < 128 ? '255,255,255' : '120,145,175';
    };
    const flake = (anywhere) => ({
      x: Math.random() * w, y: anywhere ? Math.random() * h : -5,
      r: 1 + Math.random() * 2.2, speed: 0.3 + Math.random() * 0.7,
      drift: Math.random() * Math.PI * 2, sway: 0.3 + Math.random() * 0.6, alpha: 0.35 + Math.random() * 0.45,
    });
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = innerWidth; h = innerHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Sparse on phones, a bit more on big screens.
      const want = Math.round(Math.min(90, Math.max(30, (w * h) / 14000)));
      while (flakes.length < want) flakes.push(flake(true));
      flakes.length = want;
    };
    resize(); pickColor();
    addEventListener('resize', resize);
    // Right away when the theme changes (Profile, or the device going dark: theme.js updates data-theme for both),
    // after its styles apply.
    const recolor = () => requestAnimationFrame(pickColor);
    new MutationObserver(recolor).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    let last = performance.now();
    const tick = (t) => {
      const dt = Math.min((t - last) / 16.7, 3); last = t; // in 60 fps frames, capped after the tab was hidden
      ctx.clearRect(0, 0, w, h);
      for (const f of flakes) {
        f.y += f.speed * dt; f.drift += 0.01 * dt; f.x += Math.sin(f.drift) * f.sway * 0.5 * dt;
        if (f.y > h + 5) Object.assign(f, flake(false));
        if (f.x < -5) f.x = w + 5; else if (f.x > w + 5) f.x = -5;
        ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${color},${f.alpha})`; ctx.fill();
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  if (document.body) start(); else addEventListener('DOMContentLoaded', start);
})();
