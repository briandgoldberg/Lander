// The mission planner: one autopilot, four dials. The same code flies the preview in the
// browser and the official flight on the server, so what you see is what you get.
//
//   wait   launch time, in time units from the start of the day
//   reach  how far from the star the transfer orbit should reach: the target's orbit, give or take
//   aim    injection burn direction, degrees off the home planet's direction of travel
//   brake  altitude, in target radii, at which the landing autopilot takes over
//
// makeController must stay self-contained: its source is shipped into the sandbox as text.
function makeController(world, P) {
  var sun = world.sun, bodies = world.bodies, rocket = world.rocket;
  var A = bodies[world.start], B = bodies[world.target];
  var outward = B.orbitR > A.orbitR, sgn = outward ? 1 : -1;
  var wait = +P.wait || 0, reach = +P.reach || B.orbitR, aim = (+P.aim || 0) * Math.PI / 180, brake = Math.max(0.05, +P.brake || 1);
  var vEsc = Math.sqrt(2 * A.mass / A.radius), gB = B.mass / (B.radius * B.radius), aT = rocket.maxThrust, safe = world.safeLandingSpeed;
  var phase = 'pad';
  return function controller(s) {
    var sa = s.bodies[world.start], sb = s.bodies[world.target];
    var ax0 = s.x - sa.x, ay0 = s.y - sa.y, da = Math.hypot(ax0, ay0) || 1e-9, upx = ax0 / da, upy = ay0 / da;
    var relA = Math.hypot(s.vx - sa.vx, s.vy - sa.vy);
    var bx0 = sb.x - s.x, by0 = sb.y - s.y, db = Math.hypot(bx0, by0) || 1e-9, alt = db - B.radius;
    if (phase === 'pad') { if (s.t < wait) return { throttle: 0, dx: upx, dy: upy }; phase = 'ascent'; }
    if (phase === 'ascent') { if (relA >= vEsc * 1.02) phase = 'clear'; else return { throttle: 1, dx: upx, dy: upy }; }
    if (phase === 'clear') { if (da > A.hill * 1.5) phase = 'inject'; else return { throttle: 0, dx: upx, dy: upy }; }
    if (phase === 'inject') {
      // burn along the orbit (or against it, going inward) until the orbit around the star reaches the dialled distance
      var r = Math.hypot(s.x, s.y), v2 = s.vx * s.vx + s.vy * s.vy, eps = v2 / 2 - sun.mass / r, h = s.x * s.vy - s.y * s.vx;
      var sma = -sun.mass / (2 * eps), ecc = Math.sqrt(Math.max(0, 1 + 2 * eps * h * h / (sun.mass * sun.mass)));
      var far = outward ? sma * (1 + ecc) : sma * (1 - ecc);
      var gap = outward ? (reach - far) / reach : (eps < 0 ? (far - reach) / reach : 1);
      if (gap <= 0) phase = 'cruise';
      else { var vx = sgn * sa.vx, vy = sgn * sa.vy, c = Math.cos(aim), sn = Math.sin(aim); return { throttle: Math.min(1, Math.max(0.05, gap * 15)), dx: vx * c - vy * sn, dy: vx * sn + vy * c }; }
    }
    var rvx = s.vx - sb.vx, rvy = s.vy - sb.vy, rv2 = rvx * rvx + rvy * rvy;
    if (phase === 'cruise') {
      if (db < B.hill * 1.5) phase = 'approach';
      else {
        // mid-course correction: predict the miss at closest approach and nudge it out
        var tca = (bx0 * rvx + by0 * rvy) / (rv2 || 1e-12);
        if (db < B.hill * 8 && tca > 0) {
          var mx = bx0 - rvx * tca, my = by0 - rvy * tca, miss = Math.hypot(mx, my);
          if (miss > B.radius * 0.8) return { throttle: Math.min(1, Math.max(0.02, (miss / tca) / (aT * 0.3))), dx: mx, dy: my };
        }
        return { throttle: 0, dx: s.vx, dy: s.vy };
      }
    }
    // approach: line up on the planet, then let the landing autopilot take over at the brake altitude
    var dnx = bx0 / db, dny = by0 / db, rv = Math.sqrt(rv2);
    var vDown = rvx * dnx + rvy * dny, latx = rvx - vDown * dnx, laty = rvy - vDown * dny, lat = Math.hypot(latx, laty);
    if (alt > B.radius * brake) {
      var timeToGo = Math.max(alt, 0) / Math.max(vDown, 1e-6);
      if (vDown > 0 && lat * timeToGo > B.radius * 0.4) return { throttle: Math.min(1, lat * 8 / aT), dx: -latx, dy: -laty };
      return { throttle: 0, dx: dnx, dy: dny };
    }
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
  var latest = Math.max(1, world.deadline - tH * 0.5);
  var inner = world.sun.radius * 2, outer = world.bodies[world.bodies.length - 1].orbitR * 1.3;
  return { wait: Math.min(w0, latest), reach: B.orbitR, aim: 0, brake: 1.0, latest: latest, transfer: tH, synodic: synodic, reachMin: B.orbitR > A.orbitR ? A.orbitR : inner, reachMax: B.orbitR > A.orbitR ? outer : A.orbitR, outward: B.orbitR > A.orbitR };
}

// Dials clamped to their ranges; this is the only thing a player can submit.
function clean(world, P) {
  var tb = textbook(world), n = function (v, lo, hi, d) { v = +v; return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  P = P || {};
  return { wait: +n(P.wait, 0, tb.latest, tb.wait).toFixed(3), reach: +n(P.reach, tb.reachMin, tb.reachMax, tb.reach).toFixed(4), aim: +n(P.aim, -60, 60, 0).toFixed(1), brake: +n(P.brake, 0.1, 4, 1).toFixed(2) };
}

// Source of a sandbox bot that flies the plan: a function of (world, sim) returning the controller.
function botSource(world, P) {
  return 'function bot(world, sim){ return (' + makeController.toString() + ')(world, ' + JSON.stringify(clean(world, P)) + '); }';
}

// The live sky: the innermost planet goes round once every real minute. A flight starts from the
// sky as it looked when the launch was claimed, so the planets' starting angles are shifted by that moment.
function liveRate(world) { return world.bodies[0].period / 60; }
function worldAt(world, t0) {
  if (!(t0 > 0)) return world;
  var w = Object.assign({}, world); w.bodies = world.bodies.map(function (b) { var c = Object.assign({}, b); c.angle0 = b.angle0 + b.omega * t0; return c; });
  return w;
}
if (typeof module !== 'undefined' && module.exports) module.exports = { makeController: makeController, textbook: textbook, clean: clean, botSource: botSource, liveRate: liveRate, worldAt: worldAt };
if (typeof window !== 'undefined') window.LanderPlan = { makeController: makeController, textbook: textbook, clean: clean, botSource: botSource, liveRate: liveRate, worldAt: worldAt };
