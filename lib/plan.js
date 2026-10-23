// The mission planner: one autopilot, four dials. The same code flies the preview in the
// browser and the official flight on the server, so what you see is what you get.
//
//   wait   launch time, in time units from the start of the day
//   burn   share of the fuel tank to spend on the one launch burn, straight out from the launch spot, from the pad
//   aim    where on the home planet the rocket sits, in degrees from the planet's direction of travel; it climbs straight out from there and keeps burning that way
//   brake  altitude, in target radii, at which the landing autopilot takes over
//
// makeController must stay self-contained: its source is shipped into the sandbox as text.
function makeController(world, P) {
  var sun = world.sun, bodies = world.bodies, rocket = world.rocket;
  var A = bodies[world.start], B = bodies[world.target];
  var outward = B.orbitR > A.orbitR, sgn = outward ? 1 : -1;
  var wait = +P.wait || 0, burn = Math.max(0, Math.min(0.95, +P.burn || 0)) * rocket.fuel, brake = Math.max(0.05, +P.brake || 1);
  var vEsc = Math.sqrt(2 * A.mass / A.radius), gB = B.mass / (B.radius * B.radius), aT = rocket.maxThrust, safe = world.safeLandingSpeed;
  var phase = 'pad';
  return function controller(s) {
    var sa = s.bodies[world.start], sb = s.bodies[world.target];
    var ax0 = s.x - sa.x, ay0 = s.y - sa.y, da = Math.hypot(ax0, ay0) || 1e-9, upx = ax0 / da, upy = ay0 / da;
    var relA = Math.hypot(s.vx - sa.vx, s.vy - sa.vy);
    var bx0 = sb.x - s.x, by0 = sb.y - s.y, db = Math.hypot(bx0, by0) || 1e-9, alt = db - B.radius;
    if (phase === 'pad') { if (s.t < wait) return { throttle: 0, dx: upx, dy: upy }; phase = 'burn'; }
    if (phase === 'burn') {
      // one stage: full thrust straight out from the launch spot until the chosen share of the tank is spent
      if (rocket.fuel - s.fuel >= burn) phase = 'cruise';
      else return { throttle: 1, dx: upx, dy: upy };
    }
    var rvx = s.vx - sb.vx, rvy = s.vy - sb.vy, rv2 = rvx * rvx + rvy * rvy;
    // cruise: engine off, no corrections. The path is whatever the launch made it.
    if (alt > B.radius * brake) return { throttle: 0, dx: s.vx, dy: s.vy };
    var dnx = bx0 / db, dny = by0 / db, rv = Math.sqrt(rv2);
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
  return { wait: +n(P.wait, 0, tb.latest, tb.wait).toFixed(3), burn: +n(P.burn, 0, 0.7, 0.35).toFixed(3), aim: +(((n(P.aim, -1e9, 1e9, 0) % 360) + 360) % 360).toFixed(1), brake: +n(P.brake, 0.1, 4, 1).toFixed(2) };
}

// Source of a sandbox bot that flies the plan: a function of (world, sim) returning the controller.
function botSource(world, P) {
  return 'function bot(world, sim){ return (' + makeController.toString() + ')(world, ' + JSON.stringify(clean(world, P)) + '); }';
}

// The live sky: the innermost planet goes round once every 24 real seconds. A flight starts from the
// sky as it looked when the launch was claimed, so the planets' starting angles are shifted by that moment.
function liveRate(world) { return world.bodies[0].period / 24; }
function worldAt(world, t0) {
  if (!(t0 > 0)) return world;
  var w = Object.assign({}, world); w.bodies = world.bodies.map(function (b) { var c = Object.assign({}, b); c.angle0 = b.angle0 + b.omega * t0; return c; });
  return w;
}
// The world a flight is scored in: shifted to its start, with enough clock for a full-orbit wait plus the trip.
function flightWorld(world, t0, P) {
  var w = Object.assign({}, worldAt(world, t0)), A = world.bodies[world.start];
  if (P && isFinite(+P.aim)) { var A0 = w.bodies[world.start]; w.rocket = Object.assign({}, world.rocket, { padAngle: A0.angle0 + Math.PI / 2 + clean(world, P).aim * Math.PI / 180 }); }   // measured from the direction of travel at launch
  // max flight time: six textbook transfers, then the flight is out of time
  var tH = world.hints && world.hints.transferTime ? world.hints.transferTime : world.deadline / 2;
  w.deadline = +(tH * 6 + 2).toFixed(1);
  return w;
}
// Is this system landable with the dials? A coarse sweep; the daily generator skips days that fail it.
function landable(world, engine) {
  var A = world.bodies[world.start], B = world.bodies[world.target], landed = 0, hits = 0;
  for (var ti = 0; ti < 12; ti++) for (var ai = 0; ai < 36; ai++) for (var bi = 0; bi < 4; bi++) {
    var P = { wait: 0, burn: [0.28, 0.35, 0.42, 0.5][bi], aim: ai * 10, brake: 1 }, fw = flightWorld(world, A.period * ti / 12, P);
    var r = engine.fly(fw, makeController(fw, P), {});
    if (r.outcome === 'landed') landed++; else if (r.outcome === 'crashed' && r.body === B.name) hits++;
    if (landed >= 3) return { ok: true, landed: landed, hits: hits };
  }
  return { ok: landed >= 2 && hits + landed >= 6, landed: landed, hits: hits };
}
// The least thrust that still carries the rocket clear of its home planet (otherwise it falls straight back).
function minBurn(world, engine) {
  var A = world.bodies[world.start], w = Object.assign({}, world, { deadline: Math.min(world.deadline, A.period * 0.6) });
  var clears = function (b) { var P = { wait: 0, burn: b, aim: 0, brake: 1 }, r = engine.fly(w, makeController(w, P), { record: true }), S = r.samples, far = 0;
    for (var i = 0; i < S.length; i += 3) { var bp = engine.bodyAt(w, world.start, S[i][0]), d = Math.hypot(S[i][1] - bp.x, S[i][2] - bp.y); if (d > far) far = d; }
    return far > A.hill * 1.5 && !(r.outcome === 'crashed' && r.body === A.name); };
  var lo = 0.02, hi = 0.7; if (!clears(hi)) return hi;
  for (var k = 0; k < 9; k++) { var mid = (lo + hi) / 2; if (clears(mid)) hi = mid; else lo = mid; }
  return +(hi + 0.01).toFixed(3);
}
if (typeof module !== 'undefined' && module.exports) module.exports = { makeController: makeController, textbook: textbook, clean: clean, botSource: botSource, liveRate: liveRate, worldAt: worldAt, flightWorld: flightWorld, landable: landable, minBurn: minBurn };
if (typeof window !== 'undefined') window.LanderPlan = { makeController: makeController, textbook: textbook, clean: clean, botSource: botSource, liveRate: liveRate, worldAt: worldAt, flightWorld: flightWorld, landable: landable, minBurn: minBurn };
