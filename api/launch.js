// POST /api/launch { launch_id }  — flies a claimed launch's plan on the server and records the official flight.
const { rpc, getUser, bearer, json, readJson, sign, configured } = require('./_lib/db');
const { runBot } = require('./_lib/runner');
const plan = require('./_lib/plan');

const BUDGET_MS = 10000;
const LEAD_S = 0;   // liftoff the moment the launch is claimed

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  if (!configured) return json(res, 503, { error: 'Server is not configured yet (SUPABASE_URL, SUPABASE_ANON_KEY, GAME_SECRET).' });
  try {
    const token = bearer(req);
    const user = await getUser(token);
    if (!user) return json(res, 401, { error: 'Sign in first.' });
    const { launch_id } = await readJson(req);
    const id = Number(launch_id);
    if (!id) return json(res, 400, { error: 'launch_id required' });
    const owner = await rpc('launch_owner', { p_launch: id });
    if (owner !== user.id) return json(res, 403, { error: 'Not your launch.' });
    const entry = await rpc('get_launch_code', { p_launch: id, p_sig: sign('code|' + id) });
    if (!entry || entry.status !== 'running') return json(res, 409, { error: 'This launch already ran.' });
    const state = await rpc('game_state', {});
    if (!state || !state.game || state.game.id !== entry.game_id) return json(res, 409, { error: 'Game mismatch.' });
    // the page only ever sees the public sky; the full system (masses, thrust) comes to the server alone, signed
    const full = await rpc('game_world_full', { p_game: entry.game_id, p_sig: sign('world|' + entry.game_id) });
    if (!full) return json(res, 500, { error: 'No system.' });
    // the flight lifts off from the live sky a few seconds after the claim: everyone watching sees the countdown
    let dials; try { dials = JSON.parse(entry.code); } catch (e) { dials = {}; }
    dials.s1 = Math.max(+dials.s1 || 0, plan.stage1(full, require('./_lib/engine')));   // the departure burn is the pilot's, but never too small to clear the home planet
    // sky time at liftoff, on the shared clock that slows while any rocket of the day is burning
    const events = (await rpc('clock_events', { p_game: entry.game_id })) || [];
    const windows = plan.slowWindows(events);
    const clock = plan.skyClock(new Date(entry.game_started_at).getTime(), plan.liveRate(full), windows);
    const tStart = +clock.sky(new Date(entry.created_at).getTime() + LEAD_S * 1000).toFixed(4);
    const world = plan.flightWorld(full, tStart, dials, require('./_lib/engine'));

    // the stored entry is the plan's dials; the autopilot source is built here, never taken from the client
    // fly the plan as dialled; if it does not land, quietly try the departure burn one percent smaller and larger and keep a landing
    let out = await runBot(plan.botSource(world, dials), world, BUDGET_MS);
    if (!(out.type === 'result' && out.result.outcome === 'landed')) {
      for (const d of [-0.01, 0.01]) {
        const alt = Object.assign({}, dials, { s1: +((+dials.s1 || 0) + d).toFixed(3), exact: true });
        const o2 = await runBot(plan.botSource(world, alt), world, BUDGET_MS);
        if (o2.type === 'result' && o2.result.outcome === 'landed') { out = o2; break; }
      }
    }
    let result;
    if (out.type === 'result') {
      const r = out.result;
      result = { outcome: r.outcome, body: r.body, fuelUsed: r.fuelUsed, fuelLeft: +(world.rocket.fuel - r.fuelUsed).toFixed(4),
        landingSpeed: r.landingSpeed, closestApproach: r.closestApproach, tStart, time: r.time, flights: out.flights, thinkMs: out.thinkMs, samples: r.samples, burns: plan.burnWindows(r.samples), error: null };
      result.landsAt = Math.round(plan.skyClock(new Date(entry.game_started_at).getTime(), plan.liveRate(full), plan.slowWindows(events.concat([{ t: tStart, b: result.burns }]))).real(tStart + r.time));
    } else {
      result = { outcome: 'error', body: null, fuelUsed: 0, fuelLeft: 0, landingSpeed: null, closestApproach: null, tStart, time: 0, flights: 0, thinkMs: 0, samples: null, burns: [], landsAt: null, error: out.message };
    }
    const payload = JSON.stringify(result);
    await rpc('finish_launch', { p_launch: id, p_result: payload, p_sig: sign(id + '|' + payload) });
    const { samples, ...summary } = result;
    return json(res, 200, { ok: true, launch_id: id, result: summary });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || String(e) });
  }
};
