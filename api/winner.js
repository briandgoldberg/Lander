// GET /api/winner — once the game has ended, reveals the winning bot's code.
const { rpc, json, sign, configured } = require('../lib/db');

module.exports = async (req, res) => {
  if (!configured) return json(res, 503, { error: 'Server is not configured yet.' });
  try {
    const state = await rpc('game_state', {});
    if (!state || !state.game) return json(res, 404, { error: 'No game.' });
    const ended = new Date(state.game.ends_at).getTime() <= Date.now();
    const board = await rpc('leaderboard', { p_game: state.game.id });
    if (!ended) return json(res, 200, { ended: false, ends_at: state.game.ends_at, leader: board[0] || null });
    if (!board.length) return json(res, 200, { ended: true, winner: null });
    const entry = await rpc('get_launch_code', { p_launch: board[0].id, p_sig: sign('code|' + board[0].id) });
    return json(res, 200, { ended: true, winner: board[0], code: entry.code });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || String(e) });
  }
};
