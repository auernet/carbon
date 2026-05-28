// Carbon service worker — minimal: pass-through fetch, no offline cache yet.
// Future: cache static assets for offline. For now this just satisfies the
// PWA install criteria (HTTPS-equivalent on localhost + manifest + sw).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* network-only for now */ });
