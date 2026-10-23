// GET/POST /api/today — makes sure today's star system exists. Called by the page when the day
// rolls over and by a daily cron. Idempotent: the day's world is a pure function of the date.
const { rpc, json, sign, configured } = require('../lib/db');
const { makeWorld } = require('../lib/engine');

function daySeed(day) { let h = 2166136261; for (const ch of 'lander-' + day) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

module.exports = async (req, res) => {
  if (!configured) return json(res, 503, { error: 'Server is not configured yet.' });
  try {
    const day = new Date().toISOString().slice(0, 10);
    // the day's system: the first candidate whose start and target orbits have at least one orbit between them
    let w = null; for (let attempt = 0; attempt < 64; attempt++) { w = makeWorld(daySeed(day + (attempt ? '#' + attempt : ''))); if (Math.abs(w.start - w.target) >= 2) break; }
    const world = JSON.stringify(w);
    const game = await rpc('ensure_game', { p_day: day, p_world: world, p_sig: sign('game|' + day + '|' + world) });
    return json(res, 200, { ok: true, day, game });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || String(e) });
  }
};
