/* Shot Tracker service worker: keeps the app and saved USGS imagery available offline. */
var APP_CACHE = 'st-app-v2';
var TILE_CACHE = 'st-tiles-usgs-v1';
var TILE_HOST = 'basemap.nationalmap.gov';
var LEAFLET = [
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css'
];

self.addEventListener('install', function(e){
  e.waitUntil(caches.open(APP_CACHE).then(function(c){
    return c.addAll(['./', './index.html']).then(function(){
      return Promise.all(LEAFLET.map(function(u){ return c.add(u).catch(function(){}); }));
    });
  }).then(function(){ return self.skipWaiting(); }));
});

self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){ return k.indexOf('st-app-') === 0 && k !== APP_CACHE; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});

self.addEventListener('fetch', function(e){
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.hostname === TILE_HOST){ e.respondWith(tile(req)); return; }
  if (LEAFLET.indexOf(req.url) >= 0){ e.respondWith(cacheFirst(req)); return; }
  if (url.origin === self.location.origin && (req.mode === 'navigate' || /\/(index\.html)?$/.test(url.pathname))){ e.respondWith(appShell(req, e)); return; }
  // everything else (OpenStreetMap, Esri tiles) goes straight to the network, uncached by us
});

/* Tiles: saved copy first; otherwise fetch and keep a copy (CORS so the cache stores real bytes). */
function tile(req){
  return caches.open(TILE_CACHE).then(function(c){
    return c.match(req.url).then(function(hit){
      if (hit) return hit;
      return fetch(req.url, {mode:'cors'}).then(function(res){
        if (res.ok) c.put(req.url, res.clone());
        return res;
      }).catch(function(){
        return fetch(req).catch(function(){ return new Response('', {status:504, statusText:'Offline'}); });
      });
    });
  });
}

function cacheFirst(req){
  return caches.open(APP_CACHE).then(function(c){
    return c.match(req.url).then(function(hit){
      return hit || fetch(req.url, {mode:'cors'}).then(function(res){ if (res.ok) c.put(req.url, res.clone()); return res; });
    });
  });
}

/* App page: serve the stored copy instantly (no waiting on a weak signal), refresh it in the background.
   A new version therefore shows up on the second open after it is published. */
function appShell(req, e){
  return caches.open(APP_CACHE).then(function(c){
    return c.match('./index.html').then(function(hit){
      var net = fetch(req).then(function(res){
        if (res.ok && res.type === 'basic') c.put('./index.html', res.clone());
        return res;
      }).catch(function(){ return null; });
      if (hit){ e.waitUntil(net); return hit; }
      return net.then(function(res){ return res || new Response('Offline and not yet stored. Open once with a connection.', {status:503}); });
    });
  });
}
