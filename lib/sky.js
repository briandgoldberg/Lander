// The browser's view of the sky: orbits, the shared clock and dial housekeeping. No physics lives here: the flight
// engine and the autopilot stay on the server, so a pilot (human or machine) sees only what the page shows.
(function () {
  var TAU = Math.PI * 2;

  // Planets move on circles. (The rocket's motion is the server's business.)
  function bodyAt(w, k, t) {
    var b = w.bodies[k], a = b.angle0 + b.omega * t, c = Math.cos(a), s = Math.sin(a), v = b.orbitR * b.omega;
    return { x: b.orbitR * c, y: b.orbitR * s, vx: -v * s, vy: v * c };
  }

  // The live sky: the innermost planet goes round once every 7 real seconds.
  function liveRate(world) { return world.bodies[0].period / 7; }

  // The shared sky clock. Sky time runs at the live rate, except inside a burn window, where it runs SLOW times slower
  // for everyone: every burn of the day is a moment the whole sky lingers on.
  var SLOW = 0.015 * 7 / 10;
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
  var SLOW_CAP = 0.2, SLOW_CAP_LATER = 0.05;
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

  // Every flight has the same time limit, whatever the system.
  var FLIGHT_DAYS = 20;
  function flightDays(world) { return FLIGHT_DAYS; }

  // The sky as it is at sky time t0, as a world whose starting angles are shifted to that moment.
  function worldAt(world, t0) {
    if (!(t0 > 0)) return world;
    var w = Object.assign({}, world); w.bodies = world.bodies.map(function (b) { var c = Object.assign({}, b); c.angle0 = b.angle0 + b.omega * t0; return c; });
    return w;
  }

  // Dial housekeeping: the departure burn on its 5% grid, aim on the compass, brake in a sane range.
  function clean(world, P) {
    var n = function (v, lo, hi, d) { v = +v; return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
    P = P || {};
    return { assist: ['easy', 'medium', 'hard'].indexOf(P.assist) >= 0 ? P.assist : 'medium', wait: 0, s1: +(Math.round(n(P.s1, 0, 0.7, 0.35) * 20) / 20).toFixed(3), aim: +(((n(P.aim, -1e9, 1e9, 0) % 360) + 360) % 360).toFixed(1), brake: +n(P.brake, 0.1, 4, 1).toFixed(2) };
  }
  function textbook(world) { var A = world.bodies[world.start], B = world.bodies[world.target]; return { outward: B.orbitR > A.orbitR }; }

  window.bodyAt = bodyAt;
  window.LanderPlan = { bodyAt: bodyAt, liveRate: liveRate, skyClock: skyClock, slowWindows: slowWindows, mergeWindows: mergeWindows, flightDays: flightDays, worldAt: worldAt, clean: clean, textbook: textbook, SLOW: SLOW };
})();
