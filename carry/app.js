/* Carry: a shot tracker built around strokes gained and a practice plan made from your weak spots.
   Screens follow the Claude Design prototype (Carry Prototype.dc.html); everything shown is
   measured (GPS, OpenStreetMap course data, Open-Meteo wind) or computed from your own rounds. */
(function(){
'use strict';
var G = window.Geo, SG = window.SG;
var $ = function(s){ return document.querySelector(s); };
if (!window.L){ $('#screen').innerHTML = '<div class="pad" style="padding-top:40px"><p class="sub">The map library did not load. Check your connection and reload.</p></div>'; return; }

/* ---------- constants ---------- */
// Starting carries are the prototype's examples, there to be overwritten with your own.
var DEFAULT_BAG = [['D', 275], ['3W', 242], ['4i', 205], ['5i', 192], ['6i', 180], ['7i', 168], ['8i', 157], ['9i', 146], ['PW', 136], ['50', 122], ['54', 104], ['58', 86]];
var LIES = ['Tee', 'Fairway', 'Rough', 'Bunker', 'Fringe', 'Other'];
var FULL_LIES = {Tee:1, Fairway:1, Rough:1};
var OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
var USGS_TILE = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}';
var CAPTURE_MS = 3000;         // fixes after the tap are averaged for this long
var WEAK_ACC_M = 20;           // above this the mark is kept but flagged
var AVG_MIN_ROUNDS = 3, AVG_MIN_SHOTS = 5;   // when a club's GPS average replaces its stock number
var DAY = 86400000;
var CAT_NAME = {ott:'Off the tee', app:'Approach', arg:'Around green', putt:'Putting'};

/* ---------- helpers ---------- */
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]; }); }
function r0(x){ return Math.round(x); }
function sgn(v, dp){ return (v > 0.0001 ? '+' : v < -0.0001 ? '−' : '') + Math.abs(v).toFixed(dp == null ? 1 : dp); }
function sgColor(v){ return v == null ? 'var(--mut)' : v > 0.0001 ? 'var(--pos)' : v < -0.0001 ? 'var(--neg)' : 'var(--mut)'; }
function toParTxt(v){ return v == null ? '—' : v === 0 ? 'E' : v > 0 ? '+' + v : '−' + Math.abs(v); }
function isoDate(t){ var d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function median(a){ if (!a.length) return null; var s = a.slice().sort(function(x, y){ return x - y; }), m = s.length; return m % 2 ? s[(m - 1) / 2] : (s[m / 2 - 1] + s[m / 2]) / 2; }
function mean(a){ return a.length ? a.reduce(function(t, x){ return t + x; }, 0) / a.length : null; }
function sd(a){ if (a.length < 2) return null; var m = mean(a); return Math.sqrt(a.reduce(function(t, x){ return t + (x - m) * (x - m); }, 0) / (a.length - 1)); }
function pct(a, p){ var s = a.slice().sort(function(x, y){ return x - y; }), i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); }
var toastT = null;
function toast(msg, ms){ var el = $('#toast'); el.textContent = msg; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(function(){ el.hidden = true; }, ms || 2800); }

/* ---------- storage: IndexedDB, falling back to localStorage ---------- */
var store = (function(){
  var db = null, mode = 'idb', LS = 'carry.v1';
  function req(r){ return new Promise(function(res, rej){ r.onsuccess = function(){ res(r.result); }; r.onerror = function(){ rej(r.error); }; }); }
  return {
    open:function(){
      if (!('indexedDB' in window)){ mode = 'ls'; return Promise.resolve(); }
      return new Promise(function(res){
        var q; try { q = indexedDB.open('carry', 1); } catch(e){ mode = 'ls'; return res(); }
        q.onupgradeneeded = function(){ q.result.createObjectStore('kv'); };
        q.onsuccess = function(){ db = q.result; res(); };
        q.onerror = q.onblocked = function(){ mode = 'ls'; res(); };
      });
    },
    get:function(){
      if (mode === 'ls'){ try { return Promise.resolve(JSON.parse(localStorage.getItem(LS))); } catch(e){ return Promise.resolve(null); } }
      return req(db.transaction('kv', 'readonly').objectStore('kv').get('state'));
    },
    put:function(v){
      if (mode === 'ls'){ try { localStorage.setItem(LS, JSON.stringify(v)); return Promise.resolve(); } catch(e){ return Promise.reject(e); } }
      return new Promise(function(res, rej){
        var t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, 'state');
        t.oncomplete = function(){ res(); }; t.onerror = t.onabort = function(){ rej(t.error); };
      });
    }
  };
})();

function defaults(){
  return {v:1, bag:DEFAULT_BAG.map(function(b){ return {name:b[0], stock:b[1]}; }), courses:[], rounds:[], activeId:null, onboarded:false,
    practice:{days:[0, 2, 4], log:[]}, friends:[], me:{id:uid(), name:''}};
}
var S = defaults(), booted = false;
function save(){ if (booted) store.put(S).catch(function(){ toast('Could not save. Phone storage for this site may be full.', 5000); }); }

/* ---------- UI state (not saved) ---------- */
var U = {screen:'onb1', club:null, lie:null, target:null, aim:null, missed:0, firstPutt:null, dClub:null,
  ticks:null, found:null, finding:null, imported:null, holesPick:'front', viewId:null, pendingFriend:null, bagDraft:null, bagFrom:null};

/* ---------- lookups ---------- */
function course(id){ return S.courses.filter(function(c){ return c.id === id; })[0] || null; }
function courseOf(r){ return r ? course(r.courseId) : null; }
function active(){ return S.rounds.filter(function(r){ return r.id === S.activeId; })[0] || null; }
function viewed(){ return (U.viewId && S.rounds.filter(function(r){ return r.id === U.viewId; })[0]) || active(); }
function curHole(){ var r = active(); return r ? r.holes[r.cur] : null; }
function geoOf(r, h){ var c = courseOf(r); return (c && h && c.holes[h.n]) || null; }
function finishedRounds(){ return S.rounds.filter(function(r){ return r.holes.some(function(h){ return h.done; }); }).sort(function(a, b){ return a.started - b.started; }); }

/* ---------- GPS ---------- */
var fix = null, gpsOn = false, cap = null;
function gpsPill(){
  var el = $('#gps');
  if (!gpsOn){ el.className = ''; el.textContent = 'GPS off'; return; }
  if (!fix){ el.className = ''; el.textContent = 'GPS searching'; return; }
  var age = Date.now() - fix.t;
  if (age > 8000){ el.className = 'poor'; el.textContent = 'GPS ' + r0(age / 1000) + ' s old'; return; }
  el.className = fix.acc <= 10 ? 'good' : fix.acc > WEAK_ACC_M ? 'poor' : '';
  el.textContent = 'GPS ±' + r0(G.yd(fix.acc)) + ' yd';
}
setInterval(gpsPill, 1000);
function onPos(p){
  var c = p.coords;
  fix = {lat:c.latitude, lng:c.longitude, acc:c.accuracy, t:Date.now()};
  if (cap) cap.samples.push(fix);
  gpsPill(); maybeWind(); live();
}
function onErr(e){
  var el = $('#gps'); el.className = 'poor';
  el.textContent = e.code === 1 ? 'GPS denied' : 'No GPS';
  if (e.code === 1) toast('Location permission denied. Allow location for this site in your browser settings.', 6000);
}
function startGPS(){
  if (gpsOn) return;
  if (!window.isSecureContext){ toast('GPS only works over https://', 5000); return; }
  if (!navigator.geolocation){ $('#gps').textContent = 'No GPS'; return; }
  gpsOn = true; gpsPill();
  navigator.geolocation.watchPosition(onPos, onErr, {enableHighAccuracy:true, maximumAge:0, timeout:30000});
}
function requestFresh(){ try { navigator.geolocation.getCurrentPosition(onPos, function(){}, {enableHighAccuracy:true, maximumAge:0, timeout:15000}); } catch(e){} }
/* Fixes are averaged weighted by 1/accuracy^2; the accuracy kept is the median of the samples,
   since GPS errors are correlated over seconds and averaging does not shrink them (as in Shot Tracker). */
function combine(samples){
  var good = samples.filter(function(f){ return f.acc <= 50; });
  if (good.length) samples = good;
  if (!samples.length) return null;
  var sw = 0, la = 0, lo = 0;
  samples.forEach(function(f){ var w = 1 / Math.pow(Math.max(f.acc, 1), 2); sw += w; la += f.lat * w; lo += f.lng * w; });
  return {lat:la / sw, lng:lo / sw, acc:+median(samples.map(function(f){ return f.acc; })).toFixed(1), n:samples.length};
}
/* Only fixes that arrive after the tap count. No fresh fix: keep waiting, and offer the last one, flagged. */
function capture(){
  startGPS();
  return new Promise(function(resolve){
    cap = {start:Date.now(), samples:[]}; requestFresh();
    var ov = $('#capture'), go = $('#capGo'), done = false, lastAsk = Date.now();
    function finish(v){ if (done) return; done = true; clearInterval(iv); ov.hidden = true; cap = null; resolve(v); }
    function tick(){
      var el = Date.now() - cap.start, n = cap.samples.length;
      ov.hidden = el < 700;
      if (el < CAPTURE_MS){
        $('#capTitle').textContent = 'Marking your ball'; $('#capBig').textContent = Math.ceil((CAPTURE_MS - el) / 1000);
        $('#capInfo').textContent = n + ' fresh fix' + (n === 1 ? '' : 'es') + ' so far. Hold still.'; go.hidden = true; return;
      }
      if (n){ finish(combine(cap.samples)); return; }
      if (Date.now() - lastAsk > 10000){ lastAsk = Date.now(); requestFresh(); }
      $('#capTitle').textContent = 'Still getting your position'; $('#capBig').textContent = '…';
      if (fix){
        var age = r0((Date.now() - fix.t) / 1000);
        $('#capInfo').textContent = 'Newest fix is ' + age + ' s old (±' + r0(G.yd(fix.acc)) + ' yd). Waiting for a fresh one.';
        go.hidden = false; go.textContent = 'Use ' + age + ' s old fix';
      } else { $('#capInfo').textContent = 'No GPS fix yet. Open sky helps.'; go.hidden = true; }
    }
    go.onclick = function(){ if (fix) finish({lat:fix.lat, lng:fix.lng, acc:fix.acc, n:0, stale:true}); };
    $('#capCancel').onclick = function(){ finish(null); };
    var iv = setInterval(tick, 200); tick();
  });
}

/* ---------- wind (Open-Meteo, free, no key) ---------- */
var wind = null, windAt = 0, windPos = null;
function maybeWind(){
  if (!fix || !navigator.onLine) return;
  if (windPos && Date.now() - windAt < 10 * 60000 && G.distM(windPos, fix) < 3000) return;
  windAt = Date.now(); windPos = {lat:fix.lat, lng:fix.lng};
  fetch('https://api.open-meteo.com/v1/forecast?latitude=' + fix.lat.toFixed(3) + '&longitude=' + fix.lng.toFixed(3) + '&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=mph')
    .then(function(r){ return r.json(); })
    .then(function(j){ if (j && j.current && j.current.wind_speed_10m != null){ wind = {mph:j.current.wind_speed_10m, from:j.current.wind_direction_10m}; live(); } })
    .catch(function(){ windAt = 0; });
}
/* wind relative to the line from -> to. Direction is where the wind blows from. */
function windTxt(from, to){
  if (!wind || !from || !to) return null;
  var mph = r0(wind.mph); if (mph < 2) return 'calm';
  var rel = ((wind.from - G.bearingDeg(from, to)) % 360 + 540) % 360 - 180, a = Math.abs(rel);
  var dir = a <= 45 ? 'into' : a >= 135 ? 'helping' : rel > 0 ? 'off the right' : 'off the left';
  return 'wind ' + mph + ' mph ' + dir;
}

