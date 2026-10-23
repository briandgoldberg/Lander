// GET /api/almanac?game=<id> — the almanac of a finished day: every landable plan the sweep can find, with the
// least-fuel one first. Computed once per day, after the day is over, and kept with the game.
const { rpc, json, sign, configured } = require('./_lib/db');
const engine = require('./_lib/engine');
const plan = require('./_lib/plan');

module.exports = async (req, res) => {
  if (!configured) return json(res, 503, { error: 'Server is not configured yet.' });
  try {
    const id = Number(new URL(req.url, 'http://x').searchParams.get('game'));
    if (!id) return json(res, 400, { error: 'game required' });
    const a = await rpc('get_almanac', { p_game: id });
    if (!a) return json(res, 404, { error: 'No such day.' });
    if (!a.ended) return json(res, 200, { ended: false });   // today's answers stay sealed until midnight
    if (a.ready && a.data) return json(res, 200, { ended: true, data: a.data });
    const world = await rpc('game_world_full', { p_game: id, p_sig: sign('world|' + id) });
    if (!world) return json(res, 404, { error: 'No system.' });
    const data = plan.solutions(world, engine);
    const payload = JSON.stringify(data);
    await rpc('set_almanac', { p_game: id, p_data: payload, p_sig: sign('almanac|' + id + '|' + payload) });
    return json(res, 200, { ended: true, data });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || String(e) });
  }
};
