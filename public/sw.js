'use strict';
// Keeps the app's own files available offline, so saved QR codes can be shown without a
// connection to the server. Only these static files are cached: never messages, notes,
// codes or uploads (those come from /api/ and are left alone).
const CACHE = 'flowchat-shell-v1';
const SHELL = ['/', '/app.js', '/style.css', '/icon.svg', '/manifest.webmanifest', '/vendor/qrcode.js'];
const EXTRA = ['/vendor/jsQR.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname === '/index.html' ? '/' : url.pathname;
  if (!SHELL.includes(path) && !EXTRA.includes(path)) return;
  // Network first, so updates arrive at once; the saved copy only when the server is unreachable.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(path, copy));
        }
        return res;
      })
      .catch(() => caches.match(path).then((hit) => hit || Response.error())),
  );
});
