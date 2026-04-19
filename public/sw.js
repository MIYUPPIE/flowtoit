// ── FlowToIt Service Worker ──────────────────────────────────────────────
// Keeps the app alive on Android by maintaining an active service worker
// and handling push-like events to prevent Chrome from killing the page.

const CACHE_NAME = 'flowtoit-v1';
const KEEP_ALIVE_INTERVAL = 20000; // 20 seconds

// Install: cache essential files
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(['/']);
    }).catch(() => {})
  );
});

// Activate: claim all clients immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Fetch handler (pass through, but keep SW active)
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// Message handler — receives keep-alive pings from the main page
self.addEventListener('message', (event) => {
  if (event.data === 'keepalive') {
    // Respond to confirm SW is alive
    event.source?.postMessage('alive');
  }
  if (event.data === 'show-notification') {
    self.registration.showNotification('FlowToIt', {
      body: 'Call in progress...',
      icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">📻</text></svg>',
      tag: 'flowtoit-call',
      requireInteraction: true,
      silent: true,
      actions: [
        { action: 'open', title: 'Open' },
        { action: 'hangup', title: 'Hang Up' }
      ]
    }).catch(() => {});
  }
  if (event.data === 'hide-notification') {
    self.registration.getNotifications({ tag: 'flowtoit-call' }).then(notifications => {
      notifications.forEach(n => n.close());
    });
  }
});

// Notification click — focus or open the app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'hangup') {
    // Tell the page to hang up
    self.clients.matchAll({ type: 'window' }).then(clients => {
      clients.forEach(client => client.postMessage('hangup'));
    });
    return;
  }
  // Focus existing window or open new one
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      if (clients.length > 0) {
        clients[0].focus();
      } else {
        self.clients.openWindow('/');
      }
    })
  );
});
