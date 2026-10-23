// The mission planner: a departure burn the pilot sizes and aims, a coast, and the landing autopilot at the brake altitude.
// The same code flies the preview in the browser and the official flight on the server.
//
//   aim    the launch direction, in degrees from the planet's direction of travel: the rocket sits on that side of the
//          planet and the departure burn pushes straight out from there
//   s1     the departure burn's share of the tank, the pilot's call (at least enough to clear the home planet)
//   brake  altitude, in target radii, at which the landing autopilot takes over
//
// makeController must stay self-contained: its source is shipped into the sandbox as text.
function makeController(world, P) {
  var sun = world.sun, bodies = world.bodies, rocket = world.rocket;
  var A = bodies[world.start], B = bodies[world.target];
  var wait = +P.wait || 0, s1 = Math.max(0, Math.min(0.9, +P.s1 || 0.35)) * rocket.fuel;
  var brake = Math.max(0.05, +P.brake || 1);
  var gB = B.mass / (B.radius * B.radius), aT = rocket.maxThrust, safe = world.safeLandingSpeed;
  var phase = 'pad';
  return function controller(s) {
    var sa = s.bodies[world.start], sb = s.bodies[world.target];
    var ax0 = s.x - sa.x, ay0 = s.y - sa.y, da = Math.hypot(ax0, ay0) || 1e-9, upx = ax0 / da, upy = ay0 / da;
    var bx0 = sb.x - s.x, by0 = sb.y - s.y, db = Math.hypot(bx0, by0) || 1e-9, alt = db - B.radius;
    var rvx = s.vx - sb.vx, rvy = s.vy - sb.vy, rv = Math.hypot(rvx, rvy);
    if (phase === 'pad') { if (s.t < wait) return { throttle: 0, dx: upx, dy: upy }; phase = 'stage1'; }
    if (phase === 'stage1') {
      // first stage, automated: full thrust straight out from the launch spot until its share of the tank is spent
      if (rocket.fuel - s.fuel >= s1) phase = 'coast';
      else return { throttle: 1, dx: upx, dy: upy };
    }
    if (alt > B.radius * brake) return { throttle: 0, dx: s.vx, dy: s.vy };
    var dnx = bx0 / db, dny = by0 / db;
    // braking zone: fall as fast as we could still stop from, and no faster
    var allow = Math.max(safe * 0.8, 0.85 * Math.sqrt(2 * Math.max(0.01, aT - gB) * Math.max(alt, 0)));
    if (rv > allow) return { throttle: 1, dx: -rvx, dy: -rvy };
    return { throttle: 0, dx: dnx, dy: dny };
  };
}

// The textbook plan for a world: the Hohmann window and burn, straight ahead, brake at one radius.
function textbook(world) {
  var sun = world.sun, A = world.bodies[world.start], B = world.bodies[world.target];
  var a = (A.orbitR + B.orbitR) / 2, tH = Math.PI * Math.sqrt(a * a * a / sun.mass);
  var need = Math.PI - B.omega * tH, dw = B.omega - A.omega, synodic = 2 * Math.PI / Math.abs(dw);
  var phase0 = B.angle0 - A.angle0;
  var w0 = (((need - phase0) / dw) % synodic + synodic) % synodic;
  var latest = A.period;   // you may wait up to one full orbit of your home planet
  var inner = world.sun.radius * 2, outer = world.bodies[world.bodies.length - 1].orbitR * 1.3;
  return { wait: Math.min(w0, latest), reach: B.orbitR, aim: 0, brake: 1.0, latest: latest, transfer: tH, synodic: synodic, reachMin: B.orbitR > A.orbitR ? A.orbitR : inner, reachMax: B.orbitR > A.orbitR ? outer : A.orbitR, outward: B.orbitR > A.orbitR };
}

