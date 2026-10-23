// POST /api/launch { game, code, name } — claims a launch for the signed-in pilot, flies the plan on the server and
// records the official flight, all in one call, and hands the flight straight back so the page can show it at once.
// (The older { launch_id } form, for a launch claimed by the page itself, still works.)
const { rpc, getUser, bearer, json, readJson, sign, configured } = require('./_lib/db');
const { runBot } = require('./_lib/runner');
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
    const world = plan.flightWorld(full, tStart, dials, engine);

    // the stored entry is the plan's dials; the autopilot source is built here, never taken from the client.
    // fly the plan as dialled; a near miss gets the departure burn quietly tried one percent smaller and larger
    const B = world.bodies[world.target], assist = ['easy', 'medium', 'hard'].indexOf(dials.assist) >= 0 ? dials.assist : 'medium';
    let out = await runBot(plan.botSource(world, dials), world, BUDGET_MS);
    // the assist level is how far the autopilot may nudge the departure burn for a near miss: none, up to two percent, or up to five
    const steps = n => { const out = []; for (let i = 1; i <= n; i++) out.push(-i / 100, i / 100); return out; };
    const nudges = assist === 'hard' ? [] : assist === 'easy' ? steps(5) : steps(2);
    const near = nudges.length > 0 && out.type === 'result' && out.result.outcome !== 'landed' && (out.result.outcome === 'crashed' ? out.result.body === B.name : out.result.closestApproach != null && out.result.closestApproach < B.hill * (assist === 'easy' ? 2 : 1));
    if (near) {
      for (const d of nudges) {
        const alt = Object.assign({}, dials, { s1: +((+dials.s1 || 0) + d).toFixed(3), exact: true });
        const o2 = await runBot(plan.botSource(world, alt), world, BUDGET_MS);
        if (o2.type === 'result' && o2.result.outcome === 'landed') { out = o2; break; }
      }
    }
    let result;
    if (out.type === 'result') {
      const r = out.result;
      result = { outcome: r.outcome, body: r.body, fuelUsed: r.fuelUsed, fuelLeft: +(world.rocket.fuel - r.fuelUsed).toFixed(4),
        landingSpeed: r.landingSpeed, closestApproach: r.closestApproach, tStart, time: r.time, flights: out.flights, thinkMs: out.thinkMs, samples: r.samples, burns: plan.burnWindows(r.samples), assist, error: null };
      result.landsAt = Math.round(plan.skyClock(startMs, plan.liveRate(full), plan.slowWindows((events || []).concat([{ t: tStart, b: result.burns }]))).real(tStart + r.time));
    } else {
      result = { outcome: 'error', body: null, fuelUsed: 0, fuelLeft: 0, landingSpeed: null, closestApproach: null, tStart, time: 0, flights: 0, thinkMs: 0, samples: null, burns: [], landsAt: null, assist, error: out.message };
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
