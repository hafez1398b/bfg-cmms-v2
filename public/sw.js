'use strict';
/* BFG Service Worker — PWA offline shell + queue helper (Requirement #19, #2) */
const CACHE = 'bfg-v4-20260913';
const SHELL = ['/', '/index.html', '/manifest.json', '/logo.jpg', '/css/bfg-v2.css'];

self.addEventListener('install', (e)=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL).catch(()=>{})));
  self.skipWaiting();
});
self.addEventListener('activate', (e)=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e)=>{
  const url = new URL(e.request.url);
  // Never cache API or socket.io
  if(url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;
  // For navigation, network-first with cache fallback
  if(e.request.mode==='navigate'){
    e.respondWith(fetch(e.request).catch(()=>caches.match('/index.html')));
    return;
  }
  // Stale-while-revalidate for assets
  e.respondWith(caches.match(e.request).then(cached=>{
    const fetched = fetch(e.request).then(res=>{
      if(res.ok) caches.open(CACHE).then(c=>c.put(e.request, res.clone()));
      return res;
    }).catch(()=>cached);
    return cached || fetched;
  }));
});
self.addEventListener('message', (e)=>{
  if(e.data==='skipWaiting') self.skipWaiting();
});
