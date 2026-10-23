// GET/POST /api/today — makes sure today's star system exists. Called by the page when the day
// rolls over and by a daily cron. Idempotent: the day's world is a pure function of the date.
const { rpc, json, sign, configured } = require('./_lib/db');
const engine = require('./_lib/engine');
const plan = require('./_lib/plan');
const { makeWorld } = engine;

function daySeed(day) { let h = 2166136261; for (const ch of 'lander-' + day) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

async function ensureDay(day) {
  if (await rpc('day_exists', { p_day: day })) return { day, existing: true };   // the landability sweep is slow, so only run it when a day is actually new
  let w = null; for (let attempt = 0; attempt < 64; attempt++) { w = makeWorld(daySeed(day + (attempt ? '#' + attempt : ''))); w.rocket.fuel = +(w.rocket.fuel * 0.85).toFixed(2); if (Math.abs(w.start - w.target) >= 2 && plan.landable(w, engine).ok) break; }
  w.hints = Object.assign({}, w.hints, { stage1: plan.stage1(w, engine) });   // the departure burn's floor, the one number the page needs from the physics
  const world = JSON.stringify(w);
  return rpc('ensure_game', { p_day: day, p_world: world, p_sig: sign('game|' + day + '|' + world) });
}

module.exports = async (req, res) => {
  if (!configured) return json(res, 503, { error: 'Server is not configured yet.' });
  try {
    // a day is a Pacific-time calendar day
    const pacific = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
    const day = pacific(Date.now()), tomorrow = pacific(Date.now() + 86400000);
    const game = await ensureDay(day);
    // tomorrow's system is made ahead of time so the midnight rollover is instant
    let next = null; try { next = await ensureDay(tomorrow); } catch (e) {}
    return json(res, 200, { ok: true, day, game, next });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || String(e) });
  }
};
