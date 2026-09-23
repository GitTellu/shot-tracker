/* Carry: geometry and course data.
   distM, toXY/fromXY, the ring helpers and osmConvert are ported from Shot Tracker (../index.html)
   so both apps measure a course the same way. */
(function(){
'use strict';

var M_PER_YD = 0.9144;                 // exact, by definition
var WGS84_A = 6378137;                 // semi-major axis (m)
var WGS84_F = 1 / 298.257223563;       // flattening
var WGS84_E2 = WGS84_F * (2 - WGS84_F);

function yd(m){ return m / M_PER_YD; }

/* Distance on the WGS84 ellipsoid using local radii of curvature at the mean latitude.
   For golf-scale distances (< 1 km) this matches a full geodesic to well under a centimetre. */
function distM(a, b){
  var phi = (a.lat + b.lat) / 2 * Math.PI / 180;
  var s = Math.sin(phi), w = 1 - WGS84_E2 * s * s;
  var Mr = WGS84_A * (1 - WGS84_E2) / Math.pow(w, 1.5);
  var Nr = WGS84_A / Math.sqrt(w);
  var dy = (b.lat - a.lat) * Math.PI / 180 * Mr;
  var dx = (b.lng - a.lng) * Math.PI / 180 * Nr * Math.cos(phi);
  return Math.hypot(dx, dy);
}
function distYd(a, b){ return yd(distM(a, b)); }

function radii(lat){ var phi = lat * Math.PI / 180, s = Math.sin(phi), w = 1 - WGS84_E2 * s * s; return {M:WGS84_A * (1 - WGS84_E2) / Math.pow(w, 1.5), N:WGS84_A / Math.sqrt(w), c:Math.cos(phi)}; }
function toXY(o, p){ var k = radii(o.lat), d = Math.PI / 180; return {x:(p.lng - o.lng) * d * k.N * k.c, y:(p.lat - o.lat) * d * k.M}; }
function fromXY(o, x, y){ var k = radii(o.lat), d = Math.PI / 180; return {lat:o.lat + y / k.M / d, lng:o.lng + x / (k.N * k.c) / d}; }
/* compass bearing from a to b, degrees clockwise from north */
function bearingDeg(a, b){ var A = toXY(a, b); return (Math.atan2(A.x, A.y) * 180 / Math.PI + 360) % 360; }

/* Where end sits against the line start -> aim, in yards: side (right +) and along (from start). */
function offLine(start, aim, end){
  var A = toXY(start, aim), E = toXY(start, end), R = Math.hypot(A.x, A.y); if (R < 1) return null;
  var ux = A.x / R, uy = A.y / R;
  return {side:yd(E.x * uy - E.y * ux), along:yd(E.x * ux + E.y * uy), aim:yd(R)};
}

function llOf(p){ return {lat:p[0], lng:p[1]}; }
function lastOf(a){ return a[a.length - 1]; }
function plural(n, one, many){ return n + ' ' + (n === 1 ? one : (many || one + 's')); }
/* Overpass geometry to [[lat,lng],...], dropping vertices under a metre apart (and, for an
   outline, the closing vertex that repeats the first). */
function llPath(geom, closed){
  var out = [];
  geom.forEach(function(g){
    if (!g || g.lat == null) return;
    var p = [+g.lat.toFixed(6), +g.lon.toFixed(6)];
    if (!out.length || distM(llOf(lastOf(out)), llOf(p)) >= 1) out.push(p);
  });
  if (closed && out.length > 3 && distM(llOf(out[0]), llOf(lastOf(out))) < 1) out.pop();
  return out;
}
/* A multipolygon's outer edge can arrive as several open ways; join them end to end into rings. */
function joinRings(paths){
  var segs = paths.filter(function(p){ return p.length >= 2; }).map(function(p){ return p.slice(); }), rings = [];
  function same(a, b){ return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6; }
  while (segs.length){
    var ring = segs.shift(), grew = true;
    while (grew && !same(ring[0], lastOf(ring))){
      grew = false;
      for (var i = 0; i < segs.length; i++){
        var s = segs[i];
        if (same(lastOf(ring), s[0])) ring = ring.concat(s.slice(1));
        else if (same(lastOf(ring), lastOf(s))) ring = ring.concat(s.slice(0, -1).reverse());
        else continue;
        segs.splice(i, 1); grew = true; break;
      }
    }
    if (ring.length > 3 && same(ring[0], lastOf(ring))) ring.pop();
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}
function ringXY(o, ring){ return ring.map(function(p){ return toXY(o, llOf(p)); }); }
function ptInRing(pt, ring){
  var P = ringXY(pt, ring), inside = false;
  for (var i = 0, j = P.length - 1; i < P.length; j = i++){
    var a = P[i], b = P[j];
    if ((a.y > 0) !== (b.y > 0) && 0 < (b.x - a.x) * (0 - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function segOff(a, b){ // distance from the origin to segment ab, and how far along it the nearest point is
  var dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  var t = l2 ? Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / l2)) : 0;
  return {d:Math.hypot(a.x + t * dx, a.y + t * dy), t:t, len:Math.sqrt(l2)};
}
function distToRing(pt, ring){
  if (ptInRing(pt, ring)) return 0;
  var P = ringXY(pt, ring), best = Infinity;
  for (var i = 0; i < P.length; i++) best = Math.min(best, segOff(P[i], P[(i + 1) % P.length]).d);
  return best;
}
function ringCentroid(ring){
  var o = llOf(ring[0]), P = ringXY(o, ring), a = 0, cx = 0, cy = 0;
  for (var i = 0; i < P.length; i++){
    var p = P[i], q = P[(i + 1) % P.length], k = p.x * q.y - q.x * p.y;
    a += k; cx += (p.x + q.x) * k; cy += (p.y + q.y) * k;
  }
  var c;
  if (Math.abs(a) < 1e-6){ cx = 0; cy = 0; P.forEach(function(p){ cx += p.x; cy += p.y; }); c = fromXY(o, cx / P.length, cy / P.length); }
  else c = fromXY(o, cx / (3 * a), cy / (3 * a));
  return {lat:+c.lat.toFixed(7), lng:+c.lng.toFixed(7)};
}
/* Where a point sits against a hole's line of play: off = metres from the line, along = metres
   from the tee end to the nearest point on it, total = the line's length. */
function lineInfo(pt, line){
  var P = ringXY(pt, line), best = {off:Infinity, along:0}, run = 0;
  for (var i = 0; i < P.length - 1; i++){
    var s = segOff(P[i], P[i + 1]);
    if (s.d < best.off) best = {off:s.d, along:run + s.t * s.len};
    run += s.len;
  }
  best.total = run;
  return best;
}
function pointAlong(line, d){
  for (var i = 0; i < line.length - 1; i++){
    var a = llOf(line[i]), b = llOf(line[i + 1]), l = distM(a, b);
    if (d <= l || i === line.length - 2){ var B = toXY(a, b), t = l ? Math.min(1, Math.max(0, d / l)) : 0; return fromXY(a, B.x * t, B.y * t); }
    d -= l;
  }
  return llOf(line[0]);
}
function lineLenM(line){ var t = 0; for (var i = 0; i < line.length - 1; i++) t += distM(llOf(line[i]), llOf(line[i + 1])); return t; }
function teeTag(t){ return t.name || t.tee || t.colour || t['tee:colour'] || null; }
function teeDefaultLabel(i, n){ return n === 1 ? 'Tee' : n === 2 ? ['Back', 'Forward'][i] : n === 3 ? ['Back', 'Middle', 'Forward'][i] : 'Tee ' + (i + 1); }

/* Overpass elements -> {holes:{n:{line, green, gc, par, si, tees, hz}}, probs, counts}.
   ref names the golf course picked, so holes of a course next door can be told apart. */
function osmConvert(els, ref){
  var probs = [];
  var course = els.filter(function(e){ return e.tags && e.tags.leisure === 'golf_course' && (!ref || (e.type === ref.type && e.id === ref.id)); })[0] || null;
  var bounds = [];
  if (course && course.type === 'way' && course.geometry) bounds = [llPath(course.geometry, true)];
  else if (course && course.members) bounds = joinRings(course.members.filter(function(m){ return m.role === 'outer' && m.geometry; }).map(function(m){ return llPath(m.geometry, false); }));
  bounds = bounds.filter(function(r){ return r.length >= 3; });
  function inCourse(p){ return !bounds.length || bounds.some(function(r){ return ptInRing(p, r); }); }
  var ways = els.filter(function(e){ return e.type === 'way' && e.tags && e.geometry && e.geometry.length; });
  function areas(test){
    return ways.filter(function(e){ return test(e.tags); })
      .map(function(e){ return {id:e.id, tags:e.tags, p:llPath(e.geometry, true)}; })
      .filter(function(a){ return a.p.length >= 3; });
  }
  var greens = areas(function(t){ return t.golf === 'green'; });
  var tees = areas(function(t){ return t.golf === 'tee'; }).map(function(a){ a.c = ringCentroid(a.p); return a; })
    .concat(els.filter(function(e){ return e.type === 'node' && e.tags && e.tags.golf === 'tee' && e.lat != null; })
      .map(function(e){ return {id:e.id, tags:e.tags, p:null, c:{lat:e.lat, lng:e.lon}}; }));
  var bunkers = areas(function(t){ return t.golf === 'bunker'; });
  var water = areas(function(t){ return t.golf === 'water_hazard' || t.golf === 'lateral_water_hazard' || t.natural === 'water' || !!t.water; });
  var fairways = areas(function(t){ return t.golf === 'fairway'; });

  var all = ways.filter(function(e){ return e.tags.golf === 'hole' && e.geometry.length >= 2; })
    .map(function(e){ return {id:e.id, n:parseInt(e.tags.ref, 10), tags:e.tags, line:llPath(e.geometry, false)}; })
    .filter(function(h){ return h.line.length >= 2; });
  var unnumbered = all.filter(function(h){ return !(h.n >= 1 && h.n <= 36); }).length;
  if (unnumbered) probs.push(plural(unnumbered, 'hole line has', 'hole lines have') + ' no hole number, so ' + (unnumbered === 1 ? 'it was' : 'they were') + ' left out.');
  var numbered = all.filter(function(h){ return h.n >= 1 && h.n <= 36; });
  var mine = numbered.filter(function(h){ return inCourse(llOf(h.line[Math.floor(h.line.length / 2)])); });
  if (!mine.length && numbered.length){ mine = numbered; probs.push('None of the holes sit inside the course outline, so all of them were used.'); }
  else if (mine.length < numbered.length) probs.push(plural(numbered.length - mine.length, 'hole') + ' belonging to a neighbouring course ' + (numbered.length - mine.length === 1 ? 'was' : 'were') + ' left out.');
  var byN = {}, holes = [];
  mine.forEach(function(h){
    if (byN[h.n]){ if (byN[h.n] === 1) probs.push('Hole ' + h.n + ' is mapped more than once; the first one was used.'); byN[h.n]++; return; }
    byN[h.n] = 1; holes.push(h);
  });
  holes.sort(function(a, b){ return a.n - b.n; });

  // a hole line is meant to run tee to green, but not every mapper draws it that way round
  function greenGap(p){ var b = Infinity; greens.forEach(function(g){ b = Math.min(b, distToRing(p, g.p)); }); return b; }
  holes.forEach(function(h){ if (greenGap(llOf(h.line[0])) < greenGap(llOf(lastOf(h.line)))) h.line.reverse(); });
  var claimed = {};
  holes.forEach(function(h){
    var end = llOf(lastOf(h.line)), g = greens.filter(function(x){ return !claimed[x.id] && ptInRing(end, x.p); })[0];
    if (g){ h.green = g; claimed[g.id] = true; }
  });
  holes.forEach(function(h){
    if (h.green) return;
    var end = llOf(lastOf(h.line)), best = null, bd = 25;
    greens.forEach(function(g){ if (claimed[g.id]) return; var d = distToRing(end, g.p); if (d < bd){ bd = d; best = g; } });
    if (best){ h.green = best; claimed[best.id] = true; }
    else probs.push('Hole ' + h.n + ': no green is mapped at the end of the hole, so distances measure to the end of the hole line.');
  });
  // a tee box belongs to the hole it sits on the back end of
  var teesUsed = 0;
  tees.forEach(function(t){
    var best = null, bo = 40;
    holes.forEach(function(h){
      var li = lineInfo(t.c, h.line);
      if (li.along <= Math.max(0.55 * li.total, 1) && li.off < bo){ bo = li.off; best = h; }
    });
    if (best){ (best.tees = best.tees || []).push(t); teesUsed++; }
  });
  function nearestHole(a, reach){
    var c = ringCentroid(a.p), best = null, bd = reach;
    holes.forEach(function(h){
      var d = lineInfo(c, h.line).off;
      for (var i = 0; i < a.p.length && d > 0; i += Math.max(1, Math.floor(a.p.length / 40))) d = Math.min(d, lineInfo(llOf(a.p[i]), h.line).off);
      if (d < bd){ bd = d; best = h; }
    });
    return best;
  }
  var nb = 0, nw = 0;
  bunkers.forEach(function(a){ var h = nearestHole(a, 60); if (h){ (h.hz = h.hz || []).push({k:'bunker', p:a.p}); nb++; } });
  water.forEach(function(a){ var h = nearestHole(a, 60); if (h){ (h.hz = h.hz || []).push({k:'water', p:a.p}); nw++; } });
  // fairways belong to the hole whose line runs through them; Carry reads them to tell a hit fairway from a miss
  fairways.forEach(function(a){ var h = nearestHole(a, 30); if (h) (h.fw = h.fw || []).push(a.p); });

  var out = {}, pars = 0, gn = 0;
  holes.forEach(function(h){
    var gc = h.green ? ringCentroid(h.green.p) : null, end = gc || llOf(lastOf(h.line));
    var par = parseInt(h.tags.par, 10), si = parseInt(h.tags.handicap, 10);
    var ts = (h.tees || []).sort(function(a, b){ return distM(b.c, end) - distM(a.c, end); });
    if (par >= 3 && par <= 6) pars++; else par = null;
    if (gc) gn++;
    out[h.n] = {line:h.line, green:h.green ? h.green.p : null, gc:gc, par:par, si:si >= 1 && si <= 18 ? si : null,
      tees:ts.map(function(t, i){ return {id:'o' + t.id, label:teeTag(t.tags) || teeDefaultLabel(i, ts.length), c:[+t.c.lat.toFixed(7), +t.c.lng.toFixed(7)]}; }),
      hz:h.hz || [], fw:h.fw || []};
  });
  var nums = holes.map(function(h){ return h.n; }), top = nums.length ? Math.max.apply(null, nums) : 0, missing = [];
  for (var n = 1; n <= top; n++) if (!byN[n] || holes.every(function(h){ return h.n !== n; })) missing.push(n);
  if (missing.length) probs.unshift('Not in the map: ' + (missing.length === 1 ? 'hole ' : 'holes ') + missing.join(', ') + '.');
  if (holes.length && pars < holes.length) probs.push('Par is mapped for ' + pars + ' of ' + holes.length + ' holes. Set the rest on the scorecard.');
  return {name:course && course.tags ? (course.tags.name || '') : '', holes:out, probs:probs,
    counts:{holes:holes.length, greens:gn, tees:teesUsed, pars:pars, bunkers:nb, water:nw, nums:nums}};
}

/* Front, centre and back from where you stand: where your own line to the centre crosses the
   mapped green's edge, near and far. Null front/back when there is no outline to measure. */
function fcb(from, hole){
  var g = hole && greenPt(hole); if (!g || !from) return null;
  var out = {c:distYd(from, g), f:null, b:null};
  if (hole.green && ptInRing(g, hole.green)){
    if (ptInRing(from, hole.green)) return out;
    var P = ringXY(from, hole.green), G = toXY(from, g), L = Math.hypot(G.x, G.y); if (L < 1) return out;
    var ux = G.x / L, uy = G.y / L, ts = [];
    for (var i = 0; i < P.length; i++){
      var A = P[i], B = P[(i + 1) % P.length], dx = B.x - A.x, dy = B.y - A.y, den = ux * dy - uy * dx;
      if (Math.abs(den) < 1e-9) continue;
      var t = (A.x * dy - A.y * dx) / den, s = (A.x * uy - A.y * ux) / den;
      if (s >= 0 && s <= 1 && t > 0) ts.push(t);
    }
    if (ts.length >= 2){ out.f = yd(Math.min.apply(null, ts)); out.b = yd(Math.max.apply(null, ts)); }
  }
  return out;
}
/* the point distances are measured to: the green's centre, or the end of the hole line when no green is mapped */
function greenPt(hole){ return hole.gc || (hole.line && hole.line.length ? llOf(lastOf(hole.line)) : null); }
function teePt(hole){ return hole.tees && hole.tees.length ? llOf(hole.tees[0].c) : (hole.line && hole.line.length ? llOf(hole.line[0]) : null); }
function onGreen(pt, hole){ return !!(hole && hole.green && pt && ptInRing(pt, hole.green)); }
function onFairway(pt, hole){ return !!(hole && hole.fw && pt && hole.fw.some(function(r){ return ptInRing(pt, r); })); }
function holeLenYd(hole){ return hole.line ? yd(lineLenM(hole.line)) : null; }

window.Geo = {M_PER_YD:M_PER_YD, yd:yd, distM:distM, distYd:distYd, toXY:toXY, fromXY:fromXY, bearingDeg:bearingDeg, offLine:offLine,
  llOf:llOf, ptInRing:ptInRing, lineInfo:lineInfo, pointAlong:pointAlong, osmConvert:osmConvert, fcb:fcb,
  greenPt:greenPt, teePt:teePt, onGreen:onGreen, onFairway:onFairway, holeLenYd:holeLenYd, plural:plural};
})();
