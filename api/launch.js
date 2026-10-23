// POST /api/launch { launch_id }  — flies a claimed launch's plan on the server and records the official flight.
const { rpc, getUser, bearer, json, readJson, sign, configured } = require('../lib/db');
const { runBot } = require('../lib/runner');
const plan = require('../lib/plan');

const BUDGET_MS = 10000;

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
    // the flight starts from the sky as it looked when the launch was claimed
    let dials; try { dials = JSON.parse(entry.code); } catch (e) { dials = {}; }
    const tStart = +(Math.max(0, (new Date(entry.created_at).getTime() - new Date(entry.game_started_at).getTime()) / 1000) * plan.liveRate(state.world)).toFixed(4);
    const world = plan.flightWorld(state.world, tStart, dials);

    // the stored entry is the plan's dials; the autopilot source is built here, never taken from the client
    const out = await runBot(plan.botSource(world, dials), world, BUDGET_MS);
    let result;
    if (out.type === 'result') {
      const r = out.result;
      result = { outcome: r.outcome, body: r.body, fuelUsed: r.fuelUsed, fuelLeft: +(world.rocket.fuel - r.fuelUsed).toFixed(4),
        landingSpeed: r.landingSpeed, closestApproach: r.closestApproach, tStart, time: r.time, flights: out.flights, thinkMs: out.thinkMs, samples: r.samples, error: null };
    } else {
      result = { outcome: 'error', body: null, fuelUsed: 0, fuelLeft: 0, landingSpeed: null, closestApproach: null, tStart, time: 0, flights: 0, thinkMs: 0, samples: null, error: out.message };
    }
    const payload = JSON.stringify(result);
    await rpc('finish_launch', { p_launch: id, p_result: payload, p_sig: sign(id + '|' + payload) });
    const { samples, ...summary } = result;
    return json(res, 200, { ok: true, launch_id: id, result: summary });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || String(e) });
  }
};
