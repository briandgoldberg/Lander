// POST /api/launch { game, code, name } — claims a launch for the signed-in pilot, flies the plan on the server and
// records the official flight, all in one call, and hands the flight straight back so the page can show it at once.
// (The older { launch_id } form, for a launch claimed by the page itself, still works.)
const { rpc, getUser, bearer, json, readJson, sign, configured } = require('./_lib/db');
const plan = require('./_lib/plan');
const engine = require('./_lib/engine');

const BUDGET_MS = 10000;
const LEAD_S = 0;   // liftoff the moment the launch is claimed

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  if (!configured) return json(res, 503, { error: 'Server is not configured yet (SUPABASE_URL, SUPABASE_ANON_KEY, GAME_SECRET).' });
  try {
    const token = bearer(req);
    const user = await getUser(token);
    if (!user) return json(res, 401, { error: 'Sign in first.' });
    const body = await readJson(req);

    let id, entry, state, full, events;
    if (body.launch_id) {
      id = Number(body.launch_id);
      if (!id) return json(res, 400, { error: 'launch_id required' });
      const owner = await rpc('launch_owner', { p_launch: id });
      if (owner !== user.id) return json(res, 403, { error: 'Not your launch.' });
      entry = await rpc('get_launch_code', { p_launch: id, p_sig: sign('code|' + id) });
      if (!entry || entry.status !== 'running') return json(res, 409, { error: 'This launch already ran.' });
      [state, full, events] = await Promise.all([rpc('game_state', {}), rpc('game_world_full', { p_game: entry.game_id, p_sig: sign('world|' + entry.game_id) }), rpc('clock_events', { p_game: entry.game_id })]);
      if (!state || !state.game || state.game.id !== entry.game_id) return json(res, 409, { error: 'Game mismatch.' });
    } else {
      const gameId = Number(body.game), code = String(body.code || '');
      if (!gameId || !code) return json(res, 400, { error: 'game and code required' });
      // the claim as the pilot, then the sky and the clock all at once
      const claim = await rpc('claim_launch', { p_game: gameId, p_bot_name: String(body.name || 'plan'), p_code: code }, token);
      if (!claim || !claim.ok) return json(res, 200, { ok: false, reason: (claim && claim.reason) || 'could not claim' });
      const claimedAt = Date.now();
      [state, full, events] = await Promise.all([rpc('game_state', {}), rpc('game_world_full', { p_game: gameId, p_sig: sign('world|' + gameId) }), rpc('clock_events', { p_game: gameId })]);
      if (!state || !state.game || state.game.id !== gameId) return json(res, 409, { error: 'Game mismatch.' });
      id = claim.launch_id;
      entry = { code, created_at: claimedAt, game_started_at: state.game.started_at, game_id: gameId };
    }
    if (!full) return json(res, 500, { error: 'No system.' });

    let dials; try { dials = JSON.parse(entry.code); } catch (e) { dials = {}; }
    dials.s1 = Math.max(+dials.s1 || 0, plan.stage1(full, engine));   // the departure burn is the pilot's, but never too small to clear the home planet
    // sky time at liftoff, on the shared clock that slows while any rocket of the day is burning
    const windows = plan.slowWindows(events || []);
    const startMs = new Date(entry.game_started_at).getTime();
    const clock = plan.skyClock(startMs, plan.liveRate(full), windows);
    const tStart = +clock.sky(new Date(entry.created_at).getTime() + LEAD_S * 1000).toFixed(4);

    // the stored entry is the plan's dials; the autopilot is the server's own, never code from the client.
    // fly the plan as dialled; for a near miss the assist may quietly nudge the burn, the aim and the brake altitude,
    // as far as the level allows: Easy up to 5% / 5° / a higher brake, Medium up to 2% / 2° / a little higher, Hard not at all
    const t0 = Date.now();
    const flyP = (Q) => { const fw = plan.flightWorld(full, tStart, Q, engine); return { fw, r: engine.fly(fw, plan.makeController(fw, Q), { record: true }) }; };
    const assist = ['easy', 'medium', 'hard'].indexOf(dials.assist) >= 0 ? dials.assist : 'medium';
    let flights = 1, out;
    try { out = flyP(dials); } catch (e) { out = null; var flyErr = e; }
    const B = full.bodies[full.target];
    if (out) {
      const r0 = out.r, reach = assist === 'easy' ? 2 : assist === 'medium' ? 1 : 0;
      const near = reach > 0 && r0.outcome !== 'landed' && (r0.outcome === 'crashed' ? r0.body === B.name : r0.closestApproach != null && r0.closestApproach < B.hill * reach);
      if (near) {
        const span = assist === 'easy' ? 5 : 2, brakes = assist === 'easy' ? [0, 0.2, 0.5, 1.0] : [0, 0.3];
        let best = null;
        for (let da = -span; da <= span; da++) for (let bi = 0; bi < brakes.length; bi++) for (let ds = -span; ds <= span; ds++) {
          const cost = Math.abs(da) + Math.abs(ds) + bi * 2; if (best && cost >= best.cost) continue;
          const Q = Object.assign({}, dials, { exact: true, aim: (+dials.aim || 0) + da, s1: +((+dials.s1 || 0) + ds / 100).toFixed(3), brake: +((+dials.brake || 1) + brakes[bi]).toFixed(2) });
          let t; try { t = flyP(Q); flights++; } catch (e) { continue; }
          if (t.r.outcome === 'landed') best = { cost, t };
        }
        if (best) out = best.t;
      }
    }
    const world = out ? out.fw : plan.flightWorld(full, tStart, dials, engine);
    const thinkMs = Date.now() - t0;
    let result;
    if (out) {
      const r = out.r;
      result = { outcome: r.outcome, body: r.body, fuelUsed: r.fuelUsed, fuelLeft: +(world.rocket.fuel - r.fuelUsed).toFixed(4),
        landingSpeed: r.landingSpeed, closestApproach: r.closestApproach, tStart, time: r.time, flights, thinkMs, samples: r.samples, burns: plan.burnWindows(r.samples), assist, error: null };
      result.landsAt = Math.round(plan.skyClock(startMs, plan.liveRate(full), plan.slowWindows((events || []).concat([{ t: tStart, b: result.burns }]))).real(tStart + r.time));
    } else {
      result = { outcome: 'error', body: null, fuelUsed: 0, fuelLeft: 0, landingSpeed: null, closestApproach: null, tStart, time: 0, flights: 0, thinkMs: 0, samples: null, burns: [], landsAt: null, assist, error: String((flyErr && flyErr.message) || 'the flight could not run') };
    }
    const payload = JSON.stringify(result);
    await rpc('finish_launch', { p_launch: id, p_result: payload, p_sig: sign(id + '|' + payload) });
    const { samples, ...summary } = result;
    // the flight goes straight back to the page, so it needs no second trip to fetch it
    const replay = { id, bot_name: String(body.name || 'plan').slice(0, 24), status: 'done', outcome: result.outcome, body: result.body, fuelUsed: result.fuelUsed, fuelLeft: result.fuelLeft,
      landingSpeed: result.landingSpeed, samples, created_at: new Date(entry.created_at).toISOString(), t_start: tStart };
    return json(res, 200, { ok: true, launch_id: id, result: summary, replay });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || String(e) });
  }
};
