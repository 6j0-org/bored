// Service worker: shows push notifications, and opens the app on the right screen when one is tapped.
// It caches nothing, so the app always loads fresh from the server.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// The server sends { title, body, tag, open } (see notify() in server.js).
self.addEventListener('push', (e) => {
  let msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil(self.registration.showNotification(msg.title || 'Bored', {
    body: msg.body || '',
    tag: msg.tag || undefined,
    renotify: Boolean(msg.tag),
    data: { open: msg.open || '' },
  }));
});

// Tell an open window where to go and focus it, or open a new one there. The message goes first: on iPhone, focus()
// can fail, and that mustn't stop the window from going to the right place.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const open = e.notification.data?.open || '';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find(w => { const u = new URL(w.url); return u.origin === self.location.origin && u.pathname === '/'; });
    if (win) { win.postMessage({ type: 'open', open }); await win.focus().catch(() => {}); return; }
    await self.clients.openWindow(open ? `/?open=${encodeURIComponent(open)}` : '/');
  })());
});