/* ---------- clubs: stock carries, replaced by your own GPS averages ---------- */
/* every measured full swing: from where it was hit to where the next shot (or the first putt) was marked */
function shotSamples(sinceMs){
  var out = [];
  S.rounds.forEach(function(r){
    if (sinceMs && r.started < sinceMs) return;
    var c = courseOf(r);
    r.holes.forEach(function(h){
      var geo = c && c.holes[h.n];
      h.shots.forEach(function(s, i){
        var end = i < h.shots.length - 1 ? h.shots[i + 1] : h.onGreen || null;
        if (!end || !s.club) return;
        out.push({r:r.id, club:s.club, lie:s.lie, s:s, end:end, dist:G.distYd(s, end), geo:geo, i:i, par:h.par});
      });
    });
  });
  return out;
}
var avgCache = null;
function clubAverages(){
  if (avgCache) return avgCache;
  var by = {};
  shotSamples().forEach(function(x){ if (FULL_LIES[x.lie]) (by[x.club] = by[x.club] || []).push(x); });
  avgCache = {};
  Object.keys(by).forEach(function(k){
    var a = by[k], rounds = {}; a.forEach(function(x){ rounds[x.r] = 1; });
    if (a.length >= AVG_MIN_SHOTS && Object.keys(rounds).length >= AVG_MIN_ROUNDS)
      avgCache[k] = {yd:median(a.map(function(x){ return x.dist; })), sd:sd(a.map(function(x){ return x.dist; })), n:a.length};
  });
  return avgCache;
}
function carryOf(name){
  var a = clubAverages()[name]; if (a) return r0(a.yd);
  var b = S.bag.filter(function(x){ return x.name === name; })[0];
  return b ? b.stock : null;
}
function suggest(d, tee, par){
  if (!S.bag.length) return null;
  if (tee && par > 3) return S.bag[0].name;
  if (d == null) return null;
  var best = S.bag[0];
  S.bag.forEach(function(b){ if (Math.abs(carryOf(b.name) - d) < Math.abs(carryOf(best.name) - d)) best = b; });
  return best.name;
}

