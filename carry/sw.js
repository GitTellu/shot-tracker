/* Carry service worker: keeps the app itself available offline. Map tiles, course lookups and
   wind always go to the network; the scope is ./carry/ only, so Shot Tracker is untouched. */
var CACHE = 'carry-app-v1';
var SHELL = ['./', './index.html', './styles.css', './geo.js', './baseline.js', './sg.js', './app.js', './manifest.json', './icon.svg'];
var CDN = ['https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css'];

self.addEventListener('install', function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){
    return c.addAll(SHELL).then(function(){ return Promise.all(CDN.map(function(u){ return c.add(u).catch(function(){}); })); });
  }).then(function(){ return self.skipWaiting(); }));
});
self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){ return k.indexOf('carry-app-') === 0 && k !== CACHE; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});
/* App files: the stored copy at once, refreshed in the background (a new version shows on the next open).
   Fonts are kept once fetched. Everything else is network only. */
self.addEventListener('fetch', function(e){
  var req = e.request; if (req.method !== 'GET') return;
  var url = new URL(req.url), scope = new URL(self.registration.scope);
  var mine = url.origin === scope.origin && url.pathname.indexOf(scope.pathname) === 0;
  var font = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (!mine && !font && CDN.indexOf(req.url) < 0) return;
  var key = req.mode === 'navigate' ? './index.html' : req.url;
  e.respondWith(caches.open(CACHE).then(function(c){
    return c.match(key).then(function(hit){
      var net = fetch(req).then(function(res){ if (res.ok || (font && res.type === 'opaque')) c.put(key, res.clone()); return res; }).catch(function(){ return null; });
      if (hit){ e.waitUntil(net); return hit; }
      return net.then(function(res){ return res || new Response('Offline and not yet stored. Open Carry once with a connection.', {status:503}); });
    });
  }));
});
