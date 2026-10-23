// Lander starter bot. It finds a launch window, flies to the target planet,
// and arrives too fast. Landing is your job. Then fuel.
//
// The sandbox calls bot(world, sim) once. bot must return a controller:
//   controller(state) -> { throttle: 0..1, dx, dy }   (dx, dy: thrust direction, any length)
// Use sim.fly(controller) to test-fly ideas in the sandbox's own physics first.
// You have a wall-clock budget (sim.timeLeft() in ms). When bot() returns, the
// sandbox flies the controller you returned for real. That flight is your entry.

function bot(world, sim) {
  const { sun, bodies, rocket } = world;
  const A = bodies[world.start], B = bodies[world.target];
  const outward = B.orbitR > A.orbitR;
  const TWO_PI = 2 * Math.PI;

  // A Hohmann transfer takes half an ellipse. The target has to be a known
  // angle ahead of (or behind) us at launch so it is there when we arrive.
  const a = (A.orbitR + B.orbitR) / 2;
  const tH = Math.PI * Math.sqrt(a * a * a / sun.mass);
  const need = Math.PI - B.omega * tH;                 // required angle from A to B at launch
  const dw = B.omega - A.omega;
  const synodic = TWO_PI / Math.abs(dw);
  const phase0 = B.angle0 - A.angle0;
  const w0 = (((need - phase0) / dw) % synodic + synodic) % synodic;   // the textbook window
  const latest = world.deadline - tH * 0.5;

  // The textbook window is only a guess: our launch burn is a big fraction of
  // orbital speed, so sweep launch times across the whole day, then refine.
  let best = null;
  function attempt(p) {
    if (p.wait < 0 || p.wait > latest) return;
    const r = sim.fly(make(p));
    const score = r.outcome === 'landed' ? r.fuelUsed
      : (r.outcome === 'crashed' && r.body === B.name) ? 50 + r.fuelUsed
      : 100 + (r.closestApproach == null ? 10 : r.closestApproach);
    if (!best || score < best.score) best = { score, p, r };
  }
  const step = Math.max(latest / 36, 0.05);
  for (const cutoff of [0.97, 1.0, 1.03]) attempt({ wait: w0, cutoff });
  for (let wait = 0; wait <= latest; wait += step)
    for (const cutoff of [0.97, 1.0, 1.03])
      if (sim.timeLeft() > 3000) attempt({ wait, cutoff });
  if (!best) attempt({ wait: 0, cutoff: 1.0 });
  const b = best.p;
  for (let k = -4; k <= 4; k++)
    for (const cutoff of [b.cutoff - 0.012, b.cutoff, b.cutoff + 0.012])
      if (k !== 0 && sim.timeLeft() > 2000) attempt({ wait: b.wait + k * step / 5, cutoff });

  return make(best.p);

  // Autopilot. Straight up to escape speed, coast clear of the planet, one
  // injection burn along the orbit, cruise, then steer onto the target.
  function make(p) {
    let phase = 'pad';
    const vEsc = Math.sqrt(2 * A.mass / A.radius);
    const gB = B.mass / (B.radius * B.radius);
    return function controller(s) {
      const sa = s.bodies[world.start], sb = s.bodies[world.target];
      const ax0 = s.x - sa.x, ay0 = s.y - sa.y, da = Math.hypot(ax0, ay0);        // from start planet
      const upx = ax0 / da, upy = ay0 / da;
      const relAx = s.vx - sa.vx, relAy = s.vy - sa.vy, relA = Math.hypot(relAx, relAy);
      const bx0 = sb.x - s.x, by0 = sb.y - s.y, db = Math.hypot(bx0, by0);        // to target planet
      const alt = db - B.radius;

      if (phase === 'pad') {
        if (s.t < p.wait) return { throttle: 0, dx: upx, dy: upy };
        phase = 'ascent';
      }
      if (phase === 'ascent') {
        if (relA >= vEsc * 1.02) phase = 'clear';
        else return { throttle: 1, dx: upx, dy: upy };
      }
      if (phase === 'clear') {
        if (da > A.hill * 1.5) phase = 'inject';
        else return { throttle: 0, dx: upx, dy: upy };
      }
      if (phase === 'inject') {
        // Burn along the start planet's direction of travel (or against it, going inward)
        // until our orbit around the sun reaches the target's distance.
        const r = Math.hypot(s.x, s.y), v2 = s.vx * s.vx + s.vy * s.vy;
        const eps = v2 / 2 - sun.mass / r, h = s.x * s.vy - s.y * s.vx;
        const sma = -sun.mass / (2 * eps);
        const e = Math.sqrt(Math.max(0, 1 + 2 * eps * h * h / (sun.mass * sun.mass)));
        const reach = outward ? sma * (1 + e) : sma * (1 - e);
        const goal = B.orbitR * p.cutoff;
        const gap = outward ? (goal - reach) / goal : (eps < 0 ? (reach - goal) / goal : 1);
        if (gap <= 0) phase = 'cruise';
        else { const sgn = outward ? 1 : -1; return { throttle: Math.min(1, Math.max(0.05, gap * 15)), dx: sgn * sa.vx, dy: sgn * sa.vy }; }
      }
      if (phase === 'cruise') {
        if (db < B.hill * 1.5) phase = 'approach';
        else {
          // Mid-course correction: predict the miss at closest approach and nudge it out.
          const rvx = s.vx - sb.vx, rvy = s.vy - sb.vy, rv2 = rvx * rvx + rvy * rvy;
          const tca = (bx0 * rvx + by0 * rvy) / rv2;                 // time to closest approach
          if (db < B.hill * 8 && tca > 0) {
            const mx = bx0 - rvx * tca, my = by0 - rvy * tca;        // miss vector at closest approach
            const miss = Math.hypot(mx, my);
            if (miss > B.radius * 0.8) {
              const dvNeeded = miss / tca;                            // sideways speed that closes the miss
              return { throttle: Math.min(1, Math.max(0.02, dvNeeded / (rocket.maxThrust * 0.3))), dx: mx, dy: my };
            }
          }
          return { throttle: 0, dx: s.vx, dy: s.vy };
        }
      }
      // Approach: steer so we hit the planet, then brake. The brake below is
      // far too little, far too late. Fix it and you will land.
      const dnx = bx0 / db, dny = by0 / db;
      const rvx = s.vx - sb.vx, rvy = s.vy - sb.vy;
      const vDown = rvx * dnx + rvy * dny;
      const latx = rvx - vDown * dnx, laty = rvy - vDown * dny, lat = Math.hypot(latx, laty);
      const timeToGo = Math.max(alt, 0) / Math.max(vDown, 0.01);
      let ax = 0, ay = 0;
      if (lat * timeToGo > B.radius * 0.5) { ax -= latx * 8; ay -= laty * 8; }
      if (alt < B.radius * 2 && vDown > 0) { ax -= dnx * (gB * 0.5); ay -= dny * (gB * 0.5); }
      const am = Math.hypot(ax, ay);
      if (am < 0.02) return { throttle: 0, dx: dnx, dy: dny };
      return { throttle: Math.min(1, am / rocket.maxThrust), dx: ax, dy: ay };
    };
  }
}
