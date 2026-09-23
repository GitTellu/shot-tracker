/* Shot Tracker service worker: keeps the app and saved satellite imagery available offline. */
var APP_CACHE = 'st-app-v37';
var USGS_CACHE = 'st-tiles-usgs-v1';
var MAPBOX_CACHE = 'st-tiles-mapbox-v1';
var LOCAL_CACHE = 'st-tiles-local-v1';
// origins the app already routes itself, or that are online-only and must never be served stale
var NOT_LOCAL = ['tile.openstreetmap.org', 'ibasemaps-api.arcgis.com', 'api.mapbox.com', 'cdnjs.cloudflare.com'];
var MAPBOX_TTL_MS = 30 * 24 * 3600 * 1000; // Mapbox terms: on-device cache limited to 30 days
var STATIC = [
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://api.mapbox.com/mapbox-gl-js/v3.9.4/mapbox-gl.css'
];

self.addEventListener('install', function(e){
  e.waitUntil(caches.open(APP_CACHE).then(function(c){
    return c.addAll(['./', './index.html']).then(function(){
      // everything else is best-effort, so a missing icon can never block the app from installing offline
      return Promise.all(STATIC.concat(['./manifest.json', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './icon-180.png']).map(function(u){ return c.add(u).catch(function(){}); }));
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
  // Carry (./carry/) is a separate app with its own worker: never serve Shot Tracker's page for it,
  // and never let its page overwrite the stored copy of index.html
  if (url.origin === self.location.origin && /\/carry(\/|$)/.test(url.pathname)) return;
  if (url.pathname.indexOf('/USGSImageryOnly/MapServer/tile/') >= 0){ e.respondWith(usgsTile(req)); return; }
  if (url.pathname.indexOf('/v4/mapbox.satellite/') >= 0){ e.respondWith(mapboxTile(req, url)); return; }
  if (url.origin !== self.location.origin && STATIC.indexOf(req.url) < 0 && NOT_LOCAL.indexOf(url.hostname) < 0){ e.respondWith(localTile(req)); return; }
  if (STATIC.indexOf(req.url) >= 0){ e.respondWith(cacheFirst(req)); return; }
  if (url.origin === self.location.origin && (req.mode === 'navigate' || /\/(index\.html)?$/.test(url.pathname))){ e.respondWith(appShell(req, e)); return; }
  if (url.origin === self.location.origin && /\/(manifest\.json|icon-[\w-]+\.png)$/.test(url.pathname)){ e.respondWith(cacheFirst(req)); return; }
  // everything else (OpenStreetMap, Esri tiles) goes straight to the network, not stored by this app
});

/* USGS (public domain): saved copy first; otherwise fetch and keep a copy. */
function usgsTile(req){
  return caches.open(USGS_CACHE).then(function(c){
    return c.match(req.url).then(function(hit){
      if (hit) return hit;
      return fetch(req.url, {mode:'cors'}).then(function(res){
        if (res.ok) c.put(req.url, res.clone());
        return res;
      }).catch(function(){
        return fetch(req).catch(function(){ return offline(); });
      });
    });
  });
}

/* Mapbox: only tiles you saved on purpose, and only while under 30 days old. Nothing else is stored. */
function mapboxTile(req, url){
  var key = url.origin + url.pathname; // cache key without the access token
  if (req.cache === 'reload' || req.cache === 'no-store') return fetch(req); // the app is re-saving: always go to the network
  return caches.open(MAPBOX_CACHE).then(function(c){
    return c.match(key).then(function(hit){
      if (hit){
        var saved = Number(hit.headers.get('X-Saved-At') || 0);
        if (Date.now() - saved < MAPBOX_TTL_MS) return hit;
        c.delete(key);
      }
      return fetch(req).catch(function(){ return offline(); });
    });
  });
}

/* County and regional imagery the app saved for a course. The cache is its own index:
   whatever is in it is served, anything else goes straight to the network, so the worker
   never has to be told which servers the phone has been pointed at. Agency services do not
   impose the 30-day rule Mapbox does, so nothing here is aged out. */
function localTile(req){
  // a probe or a re-save asks for the network on purpose, and must not be answered from the cache
  if (req.cache === 'reload' || req.cache === 'no-store') return fetch(req).catch(function(){ return offline(); });
  return caches.open(LOCAL_CACHE).then(function(c){
    return c.match(req.url).then(function(hit){
      return hit || fetch(req).catch(function(){ return offline(); });
    });
  });
}

function offline(){ return new Response('', {status:504, statusText:'Offline'}); }

function cacheFirst(req){
  return caches.open(APP_CACHE).then(function(c){
    return c.match(req.url).then(function(hit){
      if (hit) return hit;
      return fetch(req.url, {mode:'cors'}).then(function(res){ if (res.ok) c.put(req.url, res.clone()); return res; })
        .catch(function(){ return fetch(req); });
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