// Dials clamped to their ranges; this is the only thing a player can submit.
function clean(world, P) {
  var tb = textbook(world), n = function (v, lo, hi, d) { v = +v; return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  P = P || {};
  return { wait: +n(P.wait, 0, tb.latest, tb.wait).toFixed(3), s1: +(P.exact ? n(P.s1, 0, 0.71, 0.35) : Math.round(n(P.s1, 0, 0.7, 0.35) * 20) / 20).toFixed(3), aim: +(((n(P.aim, -1e9, 1e9, 0) % 360) + 360) % 360).toFixed(1), brake: +n(P.brake, 0.1, 4, 1).toFixed(2) };
}

// Source of a sandbox bot that flies the plan: a function of (world, sim) returning the controller.
function botSource(world, P) {
  return 'function bot(world, sim){ return (' + makeController.toString() + ')(world, ' + JSON.stringify(clean(world, P)) + '); }';
}

// The shared sky clock. Sky time runs at the live rate, except inside a burn window, where it runs SLOW times slower
// for everyone: every burn of the day is a moment the whole sky lingers on. Windows are absolute sky times, merged and
// sorted; both directions of the mapping are needed (when is liftoff, in real time?).
var SLOW = 0.015;
function skyClock(startMs, rate, windows, slow) {
  slow = slow || SLOW; windows = windows || [];
  return {
    sky: function (ms) {
      var r = startMs, s = 0; if (ms <= startMs) return 0;
      for (var i = 0; i < windows.length; i++) {
        var a = windows[i][0], b = windows[i][1]; if (b <= s) continue;
        if (a > s) { var dr = (a - s) / rate * 1000; if (r + dr >= ms) return s + (ms - r) / 1000 * rate; r += dr; s = a; }
        var dw = (b - s) / (rate * slow) * 1000; if (r + dw >= ms) return s + (ms - r) / 1000 * rate * slow; r += dw; s = b;
      }
      return s + (ms - r) / 1000 * rate;
    },
    real: function (t) {
      var r = startMs, s = 0; if (t <= 0) return startMs;
      for (var i = 0; i < windows.length; i++) {
        var a = windows[i][0], b = windows[i][1]; if (b <= s) continue;
        if (a > s) { if (t <= a) return r + (t - s) / rate * 1000; r += (a - s) / rate * 1000; s = a; }
        if (t <= b) return r + (t - s) / (rate * slow) * 1000; r += (b - s) / (rate * slow) * 1000; s = b;
      }
      return r + (t - s) / rate * 1000;
    }
  };
}
// The burn windows of a flight, from its samples: runs of thrust, with the landing burn's short pulses merged into one.
function burnWindows(S, gap) {
  gap = gap || 0.1; var out = [], cur = null;
  for (var i = 0; i < S.length; i++) { var on = S[i][5] > 0, t = S[i][0]; if (on) { if (!cur) cur = [t, t]; else cur[1] = t; } else if (cur && t - cur[1] > gap) { out.push(cur); cur = null; } }
  if (cur) out.push(cur);
  return mergeWindows(out, gap);
}
// The slow-motion windows of a day from its clock events ({t: t_start, b: burn windows}): each burn is a short moment,
// so a long landing burn only slows the sky for its first stretch.
var SLOW_CAP = 0.2, SLOW_CAP_LATER = 0.05;   // the departure burn gets the long, slow moment; landing burns a shorter one
function slowWindows(events) {
  var out = [];
  for (var i = 0; i < events.length; i++) { var e = events[i], t = +e.t || 0, b = e.b || []; for (var j = 0; j < b.length; j++) out.push([t + b[j][0], Math.min(t + b[j][1], t + b[j][0] + (j === 0 ? SLOW_CAP : SLOW_CAP_LATER))]); }
  return mergeWindows(out);
}
function mergeWindows(list, gap) {
  gap = gap || 0; var w = list.slice().sort(function (p, q) { return p[0] - q[0]; }), out = [];
  for (var i = 0; i < w.length; i++) { var last = out[out.length - 1]; if (last && w[i][0] <= last[1] + gap) last[1] = Math.max(last[1], w[i][1]); else out.push([w[i][0], w[i][1]]); }
  return out;
}
// The live sky: the innermost planet goes round once every 10 real seconds. A flight starts from the
// sky as it looked when the launch was claimed, so the planets' starting angles are shifted by that moment.
function liveRate(world) { return world.bodies[0].period / 10; }
function worldAt(world, t0) {
  if (!(t0 > 0)) return world;
  var w = Object.assign({}, world); w.bodies = world.bodies.map(function (b) { var c = Object.assign({}, b); c.angle0 = b.angle0 + b.omega * t0; return c; });
  return w;
}
// The world a flight is scored in: shifted to its start, with enough clock for a full-orbit wait plus the trip.
function flightWorld(world, t0, P, engine) {
  var w = Object.assign({}, worldAt(world, t0)), A = world.bodies[world.start];
  if (P && isFinite(+P.aim)) { var A0 = w.bodies[world.start], travel = A0.angle0 + Math.PI / 2;
    w.rocket = Object.assign({}, world.rocket, { padAngle: travel + clean(world, P).aim * Math.PI / 180 }); }
  // max flight time: two and a half textbook transfers, then the flight is out of time
  var tH = world.hints && world.hints.transferTime ? world.hints.transferTime : world.deadline / 2;
  w.deadline = FLIGHT_DAYS;
  return w;
}
// How many flight days a launch gets before it is out of time.
// Every flight has the same time limit, whatever the system.
var FLIGHT_DAYS = 20;
function flightDays(world) { return FLIGHT_DAYS; }
// The thrust direction (a world angle, also the launch spot) whose post-burn heading is the dialled aim.
// Found by test-flying just the burn a few times and nudging the thrust angle by the heading error.
function resolveAim(w, travel, P, engine) {
  var Pc = clean(w, P), want = travel + Pc.aim * Math.PI / 180;
  var dur = Pc.s1 * w.rocket.fuel / w.rocket.maxThrust + 0.6, short = Object.assign({}, w, { deadline: Math.min(w.deadline, dur) });
  var headingFor = function (thrust) {
    var t = Object.assign({}, short, { rocket: Object.assign({}, w.rocket, { padAngle: thrust }) });
    var r = engine.fly(t, makeController(t, Pc), { record: true }), S = r.samples;
    for (var i = 1; i < S.length; i++) if (S[i-1][5] > 0 && S[i][5] === 0) return Math.atan2(S[i][4], S[i][3]);
    return null;
  };
  var err = function (thrust) { var h = headingFor(thrust); if (h == null) return Math.PI; var d = want - h; return Math.abs(Math.atan2(Math.sin(d), Math.cos(d))); };
  // scan the whole circle of thrust directions, then narrow in on the one whose heading lands closest to the aim
  var best = travel, bestErr = Infinity, n = 24, step = 2 * Math.PI / n;
  for (var k = 0; k < n; k++) { var th = travel + k * step, ev = err(th); if (ev < bestErr) { bestErr = ev; best = th; } }
  var lo = best - step, hi = best + step;
  for (var j = 0; j < 7; j++) { var m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; if (err(m1) < err(m2)) hi = m2; else lo = m1; }
  return (lo + hi) / 2;
}
// The automated first stage's share of the tank: the least that clears the home planet, plus a little, on the 5% grid.
function stage1(world, engine) { return Math.min(0.7, Math.ceil((minBurn(world, engine) + 0.03) * 20) / 20); }
// Is this system landable with the dials? A coarse sweep; the daily generator skips days that fail it.
function landable(world, engine) {
  var A = world.bodies[world.start], B = world.bodies[world.target], landed = 0, hits = 0, floor = stage1(world, engine);
  var burns = [0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6].filter(function (b) { return b >= floor - 1e-9; }), brakes = [0.6, 1.0, 1.6, 2.4];
  for (var ti = 0; ti < 8; ti++) for (var ai = 0; ai < 24; ai++) for (var bi = 0; bi < burns.length; bi++) for (var ki = 0; ki < brakes.length; ki++) {
    var t0 = A.period * ti / 8, P = { wait: 0, s1: burns[bi], aim: ai * 15, brake: brakes[ki] }, fw = flightWorld(world, t0, P);   // raw thrust direction first: cheap
    var r = engine.fly(fw, makeController(fw, P), {});
    if (r.outcome === 'crashed' && r.body === B.name) hits++;
    if (r.outcome !== 'landed') continue;
    landed++; if (landed >= 3) return { ok: true, landed: landed, hits: hits, floor: floor };
  }
  return { ok: false, landed: landed, hits: hits, floor: floor };
}
// The least thrust that still carries the rocket clear of its home planet (otherwise it falls straight back).
function minBurn(world, engine) {
  var A = world.bodies[world.start], w = Object.assign({}, world, { deadline: Math.min(world.deadline, A.period * 0.6) });
  var clears = function (b) { var P = { wait: 0, s1: b, aim: 0, brake: 1 }, r = engine.fly(w, makeController(w, P), { record: true }), S = r.samples, far = 0;
    for (var i = 0; i < S.length; i += 3) { var bp = engine.bodyAt(w, world.start, S[i][0]), d = Math.hypot(S[i][1] - bp.x, S[i][2] - bp.y); if (d > far) far = d; }
    return far > A.hill * 1.5 && !(r.outcome === 'crashed' && r.body === A.name); };
  var lo = 0.02, hi = 0.7; if (!clears(hi)) return hi;
  for (var k = 0; k < 9; k++) { var mid = (lo + hi) / 2; if (clears(mid)) hi = mid; else lo = mid; }
  return +(hi + 0.01).toFixed(3);
}
if (typeof module !== 'undefined' && module.exports) module.exports = { makeController: makeController, textbook: textbook, clean: clean, botSource: botSource, liveRate: liveRate, worldAt: worldAt, flightWorld: flightWorld, landable: landable, minBurn: minBurn, resolveAim: resolveAim, stage1: stage1, flightDays: flightDays, skyClock: skyClock, burnWindows: burnWindows, mergeWindows: mergeWindows, slowWindows: slowWindows, SLOW: SLOW };
if (typeof window !== 'undefined') window.LanderPlan = { makeController: makeController, textbook: textbook, clean: clean, botSource: botSource, liveRate: liveRate, worldAt: worldAt, flightWorld: flightWorld, landable: landable, minBurn: minBurn, resolveAim: resolveAim, stage1: stage1, flightDays: flightDays, skyClock: skyClock, burnWindows: burnWindows, mergeWindows: mergeWindows, slowWindows: slowWindows, SLOW: SLOW };
