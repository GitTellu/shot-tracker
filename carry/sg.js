/* Carry: strokes gained and the round numbers built on it.
   A hole is {n, par, shots:[{lat,lng,acc,club,lie,t,aim?}], firstPutt (ft), putts, done}.
   Each shot is where the ball lay when it was hit; the next shot's spot is where it finished, and
   the last one finishes on the green at firstPutt feet (or in the hole when putts is 0). */
(function(){
'use strict';
var G = window.Geo;

/* The lies you pick in the app, as the baseline names them. Fringe is scored as fairway and
   Other as recovery; those two mappings are Carry's choice, not part of the source table. */
var LIE_KEY = {Tee:'tee', Fairway:'fairway', Rough:'rough', Bunker:'sand', Fringe:'fairway', Other:'recovery', Green:'green'};
var ARG_YD = 30;   // around the green: inside 30 yd and off the green, the usual strokes-gained split
var UD_YD = 50;    // an up-and-down chance starts from the first shot inside 50 yd

function table(){ var b = window.CARRY_BASELINE; return b && b.tee && b.green ? b : null; }
function ready(){ return !!table(); }
function label(){ var b = table(); return b ? (b.label || 'baseline') : null; }

function interp(rows, d){
  if (!rows || !rows.length) return null;
  if (d <= rows[0][0]) return rows[0][1];
  for (var i = 1; i < rows.length; i++){
    if (d <= rows[i][0]){ var a = rows[i - 1], b = rows[i]; return a[1] + (b[1] - a[1]) * (d - a[0]) / (b[0] - a[0]); }
  }
  return rows[rows.length - 1][1];
}
/* expected strokes to hole out: lie as the app names it, distance in yards (feet on the green) */
function expected(lie, d){
  var b = table(); if (!b || d == null) return null;
  return interp(b[LIE_KEY[lie] || 'rough'], d);
}

/* Everything about one hole that the screens need. course hole geometry gives the green. */
function holeFacts(h, geo){
  var gp = geo ? G.greenPt(geo) : null, n = h.shots.length;
  var starts = h.shots.map(function(s){ return {lie:s.lie, d:gp ? G.distYd(s, gp) : null}; });
  var holedOut = !!h.done;
  var shotSg = h.shots.map(function(s, i){
    if (!holedOut && i === n - 1) return null;   // where it finished is not known yet
    var st = starts[i], e0 = expected(st.lie, st.d); if (e0 == null) return null;
    var e1;
    if (i < n - 1) e1 = expected(starts[i + 1].lie, starts[i + 1].d);
    else e1 = h.putts > 0 ? expected('Green', h.firstPutt) : 0;
    return e1 == null ? null : e0 - e1 - 1;
  });
  var cat = h.shots.map(function(s, i){
    if (i === 0 && h.par >= 4) return 'ott';
    var d = starts[i].d;
    return d != null && d <= ARG_YD && s.lie !== 'Tee' ? 'arg' : 'app';
  });
  var putt = holedOut && h.putts > 0 ? expected('Green', h.firstPutt) : null;
  var psg = putt == null ? (holedOut && h.putts === 0 ? 0 : null) : putt - h.putts;
  var by = {ott:0, app:0, arg:0, putt:psg || 0}, known = psg != null || !holedOut;
  shotSg.forEach(function(v, i){ if (v == null){ if (holedOut) known = false; return; } by[cat[i]] += v; });
  var score = holedOut ? n + h.putts : null;
  // on the green (or in the hole) in n strokes: in regulation when that is par minus two or fewer
  var gir = holedOut && h.par ? n <= h.par - 2 : null;
  var fir = null;
  if (h.par >= 4 && n >= 2) fir = h.shots[1].lie === 'Fairway' ? 'hit' : (geo && geo.line ? sideOf(h.shots[1], geo) : 'miss');
  else if (h.par >= 4 && holedOut && n === 1) fir = 'hit';
  var ud = null;
  if (holedOut && gir === false){
    for (var j = 0; j < n; j++) if (j > 0 && starts[j].d != null && starts[j].d <= UD_YD){ ud = (n - j) + h.putts <= 2; break; }
  }
  return {score:score, starts:starts, shotSg:shotSg, cat:cat, psg:psg, by:by, sg:holedOut && known && ready() ? by.ott + by.app + by.arg + by.putt : null,
    fir:fir, gir:gir, ud:ud};
}
/* which side of the hole's line of play a missed tee shot finished on */
function sideOf(pt, geo){
  var line = geo.line, li = G.lineInfo(pt, line), a = G.pointAlong(line, Math.max(0, li.along - 5)), b = G.pointAlong(line, li.along + 5);
  var o = G.offLine(a, b, pt);
  return o ? (o.side < 0 ? 'left' : 'right') : 'miss';
}

/* One round: holes in play order, each with its facts, plus totals. */
function roundFacts(r, course){
  var holes = r.holes.map(function(h){ return {h:h, f:holeFacts(h, course && course.holes[h.n])}; });
  var played = holes.filter(function(x){ return x.h.done; });
  var t = {score:0, par:0, putts:0, fh:0, fn:0, gh:0, gn:0, uh:0, un:0, sg:0, sgKnown:ready() && played.length > 0,
    by:{ott:0, app:0, arg:0, putt:0}, cnt:{ott:0, app:0, arg:0, putt:0}, n:played.length};
  played.forEach(function(x){
    var f = x.f; t.score += f.score; t.par += x.h.par || 0; t.putts += x.h.putts;
    if (f.fir){ t.fn++; if (f.fir === 'hit') t.fh++; }
    if (f.gir != null){ t.gn++; if (f.gir) t.gh++; }
    f.cat.forEach(function(k){ t.cnt[k]++; }); if (x.h.putts) t.cnt.putt++;
    if (f.ud != null){ t.un++; if (f.ud) t.uh++; }
    if (f.sg == null) t.sgKnown = false; else { t.sg += f.sg; ['ott', 'app', 'arg', 'putt'].forEach(function(k){ t.by[k] += f.by[k]; }); }
  });
  return {holes:holes, t:t};
}

/* Strokes gained split by distance band, across rounds: where exactly a category leaks. */
var APP_BANDS = [[0, 100, 'Under 100 yd'], [100, 150, '100–150 yd'], [150, 200, '150–200 yd'], [200, 999, '200+ yd']];
var PUTT_BANDS = [[0, 5, '0–5 ft'], [5, 15, '6–15 ft'], [15, 30, '16–30 ft'], [30, 999, '30+ ft']];
function bands(rounds, courseOf){
  var app = APP_BANDS.map(function(b){ return {b:b, sg:0, n:0}; }), putt = PUTT_BANDS.map(function(b){ return {b:b, sg:0, n:0}; });
  rounds.forEach(function(r){
    var c = courseOf(r);
    r.holes.forEach(function(h){
      if (!h.done) return;
      var f = holeFacts(h, c && c.holes[h.n]);
      f.shotSg.forEach(function(v, i){
        if (v == null || f.cat[i] !== 'app') return;
        var d = f.starts[i].d; app.forEach(function(x){ if (d >= x.b[0] && d < x.b[1]){ x.sg += v; x.n++; } });
      });
      if (f.psg != null && h.putts > 0) putt.forEach(function(x){ if (h.firstPutt > x.b[0] && h.firstPutt <= x.b[1]){ x.sg += f.psg; x.n++; } });
    });
  });
  return {app:app, putt:putt};
}

window.SG = {ready:ready, label:label, expected:expected, holeFacts:holeFacts, roundFacts:roundFacts, bands:bands, APP_BANDS:APP_BANDS, PUTT_BANDS:PUTT_BANDS};
})();