/* ---------- course from OpenStreetMap ---------- */
function overpass(q){
  var i = 0, why = [];
  function attempt(){
    return fetch(OVERPASS[i], {method:'POST', body:'data=' + encodeURIComponent(q), headers:{'Content-Type':'application/x-www-form-urlencoded'}})
      .then(function(res){ if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .catch(function(err){
        why.push(OVERPASS[i].split('/')[2] + ': ' + ((err && err.message) || err));
        if (++i < OVERPASS.length) return attempt();
        throw new Error('OpenStreetMap did not answer. ' + why.join('; '));
      });
  }
  return attempt();
}
function findNearby(){
  if (!fix){ startGPS(); U.finding = 'Waiting for your position…'; render(); var tries = 0;
    var iv = setInterval(function(){ if (fix || ++tries > 30){ clearInterval(iv); if (fix) findNearby(); else { U.finding = 'No GPS fix. Search by name instead.'; render(); } } }, 1000); return; }
  U.finding = 'Looking for golf courses within five miles…'; U.found = null; render();
  var around = '(around:8000,' + fix.lat.toFixed(6) + ',' + fix.lng.toFixed(6) + ')';
  overpass('[out:json][timeout:25];(way["leisure"="golf_course"]' + around + ';relation["leisure"="golf_course"]' + around + ';);out tags bb;').then(function(j){
    U.found = (j.elements || []).map(function(e){
      var b = e.bounds; if (!b) return null;
      var c = {lat:(b.minlat + b.maxlat) / 2, lng:(b.minlon + b.maxlon) / 2};
      return {type:e.type, id:e.id, name:(e.tags && e.tags.name) || 'Unnamed golf course', bounds:b, d:G.distYd(fix, c)};
    }).filter(Boolean).sort(function(a, b){ return a.d - b.d; });
    U.finding = U.found.length ? null : 'No golf courses are mapped within five miles. Try searching by name.';
    render();
  }).catch(function(e){ U.finding = e.message; render(); });
}
function searchCourses(q){
  q = (q || '').trim(); if (!q) return;
  U.finding = 'Searching OpenStreetMap…'; U.found = null; render();
  fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=20&q=' + encodeURIComponent(q))
    .then(function(r){ return r.json(); })
    .then(function(a){
      U.found = (a || []).filter(function(x){ return x.category === 'leisure' && x.type === 'golf_course' && x.osm_type !== 'node'; }).map(function(x){
        var bb = x.boundingbox.map(Number);
        return {type:x.osm_type, id:+x.osm_id, name:x.name || x.display_name.split(',')[0], where:x.display_name.split(',').slice(1, 3).join(',').trim(),
          bounds:{minlat:bb[0], maxlat:bb[1], minlon:bb[2], maxlon:bb[3]}, d:fix ? G.distYd(fix, {lat:+x.lat, lng:+x.lon}) : null};
      });
      U.finding = U.found.length ? null : 'No golf course by that name in OpenStreetMap.';
      render();
    }).catch(function(){ U.finding = 'Search did not answer. Check your connection.'; render(); });
}
function importCourse(f){
  var b = f.bounds, pad = 0.0015;   // about 150 m round the outline, for tees and greens drawn just outside it
  var bb = [b.minlat - pad, b.minlon - pad * 1.3, b.maxlat + pad, b.maxlon + pad * 1.3].map(function(v){ return v.toFixed(6); }).join(',');
  U.finding = 'Reading the holes, greens and hazards of ' + f.name + '…'; U.found = null; render();
  overpass('[out:json][timeout:90];' + f.type + '(' + f.id + ');out geom;(' +
    'way["golf"~"^(hole|green|tee|bunker|fairway|water_hazard|lateral_water_hazard)$"](' + bb + ');node["golf"="tee"](' + bb + ');way["natural"="water"](' + bb + '););out geom;')
    .then(function(j){
      var conv = G.osmConvert(j.elements || [], {type:f.type, id:f.id});
      if (!conv.counts.holes){ U.finding = f.name + ' is in OpenStreetMap, but none of its holes are mapped yet, so Carry cannot measure it.'; render(); return; }
      var c = S.courses.filter(function(x){ return x.osm && x.osm.type === f.type && x.osm.id === f.id; })[0];
      if (!c){ c = {id:uid()}; S.courses.push(c); }
      Object.assign(c, {name:conv.name || f.name, osm:{type:f.type, id:f.id}, t:Date.now(), holes:conv.holes, probs:conv.probs, counts:conv.counts});
      save(); U.finding = null; U.imported = c.id; U.courseId = c.id; render();
    }).catch(function(e){ U.finding = e.message; render(); });
}
function courseNums(c){ return c && c.counts ? c.counts.nums : []; }

/* ---------- rounds ---------- */
function holesFor(c, pick){
  var nums = courseNums(c), top = nums.length ? Math.max.apply(null, nums) : 18, set = [];
  var from = pick === 'back' ? 10 : 1, to = pick === 'front' ? 9 : Math.max(top, 9);
  if (pick === 'back') to = Math.min(18, Math.max(top, 18));
  for (var n = from; n <= to; n++) set.push(n);
  return set;
}
function startRound(){
  var c = course(U.courseId || (S.courses[0] && S.courses[0].id)); if (!c) return;
  var nums = holesFor(c, U.holesPick);
  var r = {id:uid(), courseId:c.id, course:c.name, started:Date.now(), ended:null, pick:U.holesPick, cur:0,
    holes:nums.map(function(n){ return {n:n, par:(c.holes[n] && c.holes[n].par) || null, shots:[], putts:0, firstPutt:null, onGreen:null, done:false}; })};
  S.rounds.push(r); S.activeId = r.id; S.onboarded = true; U.viewId = null;
  resetShot(); save(); startGPS(); go('hole');
}
function pickLabel(p){ return p === 'front' ? 'Front 9' : p === 'back' ? 'Back 9' : '18 holes'; }
function resetShot(){ U.club = null; U.lie = null; U.target = null; U.aim = null; }
/* the lie under your feet, read from the mapped course; your own pick always wins */
function autoLie(h, geo){
  if (!h.shots.length) return 'Tee';
  if (fix && geo){
    if (geo.hz.some(function(z){ return z.k === 'bunker' && G.ptInRing(fix, z.p); })) return 'Bunker';
    if (G.onFairway(fix, geo)) return 'Fairway';
    if (geo.fw && geo.fw.length) return 'Rough';
  }
  return 'Fairway';
}
function markBall(){
  var r = active(), h = curHole(); if (!h) return;
  var geo = geoOf(r, h), gp = geo && G.greenPt(geo);
  var d = fix && gp ? G.distYd(fix, gp) : null;
  var club = U.club || suggest(d, !h.shots.length, h.par), lie = U.lie || autoLie(h, geo);
  capture().then(function(pos){
    if (!pos) return;
    var s = {lat:+pos.lat.toFixed(7), lng:+pos.lng.toFixed(7), acc:pos.acc, club:club, lie:lie, t:Date.now()};
    if (U.aim) s.aim = U.aim;
    if (pos.stale) s.stale = true;
    h.shots.push(s); avgCache = null; resetShot(); save(); render();
    if (pos.acc > WEAK_ACC_M) toast('Weak GPS: marked at ±' + r0(G.yd(pos.acc)) + ' yd.');
  });
}
function goPutt(){
  var r = active(), h = curHole(), geo = geoOf(r, h), gp = geo && G.greenPt(geo);
  // where the ball sits on the green is where you stand now; it ends the last shot and sets the first putt
  h.onGreen = fix ? {lat:+fix.lat.toFixed(7), lng:+fix.lng.toFixed(7), acc:fix.acc} : null;
  U.missed = 0;
  U.firstPutt = h.onGreen && gp ? Math.max(1, r0(G.distYd(h.onGreen, gp) * 3)) : null;
  U.measured = U.firstPutt != null;
  if (U.firstPutt == null) U.firstPutt = 20;
  save(); go('putt');
}
function holed(putts){
  var h = curHole(); h.putts = putts; h.firstPutt = putts ? U.firstPutt : null; h.done = true;
  avgCache = null; save(); go('card');
}
function nextHole(){ var r = active(); if (r.cur < r.holes.length - 1){ r.cur++; resetShot(); save(); go('hole'); } }
function endRound(){ var r = active(); if (!r) return; r.ended = Date.now(); U.viewId = r.id; S.activeId = null; save(); go('summary'); }

/* ---------- round numbers ---------- */
function factsOf(r){ return SG.roundFacts(r, courseOf(r)); }
function toPar(rf){ var t = 0, any = false; rf.holes.forEach(function(x){ if (x.h.done && x.h.par){ t += x.f.score - x.h.par; any = true; } }); return any ? t : (rf.t.n ? null : 0); }
/* per-18-hole strokes gained, so nines and eighteens can be averaged together */
function per18(rounds){
  var out = [];
  rounds.forEach(function(r){
    var rf = factsOf(r); if (!rf.t.sgKnown || !rf.t.n) return;
    var k = 18 / rf.t.n;
    out.push({r:r, tot:rf.t.sg * k, ott:rf.t.by.ott * k, app:rf.t.by.app * k, arg:rf.t.by.arg * k, putt:rf.t.by.putt * k, t:rf.t});
  });
  return out;
}
function avgOf(list, k){ return list.length ? mean(list.map(function(x){ return x[k]; })) : null; }
function recentRounds(n){ var a = finishedRounds(); return a.slice(Math.max(0, a.length - n)); }
function worstBand(bs){ var b = bs.filter(function(x){ return x.n; }).sort(function(a, c){ return a.sg / a.n - c.sg / c.n; })[0]; return b || null; }
/* The weakest part of the game over the last 10 rounds, and the distance band inside it that leaks most. */
function focus(){
  var list = per18(recentRounds(10)); if (!list.length) return null;
  // a part of the game with no shots in these rounds is not a weakness, just unmeasured
  var cats = ['ott', 'app', 'arg', 'putt'].filter(function(k){ return list.some(function(x){ return x.t.cnt[k] > 0; }); })
    .map(function(k){ return {k:k, v:avgOf(list, k)}; }).sort(function(a, b){ return a.v - b.v; });
  if (!cats.length) return null;
  var f = cats[0], bs = SG.bands(list.map(function(x){ return x.r; }), courseOf), band = null;
  if (f.k === 'app') band = worstBand(bs.app); else if (f.k === 'putt') band = worstBand(bs.putt);
  return {k:f.k, v:f.v, next:cats[1], band:band ? band.b : null, n:list.length};
}
function focusTitle(f){
  if (!f) return 'Build your baseline';
  if (f.k === 'app') return 'Fix ' + (f.band ? f.band[2] : '') + ' approaches';
  if (f.k === 'putt') return 'Fix ' + (f.band ? f.band[2] + ' ' : '') + 'putting';
  if (f.k === 'ott') return 'Tighten up off the tee';
  return 'Sharpen the short game';
}

/* ---------- practice ---------- */
/* Drill content is Carry's own, picked by the weakest area; the goals are targets to test against. */
function drillsFor(f){
  if (f && f.k === 'app'){
    var b = f.band ? f.band : [100, 150];
    var lo = Math.max(b[0], 50), hi = Math.min(b[1], 230), mid = r0((lo + hi) / 2);
    return [{m:"10'", t:'Distance ladder · ' + lo + '/' + mid + '/' + hi, b:'30 balls'}, {m:"20'", t:'Stock flight to targets, ' + lo + '–' + hi + ' yd', b:'40 balls'}, {m:"15'", t:'Test: 10 balls to a green-sized target', b:'goal 6/10'}];
  }
  if (f && f.k === 'putt'){
    var p = f.band ? f.band : [5, 15];
    return [{m:"10'", t:'Circle drill · ' + Math.max(3, p[0]) + ' ft', b:'8 balls'}, {m:"20'", t:'Ladder ' + [p[0], r0((p[0] + Math.min(p[1], 60)) / 2), Math.min(p[1], 60)].filter(function(x){ return x > 0; }).join('/') + ' ft', b:'30 balls'}, {m:"15'", t:'Test: 10 putts from ' + r0((p[0] + Math.min(p[1], 40)) / 2) + ' ft', b:'goal 5/10'}];
  }
  if (f && f.k === 'ott') return [{m:"10'", t:'Fairway gate · 30 yd wide', b:'14 balls'}, {m:"20'", t:'Stock shape to alternating targets', b:'30 balls'}, {m:"15'", t:'Test: 10 drives through the gate', b:'goal 7/10'}];
  return [{m:"15'", t:'Up-and-down from 9 spots', b:'27 balls'}, {m:"15'", t:'Landing-spot chips to a towel', b:'30 balls'}, {m:"15'", t:'Test: 10 chips inside 6 ft', b:'goal 6/10'}];
}
function weekStart(t){ var d = new Date(t); d.setHours(0, 0, 0, 0); var wd = (d.getDay() + 6) % 7; return d.getTime() - wd * DAY; }
function loggedOn(date){ return S.practice.log.filter(function(l){ return l.date === date; })[0] || null; }

/* ---------- friends: shared by link, no server ---------- */
function b64e(o){ return btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64d(s){ s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return JSON.parse(decodeURIComponent(escape(atob(s)))); }
function myCard(){
  var list = per18(recentRounds(20));
  return {v:1, id:S.me.id, n:S.me.name || 'Golfer', r:list.length, t:Date.now(), lb:SG.label(),
    sg:list.length ? {tot:avgOf(list, 'tot'), ott:avgOf(list, 'ott'), app:avgOf(list, 'app'), arg:avgOf(list, 'arg'), putt:avgOf(list, 'putt')} : null};
}
function readHash(){
  var m = /#f=([A-Za-z0-9_-]+)/.exec(location.hash); if (!m) return;
  try { var f = b64d(m[1]); if (f && f.v === 1 && f.id && f.id !== S.me.id) U.pendingFriend = f; } catch(e){ toast('That friend link could not be read.'); }
  history.replaceState(null, '', location.pathname + location.search);
}

/* ---------- navigation ---------- */
var ROUND_SCREENS = ['hole', 'map', 'putt', 'card', 'summary', 'newround', 'course', 'bag'];
function go(sc){ U.screen = sc; if (sc !== 'map') U.target = null; render(); var el = $('#screen'); if (el) el.scrollTop = 0; }
function roundHome(){ return active() ? 'hole' : 'newround'; }
function onboarding(){ return !S.onboarded && /^onb/.test(U.screen); }

/* ---------- render ---------- */
function render(){
  if (!booted) return;
  var sc = U.screen;
  $('#mapWrap').hidden = sc !== 'map';
  $('#screen').hidden = sc === 'map';
  if (sc === 'map') drawMap(true); else $('#screen').innerHTML = (VIEWS[sc] || VIEWS.newround)();
  var nav = $('#nav'); nav.hidden = onboarding();
  if (!nav.hidden){
    var tabs = [['Round', ROUND_SCREENS, roundHome()], ['Stats', ['stats', 'disp'], 'stats'], ['Practice', ['practice'], 'practice'], ['Friends', ['friends'], 'friends']];
    nav.innerHTML = tabs.map(function(t){ return '<button data-act="go" data-arg="' + t[2] + '" class="' + (t[1].indexOf(sc) >= 0 ? 'on' : '') + '"><span></span>' + t[0] + '</button>'; }).join('');
  }
}
/* GPS moves the numbers: redraw only the screens that show them */
function live(){
  if (!booted) return;
  if (U.screen === 'map') drawMap(false);
  else if (['hole', 'onb3'].indexOf(U.screen) >= 0 && !document.activeElement.matches('input')) render();
}

function stepHead(n, title, sub){
  var bars = [1, 2, 3].map(function(i){ return '<span style="flex:1;height:4px;border-radius:2px;background:' + (i <= n ? 'var(--ink)' : 'var(--line)') + ';"></span>'; }).join('');
  return '<div class="pad" style="display:flex;flex-direction:column;gap:6px;"><div style="display:flex;gap:6px;">' + bars + '</div>' +
    '<span class="lbl" style="margin-top:12px;">Step ' + n + ' of 3</span><h3 class="h">' + title + '</h3><p class="sub">' + sub + '</p></div>';
}
function statBox(k, v, s, sColor){ return '<div class="stat"><div class="k">' + k + '</div><div class="v">' + v + '</div>' + (s != null ? '<div class="s"' + (sColor ? ' style="color:' + sColor + '"' : '') + '>' + s + '</div>' : '') + '</div>'; }

var VIEWS = {};

/* Step 1 (and Round > Add a course): find the course in OpenStreetMap */
VIEWS.onb1 = VIEWS.course = function(){
  var onb = U.screen === 'onb1', imp = U.imported && course(U.imported);
  var head = onb ? stepHead(1, 'Where do you play?', 'Carry reads every hole, green and hazard from OpenStreetMap, so yardages work on your first visit.')
    : '<div class="pad" style="display:flex;justify-content:space-between;align-items:baseline;"><h3 class="h">Add a course</h3><button class="link" data-act="go" data-arg="newround">‹ Round</button></div>';
  var body = '';
  if (imp){
    var n = imp.counts;
    body = '<div class="card m" style="padding:16px;display:flex;flex-direction:column;gap:10px;"><span style="font-size:16px;font-weight:800;">' + esc(imp.name) + '</span>' +
      '<div class="grid3">' + statBox('HOLES', n.holes) + statBox('GREENS', n.greens) + statBox('PARS', n.pars + '/' + n.holes) + '</div>' +
      (imp.probs.length ? '<p class="sub" style="color:var(--neg);">' + imp.probs.map(esc).join('<br>') + '</p>' : '<p class="sub">Every hole has a green to measure to.</p>') + '</div>' +
      '<p class="sub m">Course data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors.</p>' +
      '<div class="foot"><button class="btn pri" data-act="' + (onb ? 'onbNext' : 'courseDone') + '">' + (onb ? 'Continue' : 'Use this course') + '</button></div>';
    return '<div class="scr">' + head + body + '</div>';
  }
  var saved = S.courses.length && onb ? '<div class="m"><span class="lbl">Saved</span></div><div class="card m rows" style="overflow:hidden;">' + S.courses.map(function(c){
    return '<button data-act="pickSaved" data-arg="' + c.id + '" style="display:flex;justify-content:space-between;width:100%;padding:13px 16px;text-align:left;"><span style="font-weight:700;">' + esc(c.name) + '</span><span class="mut">›</span></button>';
  }).join('') + '</div>' : '';
  body = '<div class="m" style="display:flex;flex-direction:column;gap:10px;">' +
    '<button class="btn pri" data-act="findNearby">Find courses near me</button>' +
    '<div style="display:grid;grid-template-columns:1fr auto;gap:8px;"><input class="in" id="q" placeholder="Or search by name" enterkeyhint="search"><button class="btn sec" style="height:40px;width:auto;padding:0 14px;" data-act="search">Search</button></div></div>' +
    (U.finding ? '<p class="sub m">' + esc(U.finding) + '</p>' : '') +
    (U.found && U.found.length ? '<div class="card m rows" style="overflow:hidden;">' + U.found.map(function(f, i){
      return '<button data-act="importCourse" data-arg="' + i + '" style="display:grid;grid-template-columns:1fr auto;gap:8px;width:100%;padding:12px 16px;text-align:left;align-items:center;"><div><div style="font-weight:700;font-size:14px;">' + esc(f.name) + '</div><div class="sub" style="font-size:12px;">' +
        esc([f.where, f.d != null ? (f.d < 1760 ? r0(f.d) + ' yd' : (f.d / 1760).toFixed(1) + ' mi') + ' away' : ''].filter(Boolean).join(' · ')) + '</div></div><span class="mut">›</span></button>';
    }).join('') + '</div>' : '') + saved;
  return '<div class="scr">' + head + body + '<div style="height:20px"></div></div>';
};

/* Step 2 (and Round > Bag): what's in the bag */
VIEWS.onb2 = VIEWS.bag = function(){
  var onb = U.screen === 'onb2', avgs = clubAverages();
  if (!U.bagDraft) U.bagDraft = S.bag.map(function(b){ return {name:b.name, stock:b.stock}; });
  var head = onb ? stepHead(2, 'What\'s in the bag?', 'Enter stock carries. Carry replaces them with your real averages after ' + AVG_MIN_ROUNDS + ' rounds.')
    : '<div class="pad" style="display:flex;flex-direction:column;gap:4px;"><div style="display:flex;justify-content:space-between;align-items:baseline;"><h3 class="h">Your bag</h3><button class="link" data-act="go" data-arg="newround">‹ Round</button></div><p class="sub">Stock numbers are used until a club has ' + AVG_MIN_SHOTS + ' measured full shots over ' + AVG_MIN_ROUNDS + ' rounds.</p></div>';
  var rows = U.bagDraft.map(function(b, i){
    var a = avgs[b.name];
    return '<div style="display:grid;grid-template-columns:64px 1fr 70px;gap:8px;align-items:center;padding:7px 14px;">' +
      '<input class="in" style="font-weight:800;padding:0 8px;" data-in="bagName" data-arg="' + i + '" value="' + esc(b.name) + '" aria-label="Club">' +
      '<span style="font-size:13px;color:var(--mut);">' + (a ? 'GPS avg ' + r0(a.yd) + ' · ' + a.n + ' shots' : 'Stock carry') + '</span>' +
      '<input class="in numin" inputmode="numeric" data-in="bagYd" data-arg="' + i + '" value="' + esc(b.stock) + '" aria-label="Carry in yards"></div>';
  }).join('');
  return '<div class="scr">' + head +
    '<div class="card m rows" style="overflow:hidden;">' + rows + '</div>' +
    '<div class="m" style="display:flex;justify-content:space-between;"><button class="link" data-act="addClub">+ Add club</button><span class="sub">Clear a name to remove it.</span></div>' +
    '<div class="foot"><button class="btn pri" data-act="saveBag">' + (onb ? 'Continue' : 'Save bag') + '</button></div></div>';
};

/* Step 3: GPS, then tee off */
VIEWS.onb3 = function(){
  var c = course(U.courseId);
  var status = !gpsOn ? 'Location is off' : !fix ? 'Searching for satellites…' : '±' + r0(G.yd(fix.acc)) + ' yd';
  var near = c && fix ? nearestHoleTxt(c) : null;
  return '<div class="scr">' + stepHead(3, 'Turn on GPS', 'Carry marks each ball where you stand and measures to the green from there. Nothing leaves your phone.') +
    '<div class="card m" style="padding:20px;display:flex;flex-direction:column;gap:4px;"><span style="font-size:12px;font-weight:600;color:var(--mut);">GPS accuracy</span>' +
    '<span class="num" style="font-size:48px;font-weight:800;letter-spacing:-0.03em;line-height:1.05;">' + status + '</span>' +
    (near ? '<span class="sub">' + near + '</span>' : '') + '</div>' +
    (!gpsOn ? '<div class="m"><button class="btn sec" data-act="gpsOn">Allow location</button></div>' : '') +
    holesPicker(c) +
    '<div class="foot"><button class="btn pri" data-act="startRound"' + (c ? '' : ' disabled') + '>Start round · ' + esc(c ? c.name : '') + ', hole ' + (c ? holesFor(c, U.holesPick)[0] : 1) + '</button></div></div>';
};
function nearestHoleTxt(c){
  var best = null;
  Object.keys(c.holes).forEach(function(k){ var t = G.teePt(c.holes[k]); if (!t) return; var d = G.distYd(fix, t); if (!best || d < best.d) best = {n:k, d:d}; });
  if (!best) return null;
  return best.d < 1760 ? 'Hole ' + best.n + ' tee is ' + r0(best.d) + ' yd away.' : 'You are ' + (best.d / 1760).toFixed(1) + ' mi from the course.';
}
function holesPicker(c){
  if (!c) return '';
  var nums = courseNums(c), top = nums.length ? Math.max.apply(null, nums) : 18;
  var opts = top > 9 ? ['front', 'back', 'all'] : ['front'];
  if (opts.indexOf(U.holesPick) < 0) U.holesPick = 'front';
  return '<div class="m" style="display:flex;flex-direction:column;gap:8px;"><span class="lbl">Holes</span><div class="wrap">' + opts.map(function(p){
    return '<button class="pill' + (U.holesPick === p ? ' on' : '') + '" data-act="holesPick" data-arg="' + p + '">' + pickLabel(p) + '</button>';
  }).join('') + '</div></div>';
}

/* Round tab with no round going: start one, or look back */
VIEWS.newround = function(){
  if (!U.courseId && S.courses.length) U.courseId = S.courses[S.courses.length - 1].id;
  var c = course(U.courseId);
  var past = S.rounds.filter(function(r){ return r.id !== S.activeId && r.holes.some(function(h){ return h.done; }); }).slice().reverse().slice(0, 8);
  return '<div class="scr"><div class="pad" style="display:flex;justify-content:space-between;align-items:baseline;"><h3 class="h">New round</h3><button class="link" data-act="go" data-arg="bag">Bag ›</button></div>' +
    '<div class="card m rows" style="overflow:hidden;">' + S.courses.map(function(x){
      var on = x.id === U.courseId;
      return '<button data-act="pickCourse" data-arg="' + x.id + '" style="display:flex;justify-content:space-between;align-items:center;width:100%;padding:13px 16px;text-align:left;background:' + (on ? 'var(--acc-08)' : '#fff') + ';"><span style="font-weight:700;">' + esc(x.name) + '</span><span class="mut" style="font-size:12px;">' + x.counts.holes + ' holes</span></button>';
    }).join('') + '<button data-act="go" data-arg="course" style="width:100%;padding:13px 16px;text-align:left;font-weight:700;color:var(--acc);">+ Add a course</button></div>' +
    holesPicker(c) +
    (past.length ? '<div class="m"><span class="lbl">Past rounds</span></div><div class="card m rows num" style="overflow:hidden;">' + past.map(function(r){
      var rf = factsOf(r);
      return '<button data-act="viewRound" data-arg="' + r.id + '" style="display:grid;grid-template-columns:1fr auto auto;gap:12px;width:100%;padding:12px 16px;text-align:left;align-items:center;"><div><div style="font-weight:700;font-size:14px;">' + esc(r.course) + '</div><div class="sub" style="font-size:12px;">' +
        new Date(r.started).toLocaleDateString(undefined, {month:'short', day:'numeric'}) + ' · ' + pickLabel(r.pick) + '</div></div><span style="font-weight:800;">' + rf.t.score + '</span><span style="font-weight:800;color:' + sgColor(rf.t.sgKnown ? rf.t.sg : null) + ';">' + (rf.t.sgKnown ? sgn(rf.t.sg) : '') + '</span></button>';
    }).join('') + '</div>' : '') +
    '<div class="foot" style="display:flex;flex-direction:column;gap:10px;"><button class="btn pri" data-act="startRound"' + (c ? '' : ' disabled') + '>' + (c ? 'Start round · ' + esc(c.name) + ', hole ' + holesFor(c, U.holesPick)[0] : 'Add a course to start') + '</button>' +
    (S.rounds.length ? '<button class="link" data-act="backup" style="align-self:center;">Back up my data</button>' : '') + '</div></div>';
};

/* Hole view (1a) */
function holeLabel(h, geo){
  var len = geo ? G.holeLenYd(geo) : null;
  return 'Hole ' + h.n + ' · Par ' + (h.par || '?') + (len ? ' · ' + r0(len) + ' yd' : '');
}
VIEWS.hole = function(){
  var r = active(); if (!r) return VIEWS.newround();
  var h = curHole(), geo = geoOf(r, h), rf = factsOf(r), idx = h.shots.length;
  if (h.done) return holeDoneView(r, h);
  var gp = geo && G.greenPt(geo), here = fix ? {lat:fix.lat, lng:fix.lng} : null;
  var fcb = here && geo ? G.fcb(here, geo) : null, far = fcb && fcb.c > 700;
  var rem = fcb && !far ? r0(fcb.c) : '—';
  var tee = idx === 0, lie = U.lie || autoLie(h, geo);
  var sug = suggest(fcb && !far ? fcb.c : (tee && geo ? G.holeLenYd(geo) : null), tee, h.par), club = U.club || sug;
  var carry = club ? carryOf(club) : null, avg = club && clubAverages()[club];
  var wt = here && gp && !far ? windTxt(here, gp) : null;
  var caption = !geo ? 'Hole ' + h.n + ' is not mapped' : !fix ? 'Waiting for GPS' : far ? 'You are ' + (fcb.c / 1760).toFixed(1) + ' mi from this green' : tee ? 'Tee · to middle of green' : 'To middle of green';
  var plays = [lie, wt || (wind ? null : 'wind loading')].filter(Boolean).join(' · ');
  var sugTxt = !club ? 'Add clubs to your bag to get a suggestion.'
    : (tee && h.par > 3 && club === S.bag[0].name) ? clubName(club) + ' ' + (avg ? 'averages ' + r0(avg.yd) + ' (GPS, ' + avg.n + ' shots)' : 'carries ' + carry + ' (stock)') + '.' + firTxt()
    : 'Your ' + club + ' ' + (avg ? 'averages ' + r0(avg.yd) + (avg.sd ? ' ± ' + r0(avg.sd) : '') + ' (GPS)' : 'carries ' + carry + ' (stock)') + '.' + (fcb && !far ? (carry >= fcb.c ? ' Reaches the middle.' : ' ' + r0(fcb.c - carry) + ' short of the middle.') : '');
  var last = idx >= 2 ? {i:idx - 2} : idx === 1 ? {i:0} : null, lastTxt = '', lastSg = '', lastCol = 'var(--mut)';
  if (last){
    var s = h.shots[last.i], f = SG.holeFacts(h, geo);
    if (idx >= 2){
      lastTxt = 'Shot ' + (last.i + 1) + ' · ' + s.lie + ' · ' + s.club + ' · ' + r0(G.distYd(s, h.shots[last.i + 1])) + ' yd';
      var v = f.shotSg[last.i]; if (v != null){ lastSg = sgn(v, 2) + ' SG'; lastCol = sgColor(v); }
    } else lastTxt = 'Shot 1 · ' + s.lie + ' · ' + s.club + (f.starts[0].d != null ? ' · from ' + r0(f.starts[0].d) + ' yd' : '');
  }
  var greenNow = idx > 0 && here && geo && G.onGreen(here, geo);
  return '<div class="scr">' +
    '<div class="pad" style="display:flex;justify-content:space-between;align-items:flex-end;"><div style="display:flex;flex-direction:column;gap:2px;"><span class="lbl">' + esc(holeLabel(h, geo)) + '</span><span style="font-family:var(--serif);font-size:30px;">Shot ' + (idx + 1) + '</span></div>' +
    '<button data-act="go" data-arg="card" style="display:flex;flex-direction:column;align-items:flex-end;gap:2px;"><span class="lbl">Card ›</span><span class="num" style="font-size:20px;font-weight:800;">' + toParTxt(toPar(rf)) + ' <span style="font-size:13px;color:var(--mut);font-weight:600;">thru ' + rf.t.n + '</span></span></button></div>' +
    (h.par ? '' : '<div class="m" style="display:flex;align-items:center;gap:8px;"><span class="lbl">Par not mapped</span>' + [3, 4, 5].map(function(p){ return '<button class="chip" data-act="setPar" data-arg="' + p + '">' + p + '</button>'; }).join('') + '</div>') +
    '<div class="card" style="margin:16px 20px 0;border-radius:16px;padding:20px;display:grid;grid-template-columns:1fr auto;align-items:center;gap:8px;">' +
      '<div style="display:flex;flex-direction:column;"><span style="font-size:12px;font-weight:600;color:var(--mut);">' + esc(caption) + '</span><span class="num" style="font-size:84px;font-weight:800;line-height:0.95;letter-spacing:-0.04em;">' + rem + '</span><span style="font-size:12px;color:var(--mut);">' + esc(plays) + '</span></div>' +
      '<div class="num" style="display:flex;flex-direction:column;gap:10px;text-align:right;">' +
        '<div><div style="font-size:11px;color:var(--mut);font-weight:600;">BACK</div><div style="font-size:22px;font-weight:700;">' + (fcb && fcb.b != null && !far ? r0(fcb.b) : '—') + '</div></div>' +
        '<div><div style="font-size:11px;color:var(--mut);font-weight:600;">FRONT</div><div style="font-size:22px;font-weight:700;">' + (fcb && fcb.f != null && !far ? r0(fcb.f) : '—') + '</div></div></div></div>' +
    '<div style="margin:12px 20px 0;padding:12px 14px;border-radius:12px;background:var(--acc-08);display:flex;align-items:center;gap:12px;"><span style="font-size:22px;font-weight:800;color:var(--acc);min-width:36px;">' + esc(club || '—') + '</span><span style="font-size:13px;line-height:1.4;">' + esc(sugTxt) + (U.aim ? ' Aim set on the map.' : '') + '</span></div>' +
    '<div style="padding:16px 20px 0;display:flex;flex-direction:column;gap:8px;"><span class="lbl">Club</span><div class="wrap">' +
      S.bag.map(function(b){ return '<button class="chip' + (b.name === club ? ' on' : '') + '" data-act="club" data-arg="' + esc(b.name) + '">' + esc(b.name) + '</button>'; }).join('') + '</div>' +
      '<span class="lbl" style="margin-top:6px;">Lie</span><div class="wrap">' +
      LIES.map(function(l){ return '<button class="pill' + (l === lie ? ' on' : '') + '" data-act="lie" data-arg="' + l + '">' + l + '</button>'; }).join('') + '</div></div>' +
    '<div style="margin-top:auto;padding:16px 20px;display:flex;flex-direction:column;gap:10px;">' +
      (last ? '<div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--mut);"><span>' + esc(lastTxt) + '</span><span style="color:' + lastCol + ';font-weight:700;white-space:nowrap;">' + lastSg + '</span></div>' : '') +
      (idx > 0 ? '<div style="display:flex;justify-content:space-between;font-size:12px;"><button class="link" style="font-size:12px;color:var(--mut);" data-act="undo">Undo last mark</button><button class="link" style="font-size:12px;" data-act="putt">On the green? Putting ›</button></div>' : '') +
      '<div style="display:grid;grid-template-columns:1fr 2fr;gap:10px;"><button class="btn sec big" style="font-size:15px;letter-spacing:0;" data-act="go" data-arg="map">Map</button>' +
      (greenNow ? '<button class="btn go big" data-act="putt">ON THE GREEN · PUTT</button>' : '<button class="btn pri big" data-act="mark">MARK BALL HERE</button>') + '</div></div></div>';
};
function clubName(c){ return c === 'D' ? 'Driver' : c; }
function firTxt(){
  var n = 0, hit = 0;
  finishedRounds().forEach(function(r){ factsOf(r).holes.forEach(function(x){ if (x.f.fir){ n++; if (x.f.fir === 'hit') hit++; } }); });
  return n >= 10 ? ' ' + r0(100 * hit / n) + '% of your tee shots find the fairway.' : '';
}
function holeDoneView(r, h){
  var f = SG.holeFacts(h, geoOf(r, h));
  return '<div class="scr"><div class="pad"><span class="lbl">' + esc(holeLabel(h, geoOf(r, h))) + '</span><h3 class="h">Hole complete</h3><p class="sub">' + f.score + ' strokes, ' + h.putts + ' putt' + (h.putts === 1 ? '' : 's') + '.</p></div>' +
    '<div class="foot" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;"><button class="btn sec" data-act="reopen">Reopen hole</button><button class="btn pri" data-act="go" data-arg="card">Scorecard</button></div></div>';
}

/* Hole map (1c): tap to measure, aim, take the club back */
var map = null, mapLayer = null, youM = null, tgtM = null, tgtLbl = null, mapHole = null;
function ensureMap(){
  if (map) return;
  map = L.map('map', {zoomControl:false, attributionControl:true, maxZoom:21});
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {maxNativeZoom:19, maxZoom:21, attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).addTo(map);
  // USGS imagery (public domain, US only) on top; where it has no tile, OpenStreetMap shows through
  L.tileLayer(USGS_TILE, {maxNativeZoom:18, maxZoom:21, attribution:'Imagery: <a href="https://www.usgs.gov/programs/national-geospatial-program/national-map">USGS The National Map</a>'}).addTo(map);
  mapLayer = L.layerGroup().addTo(map);
  map.on('click', function(e){ U.target = {lat:e.latlng.lat, lng:e.latlng.lng}; drawMap(false); });
}
function ballPos(r, h, geo){
  var gp = geo && G.greenPt(geo);
  if (fix && (!gp || G.distYd(fix, gp) < 800)) return {lat:fix.lat, lng:fix.lng, live:true};
  if (h.shots.length) return h.shots[h.shots.length - 1];
  return geo ? G.teePt(geo) : null;
}
function divIcon(cls, size){ return L.divIcon({className:'', html:'<div class="' + cls + '"></div>', iconSize:[size, size], iconAnchor:[size / 2, size / 2]}); }
function drawMap(fresh){
  var r = active(), h = curHole(); if (!r || !h){ go(roundHome()); return; }
  var geo = geoOf(r, h), gp = geo && G.greenPt(geo), ball = ballPos(r, h, geo);
  ensureMap();
  if (fresh || mapHole !== r.id + ':' + r.cur){
    setTimeout(function(){ map.invalidateSize(); }, 0);
    mapLayer.clearLayers(); youM = tgtM = tgtLbl = null; mapHole = r.id + ':' + r.cur;
    if (geo){
      (geo.fw || []).forEach(function(p){ L.polygon(p, {color:'#A9C7A2', weight:1, fillColor:'#A9C7A2', fillOpacity:0.35, interactive:false}).addTo(mapLayer); });
      geo.hz.forEach(function(z){ L.polygon(z.p, z.k === 'bunker' ? {color:'#EFE4C8', weight:1, fillColor:'#EFE4C8', fillOpacity:0.8, interactive:false} : {color:'#7BA7C9', weight:1, fillColor:'#7BA7C9', fillOpacity:0.5, interactive:false}).addTo(mapLayer); });
      if (geo.green) L.polygon(geo.green, {color:'#B6D1A8', weight:2, fillColor:'#C4DDB5', fillOpacity:0.55, interactive:false}).addTo(mapLayer);
      if (gp) L.marker(gp, {icon:divIcon('pindot', 14), interactive:false}).addTo(mapLayer);
    }
    var pts = [ball, gp].filter(Boolean);
    if (pts.length === 2) map.fitBounds(L.latLngBounds(pts.map(function(p){ return [p.lat, p.lng]; })), {paddingTopLeft:[40, 90], paddingBottomRight:[40, 200], maxZoom:19});
    else if (pts.length) map.setView([pts[0].lat, pts[0].lng], 17);
    else if (fix) map.setView([fix.lat, fix.lng], 16);
  }
  if (ball){ if (!youM) youM = L.marker([ball.lat, ball.lng], {icon:divIcon('youdot', 28), interactive:false}).addTo(mapLayer); else youM.setLatLng([ball.lat, ball.lng]); }
  var t = U.target, toT = null, tToPin = null, tClub = null;
  if (t && ball){ toT = r0(G.distYd(ball, t)); tToPin = gp ? r0(G.distYd(t, gp)) : null; tClub = suggest(toT, false, 3); }
  if (t){
    if (!tgtM){ tgtM = L.marker([t.lat, t.lng], {icon:divIcon('tgt', 18), interactive:false}).addTo(mapLayer); tgtLbl = L.marker([t.lat, t.lng], {icon:L.divIcon({className:'', html:'', iconSize:null, iconAnchor:[-14, 14]}), interactive:false}).addTo(mapLayer); }
    tgtM.setLatLng([t.lat, t.lng]); tgtLbl.setLatLng([t.lat, t.lng]);
    tgtLbl.setIcon(L.divIcon({className:'', html:'<div class="tgtlbl">' + toT + (tToPin != null ? ' · ' + tToPin + ' to pin' : '') + '</div>', iconSize:null, iconAnchor:[-14, 14]}));
  } else if (tgtM){ mapLayer.removeLayer(tgtM); mapLayer.removeLayer(tgtLbl); tgtM = tgtLbl = null; }
  var fcb = ball && geo ? G.fcb(ball, geo) : null;
  var box = function(k, v){ return '<div><div style="font-size:10px;font-weight:700;color:var(--mut);">' + k + '</div><div style="font-size:16px;font-weight:800;">' + (v == null ? '—' : r0(v)) + '</div></div>'; };
  $('#mapUi').innerHTML =
    '<div class="mtop"><button class="glass" data-act="go" data-arg="hole" style="padding:10px 14px;font-weight:800;font-size:14px;white-space:nowrap;">‹ Hole ' + h.n + ' · Par ' + (h.par || '?') + '</button>' +
    '<div class="glass num" style="padding:6px 12px;display:flex;gap:12px;">' + box('F', fcb && fcb.f) + box('M', fcb && fcb.c) + box('B', fcb && fcb.b) + '</div></div>' +
    '<div class="msheet">' + (!t
      ? '<span style="font-size:15px;font-weight:700;">Tap the map to measure</span><span style="font-size:13px;color:var(--mut);line-height:1.45;">You get the distance to that spot' + (ball && !ball.live ? ' from your last mark' : '') + ', what\'s left to the middle of the green, and the club that carries it.</span>'
      : '<div style="display:flex;justify-content:space-between;align-items:center;"><span style="font-size:15px;font-weight:700;">Target: ' + toT + ' yd</span><button data-act="clearTarget" style="font-size:12px;font-weight:700;color:var(--mut);">Clear</button></div>' +
        '<div class="grid3">' +
          '<div class="stat" style="border-radius:10px;padding:8px 10px;"><div class="k">TO TARGET</div><div class="v" style="font-size:17px;">' + toT + '</div></div>' +
          '<div class="stat" style="border-radius:10px;padding:8px 10px;"><div class="k">THEN TO PIN</div><div class="v" style="font-size:17px;">' + (tToPin == null ? '—' : tToPin) + '</div></div>' +
          '<div class="stat" style="border-radius:10px;padding:8px 10px;"><div class="k">CLUB</div><div class="v" style="font-size:17px;">' + esc(tClub || '—') + ' <span style="font-size:11px;color:var(--mut);">' + (tClub ? carryOf(tClub) : '') + '</span></div></div></div>' +
        (tClub ? '<button class="btn pri" style="height:52px;letter-spacing:0.04em;" data-act="aimHere" data-arg="' + esc(tClub) + '">AIM HERE · USE ' + esc(tClub) + '</button>' : '')) + '</div>';
}

/* Putting */
VIEWS.putt = function(){
  var r = active(), h = curHole(); if (!r || !h) return VIEWS.newround();
  var e = SG.expected('Green', U.firstPutt);
  return '<div class="scr"><div class="pad" style="display:flex;flex-direction:column;gap:2px;"><span class="lbl">Hole ' + h.n + ' · on the green</span><span style="font-family:var(--serif);font-size:30px;">Putting</span><span class="sub">' + h.shots.length + ' shot' + (h.shots.length === 1 ? '' : 's') + ' to the green</span></div>' +
    '<div class="card" style="margin:20px 20px 0;border-radius:16px;padding:20px;display:flex;flex-direction:column;gap:4px;">' +
      '<span style="font-size:12px;font-weight:600;color:var(--mut);">First putt · ' + (U.measured ? 'measured from where you stand to the middle' : 'not measured, set it') + '</span>' +
      '<div style="display:flex;align-items:center;justify-content:space-between;"><span class="num" style="font-size:72px;font-weight:800;line-height:1;letter-spacing:-0.04em;">' + U.firstPutt + ' ft</span>' +
      '<span style="display:flex;gap:6px;"><button class="chip" data-act="ft" data-arg="-1">−</button><button class="chip" data-act="ft" data-arg="1">+</button></span></div>' +
      '<span style="font-size:12px;color:var(--mut);">' + (e != null ? esc(SG.label()) + ' average from here: ' + e.toFixed(2) + ' putts' : 'Adjust to the pin if it is not in the middle.') + '</span></div>' +
    '<div class="card" style="margin:16px 20px 0;display:grid;grid-template-columns:60px 1fr 60px;align-items:center;border-radius:16px;height:76px;">' +
      '<button data-act="missed" data-arg="-1" style="height:100%;font-size:26px;font-weight:700;color:var(--mut);">−</button>' +
      '<span class="num" style="text-align:center;font-size:22px;font-weight:800;">' + U.missed + ' missed</span>' +
      '<button data-act="missed" data-arg="1" style="height:100%;font-size:26px;font-weight:700;">+</button></div>' +
    '<p style="margin:12px 20px 0;font-size:12px;color:var(--mut);line-height:1.5;">Count putts that missed with +. Holed it adds the last one and scores the hole.' + (U.missed === 0 ? ' <button class="link" style="font-size:12px;" data-act="chipin">Holed from off the green</button>' : '') + '</p>' +
    '<div style="margin-top:auto;padding:16px 20px;display:grid;grid-template-columns:1fr 2fr;gap:10px;"><button class="btn sec big" style="font-size:14px;letter-spacing:0;" data-act="missed" data-arg="1">Missed</button><button class="btn go big" data-act="holed">HOLED IT</button></div></div>';
};

/* Scorecard */
function firMark(f){ return f === 'hit' ? '✓' : f === 'left' ? '←' : f === 'right' ? '→' : f === 'miss' ? '✗' : ''; }
VIEWS.card = function(){
  var r = viewed(); if (!r) return VIEWS.newround();
  var rf = factsOf(r), live = r.id === S.activeId, cols = 'grid-template-columns:40px 40px 1fr 44px 44px 52px;';
  function tot(label, xs){
    var d = xs.filter(function(x){ return x.h.done; });
    var fir = d.filter(function(x){ return x.f.fir; }), sgs = d.map(function(x){ return x.f.sg; }), known = d.length && sgs.every(function(v){ return v != null; });
    return '<div style="display:grid;' + cols + 'padding:12px 14px;align-items:center;font-size:14px;font-weight:800;background:var(--page);"><span>' + label + '</span><span>' + (xs.every(function(x){ return x.h.par; }) ? xs.reduce(function(t, x){ return t + x.h.par; }, 0) : '') + '</span><span>' + (d.length ? d.reduce(function(t, x){ return t + x.f.score; }, 0) : '') + '</span><span>' +
      (fir.length ? fir.filter(function(x){ return x.f.fir === 'hit'; }).length + '/' + fir.length : '') + '</span><span>' + (d.length ? d.reduce(function(t, x){ return t + x.h.putts; }, 0) : '') + '</span><span style="text-align:right;">' + (known ? sgn(sgs.reduce(function(t, v){ return t + v; }, 0)) : '') + '</span></div>';
  }
  var rows = rf.holes.map(function(x, i){
    var h = x.h, f = x.f, cur = live && i === r.cur && !h.done, d = h.done && h.par ? f.score - h.par : null;
    var ring = d == null ? 'transparent' : d < 0 ? 'var(--acc)' : d > 0 ? 'var(--warm)' : 'transparent';
    return '<button data-act="cardRow" data-arg="' + i + '" style="display:grid;' + cols + 'padding:8px 14px;align-items:center;font-size:14px;font-weight:600;width:100%;text-align:left;background:' + (cur ? 'var(--acc-08)' : '#fff') + ';"><span style="font-weight:800;">' + h.n + '</span><span style="color:var(--mut);">' + (h.par || '·') + '</span>' +
      '<span><span style="width:28px;height:28px;border-radius:' + (d != null && d < 0 ? '999px' : '4px') + ';border:2px solid ' + ring + ';display:inline-flex;align-items:center;justify-content:center;font-weight:800;">' + (h.done ? f.score : '·') + '</span></span>' +
      '<span>' + (h.par === 3 ? '—' : firMark(f.fir)) + '</span><span>' + (h.done ? h.putts : '') + '</span><span style="text-align:right;font-weight:800;color:' + sgColor(f.sg) + ';">' + (f.sg != null ? sgn(f.sg) : '') + '</span></button>';
  });
  var body = [], front = rf.holes.filter(function(x){ return x.h.n <= 9; }), back = rf.holes.filter(function(x){ return x.h.n > 9; });
  if (front.length){ body.push(rows.slice(0, front.length).join('')); body.push(tot('OUT', front)); }
  if (back.length){ body.push(rows.slice(front.length).join('')); body.push(tot('IN', back)); }
  if (front.length && back.length) body.push(tot('TOT', rf.holes));
  var h = live ? r.holes[r.cur] : null, allDone = r.holes.every(function(x){ return x.done; });
  var btn = !live ? ['go', 'summary', 'Round summary'] : allDone ? ['end', '', 'See round summary'] : h.done ? ['next', '', 'Tee off hole ' + r.holes[r.cur + 1].n] : ['go', 'hole', 'Back to hole ' + h.n];
  return '<div class="scr"><div class="pad" style="display:flex;justify-content:space-between;align-items:flex-end;"><h3 class="h">Scorecard</h3><span class="num" style="font-size:20px;font-weight:800;">' + toParTxt(toPar(rf)) + ' <span style="font-size:13px;color:var(--mut);font-weight:600;">thru ' + rf.t.n + '</span></span></div>' +
    '<div class="card num" style="margin:14px 20px 0;overflow:hidden;">' +
      '<div style="display:grid;' + cols + 'padding:10px 14px;font-size:10px;font-weight:700;letter-spacing:0.08em;color:var(--mut);border-bottom:1px solid var(--line);"><span>HOLE</span><span>PAR</span><span>SCORE</span><span>FIR</span><span>PUTT</span><span style="text-align:right;">SG</span></div>' +
      '<div class="rows">' + body.join('') + '</div></div>' +
    '<div class="foot" style="display:flex;flex-direction:column;gap:10px;"><button class="btn pri" data-act="' + btn[0] + '" data-arg="' + btn[1] + '">' + btn[2] + '</button>' +
    (live && !allDone ? '<button class="link" style="align-self:center;color:var(--mut);" data-act="end">End round here</button>' : '') + '</div></div>';
};

/* Post-round summary (1g) */
VIEWS.summary = function(){
  var r = viewed(); if (!r) return VIEWS.newround();
  var rf = factsOf(r), t = rf.t, tp = toPar(rf), allDone = r.holes.every(function(h){ return h.done; });
  var left = r.holes.filter(function(h){ return !h.done; }).length;
  var cats = ['ott', 'app', 'arg', 'putt'].map(function(k){
    var v = t.by[k], w = Math.min(Math.abs(v) * 60, 100) + '%';
    return '<div class="num" style="display:grid;grid-template-columns:96px 1fr 1fr 44px;align-items:center;font-size:13px;font-weight:700;"><span>' + CAT_NAME[k] + '</span>' +
      '<div style="height:14px;display:flex;justify-content:flex-end;"><div style="height:14px;width:' + (v < 0 ? w : '0%') + ';background:var(--warm);border-radius:4px 0 0 4px;"></div></div>' +
      '<div style="height:14px;border-left:1px solid var(--line);"><div style="height:14px;width:' + (v > 0 ? w : '0%') + ';background:var(--pos);border-radius:0 4px 4px 0;"></div></div>' +
      '<span style="text-align:right;color:' + sgColor(v) + ';">' + sgn(v) + '</span></div>';
  }).join('');
  var leak = t.sgKnown ? roundLeak(r, t) : null;
  var date = new Date(r.started), today = isoDate(date) === isoDate(Date.now());
  return '<div class="scr"><div class="pad" style="display:flex;flex-direction:column;gap:2px;">' +
    '<span class="lbl">' + (today ? 'Today' : date.toLocaleDateString(undefined, {month:'short', day:'numeric'})) + ' · ' + esc(r.course) + ' · ' + pickLabel(r.pick) + '</span>' +
    '<div style="display:flex;align-items:baseline;gap:12px;margin-top:4px;"><span style="font-family:var(--serif);font-size:88px;line-height:0.9;">' + t.score + '</span><span style="font-size:22px;font-weight:800;color:var(--acc);">' + toParTxt(tp) + '</span></div>' +
    '<span style="font-size:14px;color:var(--mut);">' + (allDone ? pickLabel(r.pick) + ' complete.' : Geo.plural(left, 'hole') + ' not played.') + '</span></div>' +
    '<div class="card" style="margin:18px 20px 0;padding:16px;display:flex;flex-direction:column;gap:12px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;"><span class="lbl">Strokes gained' + (SG.ready() ? ' vs ' + esc(SG.label()) : '') + '</span><span class="num" style="font-size:20px;font-weight:800;color:' + sgColor(t.sgKnown ? t.sg : null) + ';">' + (t.sgKnown ? sgn(t.sg) : '—') + '</span></div>' +
      (t.sgKnown ? cats : '<p class="sub">' + (SG.ready() ? 'Some holes are missing the positions strokes gained needs.' : 'Strokes gained turns on once the baseline table is added (see baseline.js). Your shots are saved and will be scored then.') + '</p>') + '</div>' +
    '<div class="grid3" style="margin:12px 20px 0;">' + statBox('FAIRWAYS', t.fn ? t.fh + '/' + t.fn : '—') + statBox('PUTTS', t.putts) + statBox('UP &amp; DOWN', t.un ? t.uh + '/' + t.un : '—') + '</div>' +
    (leak ? '<div class="warmtint" style="margin:12px 20px 0;display:flex;flex-direction:column;gap:4px;"><span class="lbl" style="color:var(--neg);">' + leak.head + '</span><span style="font-size:14px;font-weight:600;line-height:1.45;">' + esc(leak.txt) + '</span></div>' : '') +
    '<div class="foot" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;"><button class="btn sec" style="height:52px;" data-act="go" data-arg="card">Scorecard</button><button class="btn pri" style="height:52px;font-weight:700;" data-act="go" data-arg="practice">Update plan</button></div></div>';
};
/* the round's costliest category, said with where it happened */
function roundLeak(r, t){
  var k = ['ott', 'app', 'arg', 'putt'].sort(function(a, b){ return t.by[a] - t.by[b]; })[0], v = t.by[k];
  if (v >= 0) return null;
  var f = focus(), still = f && f.k === k, bs = SG.bands([r], courseOf), txt = CAT_NAME[k] + ' cost ' + Math.abs(v).toFixed(1) + ' strokes this round';
  var b = k === 'app' ? worstBand(bs.app) : k === 'putt' ? worstBand(bs.putt) : null;
  if (b && b.sg < 0) txt += ', ' + Math.abs(b.sg).toFixed(1) + ' of them from ' + b.b[2] + ' (' + Geo.plural(b.n, k === 'putt' ? 'first putt' : 'shot') + ')';
  txt += '. ' + (still ? 'It is already this week\'s practice focus.' : 'The practice plan updates from your last 10 rounds.');
  return {head:still ? 'Still the leak' : 'Biggest leak', txt:txt};
}

/* Practice plan (1e) */
VIEWS.practice = function(){
  var f = focus(), now = Date.now(), ws = weekStart(now), today = isoDate(now), todayIdx = (new Date().getDay() + 6) % 7;
  var days = S.practice.days, drills = drillsFor(f), done = 0;
  var roundDays = {}; S.rounds.forEach(function(r){ roundDays[isoDate(r.started)] = 1; });
  var cells = ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(function(L, i){
    var date = isoDate(ws + i * DAY + 3600000), planned = days.indexOf(i), log = loggedOn(date), cell;
    var base = 'width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;';
    if (log){ done++; cell = '<span style="' + base + 'background:var(--acc);color:#fff;font-size:13px;font-weight:800;">✓</span>'; }
    else if (roundDays[date]) cell = '<span style="' + base + 'background:var(--warm-16);font-size:10px;font-weight:800;color:var(--neg);">RND</span>';
    else if (planned >= 0 && i === todayIdx) cell = '<span style="' + base + 'border:2px solid var(--ink);font-size:12px;font-weight:800;">' + (planned + 1) + '</span>';
    else if (planned >= 0 && i > todayIdx) cell = '<span style="' + base + 'border:1px dashed var(--mut);font-size:12px;font-weight:700;color:var(--mut);">' + (planned + 1) + '</span>';
    else cell = '<span style="' + base + 'background:var(--page);"></span>';
    return '<button data-act="toggleDay" data-arg="' + i + '" style="display:flex;flex-direction:column;align-items:center;gap:6px;"><span style="font-size:11px;font-weight:' + (i === todayIdx ? 800 : 700) + ';color:' + (i === todayIdx ? 'var(--ink)' : 'var(--mut)') + ';">' + L + '</span>' + cell + '</button>';
  }).join('');
  var loggedToday = loggedOn(today);
  var nextIdx = days.filter(function(d){ return d > todayIdx; })[0], dn = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  var sessNo = days.indexOf(todayIdx) >= 0 ? days.indexOf(todayIdx) + 1 : days.filter(function(d){ return d < todayIdx; }).length + 1;
  var ticks = U.ticks, nDone = ticks ? ticks.filter(Boolean).length : 0;
  var btn = loggedToday ? 'Session logged' + (nextIdx != null ? ' · see you ' + dn[nextIdx] : '') : !ticks ? 'Start session' : nDone < drills.length ? nDone + ' of ' + drills.length + ' drills done' : 'Finish session';
  var mins = drills.reduce(function(t, d){ return t + parseInt(d.m, 10); }, 0);
  var sub = !f ? (SG.ready() ? 'Play a round and Carry builds the plan from where you lose the most strokes.' : 'The plan is built from strokes gained, which turns on once the baseline table is added. Until then it trains the short game.')
    : (f.v < 0 ? 'Costing you ' + Math.abs(f.v).toFixed(1) + ' strokes per 18 holes against the ' + esc(SG.label()) + ' baseline' : 'Your weakest area, though still ' + sgn(f.v) + ' per 18 holes against the ' + esc(SG.label()) + ' baseline') + ', over your last ' + Geo.plural(f.n, 'round') + '.' + (f.next ? ' Next biggest: ' + CAT_NAME[f.next.k].toLowerCase() + ' (' + sgn(f.next.v) + ').' : '');
  var trend = trendOf(f);
  return '<div class="scr"><div class="pad" style="display:flex;flex-direction:column;gap:4px;">' +
    '<span class="lbl">Week of ' + new Date(ws).toLocaleDateString(undefined, {month:'short', day:'numeric'}) + ' · ' + done + ' of ' + days.length + ' sessions done</span>' +
    '<h3 class="h">' + esc(focusTitle(f)) + '</h3><p class="sub">' + sub + '</p></div>' +
    '<div style="margin:14px 20px 0;display:grid;grid-template-columns:repeat(7,1fr);gap:6px;">' + cells + '</div>' +
    '<p class="sub" style="margin:6px 20px 0;font-size:11px;">Tap a day to plan or unplan a session.</p>' +
    '<div class="card" style="margin:12px 20px 0;padding:16px;display:flex;flex-direction:column;gap:10px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;"><span style="font-size:16px;font-weight:800;">' + (days.indexOf(todayIdx) >= 0 ? 'Today' : 'Extra') + ' · Session ' + sessNo + '</span><span style="font-size:12px;color:var(--mut);font-weight:600;">' + mins + ' min · range</span></div>' +
      drills.map(function(d, i){
        var on = ticks && ticks[i];
        return '<button data-act="tick" data-arg="' + i + '" style="display:grid;grid-template-columns:24px auto 1fr auto;gap:10px;align-items:center;padding-top:10px;border-top:1px solid var(--line2);text-align:left;">' +
          '<span style="width:22px;height:22px;border-radius:6px;border:1.5px solid ' + (on ? 'var(--acc)' : 'var(--line)') + ';background:' + (on ? 'var(--acc)' : '#fff') + ';color:#fff;font-size:12px;font-weight:800;display:flex;align-items:center;justify-content:center;">' + (on ? '✓' : '') + '</span>' +
          '<span style="font-size:12px;font-weight:800;color:var(--mut);">' + d.m + '</span><span style="font-size:14px;font-weight:600;color:' + (on ? 'var(--mut)' : 'var(--ink)') + ';">' + esc(d.t) + '</span><span style="font-size:12px;color:var(--mut);">' + d.b + '</span></button>';
      }).join('') +
      (ticks && !loggedToday ? '<span style="font-size:12px;color:var(--acc);font-weight:600;">Tap each drill as you finish it.</span>' : '') +
      '<button class="btn" style="height:50px;border-radius:12px;color:#fff;letter-spacing:0.02em;background:' + (loggedToday ? 'var(--acc)' : 'var(--ink)') + ';" data-act="session">' + btn + '</button></div>' +
    '<div style="margin:12px 20px 20px;display:flex;justify-content:space-between;align-items:center;" class="tint"><div><div class="lbl" style="color:var(--acc);">4-week trend' + (f ? ' · ' + (f.band ? esc(f.band[2]) : CAT_NAME[f.k]) : '') + '</div><div style="font-size:14px;font-weight:700;margin-top:2px;">' + esc(trend.txt) + '</div></div>' +
      (trend.up != null ? '<span style="font-size:22px;font-weight:800;color:' + (trend.up ? 'var(--acc)' : 'var(--neg)') + ';">' + (trend.up ? '↑' : '↓') + '</span>' : '') + '</div></div>';
};
/* the focus category in the older half of the last four weeks against the newer half */
function trendOf(f){
  if (!f) return {txt:'Not enough rounds yet', up:null};
  var since = Date.now() - 28 * DAY, list = per18(finishedRounds().filter(function(r){ return r.started >= since; }));
  if (list.length < 2) return {txt:'Play 2 rounds in 4 weeks to see a trend', up:null};
  var half = Math.floor(list.length / 2), a = avgOf(list.slice(0, half), f.k), b = avgOf(list.slice(half), f.k);
  return {txt:sgn(a, 2) + ' → ' + sgn(b, 2) + ' SG / 18 holes', up:b >= a};
}

/* Strokes-gained dashboard (1k) */
VIEWS.stats = function(){
  var rounds = recentRounds(10), list = per18(rounds), all = rounds.map(factsOf);
  var sum = function(k){ return all.reduce(function(t, x){ return t + x.t[k]; }, 0); };
  var fh = sum('fh'), fn = sum('fn'), gh = sum('gh'), gn = sum('gn'), uh = sum('uh'), un = sum('un'), holes = sum('n');
  var drives = shotSamples().filter(function(x){ return x.i === 0 && x.par >= 4 && S.bag[0] && x.club === S.bag[0].name; }).map(function(x){ return x.dist; });
  var bs = list.length ? SG.bands(list.map(function(x){ return x.r; }), courseOf) : null, wp = bs && worstBand(bs.putt);
  var avg = avgOf(list, 'tot'), max = Math.max.apply(null, list.map(function(x){ return Math.abs(x.tot); }).concat([0.1]));
  var bars = list.map(function(x, i){ return '<span style="flex:1;height:' + Math.max(6, r0(96 * Math.abs(x.tot) / max)) + '%;background:' + (i === list.length - 1 ? 'var(--dk-hi)' : 'var(--dk-bar)') + ';border-radius:3px;"></span>'; }).join('');
  function row(name, sub, k, act){
    var v = avgOf(list, k);
    return '<' + (act ? 'button data-act="go" data-arg="disp"' : 'div') + ' style="display:grid;grid-template-columns:1fr 60px;padding:13px 16px;align-items:center;width:100%;text-align:left;"><div><div style="font-size:14px;font-weight:700;">' + name + (act ? ' ›' : '') + '</div><div style="font-size:12px;color:var(--mut);">' + sub + '</div></div>' +
      '<span style="font-size:17px;font-weight:800;text-align:right;color:' + sgColor(v) + ';">' + (v == null ? '—' : sgn(v)) + '</span></' + (act ? 'button' : 'div') + '>';
  }
  var f = focus();
  return '<div class="scr"><div class="pad"><h3 class="h">Strokes Gained</h3></div>' +
    '<div class="dark" style="margin:14px 20px 0;padding:18px;display:flex;flex-direction:column;gap:10px;">' +
      '<div style="display:flex;justify-content:space-between;"><span class="lbl" style="color:var(--dk-mut);">Last ' + Geo.plural(rounds.length || 10, 'round') + ' · vs ' + esc(SG.label() || 'baseline') + '</span><span style="font-size:12px;color:var(--dk-mut);">per 18</span></div>' +
      '<span class="num" style="font-size:48px;font-weight:800;line-height:1;color:' + (avg == null ? 'var(--dk-mut)' : avg >= 0 ? 'var(--dk-hi)' : 'var(--dk-neg)') + ';">' + (avg == null ? '—' : sgn(avg)) + '</span>' +
      (list.length ? '<div style="height:56px;display:flex;align-items:flex-end;gap:6px;">' + bars + '</div>' : '<span style="font-size:12px;color:var(--dk-mut);">' + (SG.ready() ? 'Finish a round to see strokes gained.' : 'Strokes gained turns on once the baseline table is added (baseline.js).') + '</span>') + '</div>' +
    '<div class="card num rows" style="margin:12px 20px 0;overflow:hidden;">' +
      row('Off the tee', (fn ? r0(100 * fh / fn) + '% fairways' : 'No fairways yet') + (drives.length ? ' · ' + r0(median(drives)) + ' avg' : ''), 'ott') +
      row('Approach', (gn ? r0(100 * gh / gn) + '% GIR' : 'No greens yet') + ' · see dispersion', 'app', true) +
      row('Around the green', un ? r0(100 * uh / un) + '% up &amp; down' : 'No up-and-downs yet', 'arg') +
      row('Putting', (holes ? (sum('putts') * 18 / holes).toFixed(1) + ' putts / 18' : 'No putts yet') + (wp && wp.sg < 0 ? ' · ' + wp.b[2] + ' weak' : ''), 'putt') + '</div>' +
    (f && f.v < 0 ? '<div class="tint" style="margin:12px 20px 0;font-size:13px;font-weight:600;line-height:1.45;">Closing the ' + CAT_NAME[f.k].toLowerCase() + ' gap' + (f.band ? ' from ' + f.band[2] : '') + ' to the baseline is worth about ' + Math.abs(f.v).toFixed(1) + ' strokes per 18 holes. It drives this week\'s plan.</div>' : '') +
    (SG.ready() && window.CARRY_BASELINE.source ? '<p class="sub" style="margin:10px 20px 20px;font-size:11px;">Baseline: ' + esc(window.CARRY_BASELINE.source) + '</p>' : '<div style="height:20px"></div>') + '</div>';
};

/* Club dispersion (1l) */
function dispData(club){
  var since = Date.now() - 90 * DAY, pts = [];
  shotSamples(since).forEach(function(x){
    if (x.club !== club || !x.geo) return;
    var gp = G.greenPt(x.geo), aim = x.s.aim || null;
    // no aim set on the map: the green when it was in range, otherwise the hole's line at the distance hit
    if (!aim && gp && G.distYd(x.s, gp) <= x.dist * 1.25) aim = gp;
    if (!aim && x.geo.line){ var li = G.lineInfo(x.s, x.geo.line); aim = G.pointAlong(x.geo.line, li.along + x.dist * G.M_PER_YD); }
    var o = aim && G.offLine(x.s, aim, x.end); if (o) pts.push({side:o.side, dist:x.dist});
  });
  return pts;
}
VIEWS.disp = function(){
  var clubs = S.bag.map(function(b){ return b.name; }).filter(function(c){ return dispData(c).length >= 3; });
  if (clubs.indexOf(U.dClub) < 0) U.dClub = clubs.filter(function(c){ return /i$|PW/.test(c); })[0] || clubs[0] || null;
  var head = '<div class="pad" style="display:flex;flex-direction:column;gap:12px;"><div style="display:flex;justify-content:space-between;align-items:baseline;"><h3 class="h">Dispersion</h3><button class="link" data-act="go" data-arg="stats">‹ Stats</button></div>' +
    '<div class="wrap">' + clubs.map(function(c){ return '<button class="chip' + (c === U.dClub ? ' on' : '') + '" style="min-width:52px;" data-act="dClub" data-arg="' + esc(c) + '">' + esc(c) + '</button>'; }).join('') + '</div></div>';
  if (!U.dClub) return '<div class="scr">' + head + '<p class="sub m">A club shows up here once it has 3 measured shots in the last 90 days: mark each shot, and use Putting on the green so approach shots get a finish position.</p></div>';
  var pts = dispData(U.dClub), sides = pts.map(function(p){ return p.side; }), dists = pts.map(function(p){ return p.dist; });
  var md = median(dists), sdD = sd(dists), wL = pct(sides, 0.1), wR = pct(sides, 0.9), dS = pct(dists, 0.1), dL = pct(dists, 0.9), bias = mean(sides);
  var W = 350, H = 360, cx = W / 2, cy = 186, span = Math.max(15, Math.max.apply(null, sides.map(Math.abs)) * 1.15, Math.max.apply(null, dists.map(function(d){ return Math.abs(d - md); })) * 1.15);
  var k = Math.min((W / 2 - 16) / span, (H / 2 - 36) / span);
  var dots = pts.map(function(p){ return '<div style="position:absolute;left:' + (cx + p.side * k - 4).toFixed(1) + 'px;top:' + (cy - (p.dist - md) * k - 4).toFixed(1) + 'px;width:8px;height:8px;border-radius:50%;background:var(--acc);"></div>'; }).join('');
  var ell = '<div style="position:absolute;left:' + (cx + wL * k).toFixed(1) + 'px;top:' + (cy - (dL - md) * k).toFixed(1) + 'px;width:' + Math.max(8, (wR - wL) * k).toFixed(1) + 'px;height:' + Math.max(8, (dL - dS) * k).toFixed(1) + 'px;border-radius:50%;background:rgba(74,124,111,0.10);border:1.5px solid rgba(74,124,111,0.5);"></div>';
  var bl = Math.abs(bias) < 0.5 ? '0 yd' : r0(Math.abs(bias)) + ' yd ' + (bias > 0 ? 'R' : 'L');
  return '<div class="scr">' + head +
    '<div class="card" style="margin:14px 20px 0;height:' + H + 'px;position:relative;overflow:hidden;flex:none;">' +
      '<div style="position:absolute;left:' + cx + 'px;top:0;bottom:0;width:1px;background:var(--line2);"></div><div style="position:absolute;left:0;right:0;top:' + cy + 'px;height:1px;background:var(--line2);"></div>' +
      '<div style="position:absolute;left:12px;top:12px;font-size:11px;font-weight:700;color:var(--mut);">' + esc(U.dClub) + ' · ' + Geo.plural(pts.length, 'on-course shot') + '</div>' + ell + dots +
      '<div style="position:absolute;left:12px;bottom:12px;font-size:11px;font-weight:600;color:var(--mut);">↑ long · target line</div>' +
      '<div style="position:absolute;right:12px;bottom:12px;font-size:11px;font-weight:600;color:var(--mut);">80% range · last 90 days</div></div>' +
    '<div class="grid3" style="margin:12px 20px 0;">' + statBox('DISTANCE', r0(md), sdD != null ? '± ' + r0(sdD) + ' yd' : '') + statBox('WIDTH', r0(wR - wL) + ' yd', '80% of shots') +
      statBox('BIAS', bl, Math.abs(bias) < 0.5 ? 'on line' : bias > 0 ? 'misses right' : 'misses left', 'var(--neg)') + '</div>' +
    '<p class="sub" style="margin:10px 20px 20px;font-size:11px;">Total distance from GPS marks, not carry. Side is measured from the line to your map aim, or to the green when no aim was set.</p></div>';
};

/* Friends (1m): season strokes gained, shared by link */
VIEWS.friends = function(){
  var me = myCard(), pf = U.pendingFriend;
  var all = S.friends.map(function(f){ return {f:f, me:false}; }).concat([{f:me, me:true}]).filter(function(x){ return x.f.sg; })
    .sort(function(a, b){ return b.f.sg.tot - a.f.sg.tot; });
  var noSg = S.friends.filter(function(f){ return !f.sg; });
  var initials = function(n){ return esc(n.split(/\s+/).map(function(w){ return w[0]; }).join('').slice(0, 2).toUpperCase()); };
  var rows = all.map(function(x, i){
    var f = x.f;
    return '<div style="display:grid;grid-template-columns:24px 40px 1fr auto;gap:10px;align-items:center;padding:12px 14px;background:' + (x.me ? 'var(--acc-08)' : '#fff') + ';"><span style="font-weight:800;">' + (i + 1) + '</span>' +
      '<span style="width:36px;height:36px;border-radius:999px;background:' + (x.me ? 'var(--acc)' : 'var(--acc-14)') + ';color:' + (x.me ? '#fff' : 'var(--ink)') + ';display:flex;align-items:center;justify-content:center;font-weight:800;font-size:' + (x.me ? 12 : 13) + 'px;">' + (x.me ? 'You' : initials(f.n)) + '</span>' +
      '<div><div style="font-weight:700;font-size:14px;">' + (x.me ? 'You' : esc(f.n)) + '</div><div style="font-size:12px;color:var(--mut);">' + Geo.plural(f.r, 'round') + (x.me ? '' : ' · ' + new Date(f.t).toLocaleDateString(undefined, {month:'short', day:'numeric'})) + '</div></div>' +
      '<span style="font-weight:800;color:' + sgColor(f.sg.tot) + ';">' + sgn(f.sg.tot) + '</span></div>';
  }).join('');
  var vs = null, mi = all.findIndex(function(x){ return x.me; });
  if (me.sg && all.length > 1) vs = mi > 0 ? all[mi - 1].f : all[1].f;
  var name = S.me.name;
  return '<div class="scr"><div class="pad"><h3 class="h">Friends</h3><p class="sub">Strokes gained per 18 holes, last 20 rounds</p></div>' +
    (pf ? '<div class="tint m" style="display:flex;flex-direction:column;gap:10px;"><span style="font-size:14px;font-weight:700;">Add ' + esc(pf.n) + ' to your leaderboard?</span><span class="sub">' + Geo.plural(pf.r, 'round') + (pf.sg ? ' · ' + sgn(pf.sg.tot) + ' SG per 18' : '') + '</span>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;"><button class="btn sec" style="height:44px;" data-act="friendNo">Ignore</button><button class="btn pri" style="height:44px;" data-act="friendYes">Add</button></div></div>' : '') +
    (all.length ? '<div class="card num rows" style="margin:14px 20px 0;overflow:hidden;">' + rows + '</div>' : '') +
    (noSg.length ? '<p class="sub m">' + noSg.map(function(f){ return esc(f.n); }).join(', ') + ' shared before having strokes gained.</p>' : '') +
    (!S.friends.length ? '<p class="sub m">Send your link to your group. When a friend opens it in Carry and sends theirs back, you both show up here. There is no account and no server: the link carries only your averages.</p>' : '') +
    (vs ? '<div class="dark" style="margin:14px 20px 0;padding:16px;display:flex;flex-direction:column;gap:10px;"><span class="lbl" style="color:var(--dk-mut);">You vs ' + esc(vs.n) + ' · where the gap is</span>' +
      '<div class="num" style="display:grid;grid-template-columns:1fr auto auto;gap:6px 16px;font-size:13px;font-weight:600;">' + ['ott', 'app', 'arg', 'putt'].map(function(k){
        var a = me.sg[k], b = vs.sg[k];
        return '<span style="color:var(--dk-mut);">' + CAT_NAME[k] + '</span><span style="color:' + (a < b ? 'var(--dk-neg)' : 'inherit') + ';">' + sgn(a) + '</span><span style="color:var(--dk-mut);">' + sgn(b) + '</span>';
      }).join('') + '</div></div>' : '') +
    '<div style="margin:auto 20px 20px;padding-top:14px;display:flex;flex-direction:column;gap:10px;">' +
      '<input class="in" id="myName" data-in="myName" placeholder="Your name, as friends see it" value="' + esc(name) + '">' +
      '<button class="btn pri" style="height:52px;" data-act="share"' + (name ? '' : ' disabled') + '>Share my stats</button></div></div>';
};

/* ---------- actions ---------- */
var ACT = {
  go:function(a){ if (a === 'newround' || a === 'course'){ U.imported = null; U.found = null; U.finding = null; } if (a === 'bag'){ U.bagDraft = null; } go(a); },
  gpsOn:function(){ startGPS(); render(); },
  findNearby:findNearby,
  search:function(){ searchCourses(($('#q') || {}).value); },
  importCourse:function(i){ importCourse(U.found[+i]); },
  pickSaved:function(id){ U.imported = id; U.courseId = id; render(); },
  pickCourse:function(id){ U.courseId = id; render(); },
  courseDone:function(){ U.imported = null; go('newround'); },
  onbNext:function(){ U.imported = null; U.bagDraft = null; go('onb2'); },
  addClub:function(){ U.bagDraft.push({name:'', stock:''}); render(); },
  saveBag:function(){
    var bag = U.bagDraft.filter(function(b){ return b.name.trim(); }).map(function(b){ return {name:b.name.trim().slice(0, 5), stock:parseInt(b.stock, 10) || 0}; });
    if (!bag.length){ toast('Add at least one club.'); return; }
    S.bag = bag; U.bagDraft = null; avgCache = null; save();
    if (U.screen === 'onb2'){ startGPS(); go('onb3'); } else { toast('Bag saved.'); go(roundHome()); }
  },
  holesPick:function(p){ U.holesPick = p; render(); },
  startRound:startRound,
  viewRound:function(id){ U.viewId = id; go('summary'); },
  club:function(c){ U.club = c; render(); },
  lie:function(l){ U.lie = l; render(); },
  setPar:function(p){ var r = active(), h = curHole(), c = courseOf(r); h.par = +p; if (c){ c.holes[h.n] = c.holes[h.n] || {hz:[], fw:[], tees:[]}; c.holes[h.n].par = +p; } save(); render(); },
  mark:markBall,
  undo:function(){ var h = curHole(); if (h && h.shots.length && confirm('Remove the last mark?')){ h.shots.pop(); avgCache = null; save(); render(); } },
  putt:goPutt,
  clearTarget:function(){ U.target = null; drawMap(false); },
  aimHere:function(c){ U.club = c; U.aim = U.target ? {lat:+U.target.lat.toFixed(7), lng:+U.target.lng.toFixed(7)} : null; go('hole'); },
  ft:function(d){ U.firstPutt = Math.max(1, Math.min(150, U.firstPutt + +d)); render(); },
  missed:function(d){ U.missed = Math.max(0, U.missed + +d); render(); },
  holed:function(){ holed(U.missed + 1); },
  chipin:function(){ if (confirm('Holed from off the green, no putts?')) holed(0); },
  next:nextHole,
  end:function(){ var r = active(); if (r && r.holes.some(function(h){ return !h.done; }) && !confirm('End the round with holes unplayed?')) return; endRound(); },
  cardRow:function(i){ var r = viewed(); if (!r || r.id !== S.activeId) return; r.cur = +i; resetShot(); save(); go('hole'); },
  reopen:function(){ var h = curHole(); if (confirm('Reopen hole ' + h.n + '? Its putts are cleared.')){ h.done = false; h.putts = 0; h.firstPutt = null; save(); render(); } },
  toggleDay:function(i){ i = +i; var d = S.practice.days, k = d.indexOf(i); if (k >= 0) d.splice(k, 1); else { d.push(i); d.sort(); } save(); render(); },
  tick:function(i){ if (!U.ticks || loggedOn(isoDate(Date.now()))) return; U.ticks[+i] = !U.ticks[+i]; render(); },
  session:function(){
    var today = isoDate(Date.now()), drills = drillsFor(focus());
    if (loggedOn(today)) return;
    if (!U.ticks){ U.ticks = drills.map(function(){ return false; }); render(); return; }
    if (U.ticks.filter(Boolean).length < drills.length) return;
    var f = focus(); S.practice.log.push({date:today, focus:f ? f.k + (f.band ? ':' + f.band[0] + '-' + f.band[1] : '') : null, drills:drills.map(function(d){ return d.t; })});
    U.ticks = null; save(); render();
  },
  dClub:function(c){ U.dClub = c; render(); },
  friendYes:function(){ var f = U.pendingFriend; S.friends = S.friends.filter(function(x){ return x.id !== f.id; }); S.friends.push(f); U.pendingFriend = null; save(); render(); },
  friendNo:function(){ U.pendingFriend = null; render(); },
  share:function(){
    var url = location.origin + location.pathname + '#f=' + b64e(myCard()), text = S.me.name + '\'s Carry stats. Open in Carry to add me to your leaderboard.';
    if (navigator.share) navigator.share({title:'Carry', text:text, url:url}).catch(function(){});
    else if (navigator.clipboard) navigator.clipboard.writeText(url).then(function(){ toast('Link copied. Send it to your group.'); }, function(){ prompt('Copy this link', url); });
    else prompt('Copy this link', url);
  },
  backup:function(){
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(S)], {type:'application/json'}));
    a.download = 'carry-backup-' + isoDate(Date.now()) + '.json'; a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); }, 5000);
  }
};
var INP = {
  bagName:function(i, v){ U.bagDraft[+i].name = v; },
  bagYd:function(i, v){ U.bagDraft[+i].stock = v; },
  myName:function(i, v){ S.me.name = v.trim().slice(0, 30); save(); var b = document.querySelector('[data-act="share"]'); if (b) b.disabled = !S.me.name; }
};
document.addEventListener('click', function(e){
  var el = e.target.closest('[data-act]'); if (!el || el.disabled) return;
  var f = ACT[el.dataset.act]; if (f){ e.preventDefault(); f(el.dataset.arg, el); }
});
document.addEventListener('input', function(e){ var el = e.target; if (el.dataset && INP[el.dataset.in]) INP[el.dataset.in](el.dataset.arg, el.value); });
document.addEventListener('keydown', function(e){ if (e.key === 'Enter' && e.target.id === 'q') ACT.search(); });
window.addEventListener('hashchange', function(){ readHash(); if (U.pendingFriend && S.onboarded) go('friends'); });

/* ---------- boot ---------- */
store.open().then(function(){ return store.get(); }).then(function(st){
  if (st && st.v === 1) S = Object.assign(defaults(), st);
  booted = true;
  readHash();
  U.screen = !S.onboarded ? 'onb1' : U.pendingFriend ? 'friends' : roundHome();
  if (S.onboarded || active()) startGPS();
  render();
}).catch(function(){ booted = true; render(); });
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(function(){});
window.__carry = {S:function(){ return S; }, U:U, render:render, go:go}; // for testing
})();
