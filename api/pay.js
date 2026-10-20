// POST /api/pay { tx_hash }  — verifies a USDC transfer on Base to the treasury and credits launches, $1 each.
const { rpc, getUser, bearer, json, readJson, sign, configured } = require('../lib/db');

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';           // USDC on Base
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const TREASURY = (process.env.TREASURY_ADDRESS || '').toLowerCase();

async function receipt(hash) {
  const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash] }) });
  const j = await r.json();
  return j.result;
}

module.exports = async (req, res) => {
  if (req.method === 'GET') return json(res, 200, { configured: !!TREASURY, treasury: TREASURY || null, chainId: 8453, usdc: USDC, price_usdc: 1 });
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  if (!configured) return json(res, 503, { error: 'Server is not configured yet.' });
  if (!TREASURY) return json(res, 503, { error: 'Payments are not switched on yet. Set TREASURY_ADDRESS.' });
  try {
    const user = await getUser(bearer(req));
    if (!user) return json(res, 401, { error: 'Sign in first.' });
    const { tx_hash } = await readJson(req);
    if (!/^0x[0-9a-fA-F]{64}$/.test(tx_hash || '')) return json(res, 400, { error: 'That is not a transaction hash.' });
    const rc = await receipt(tx_hash);
    if (!rc) return json(res, 404, { error: 'Transaction not found yet. Give it a few seconds and try again.' });
    if (rc.status !== '0x1') return json(res, 400, { error: 'That transaction failed on chain.' });
    let amount = 0n;
    for (const log of rc.logs || []) {
      if ((log.address || '').toLowerCase() !== USDC) continue;
      if (!log.topics || log.topics[0] !== TRANSFER) continue;
      const to = '0x' + log.topics[2].slice(26).toLowerCase();
      if (to !== TREASURY) continue;
      amount += BigInt(log.data);
    }
    const credits = Number(amount / 1000000n);
    if (credits < 1) return json(res, 400, { error: 'No USDC transfer to the treasury of at least $1 found in that transaction.' });
    const amountUsdc = Number(amount) / 1e6;
    const out = await rpc('credit_payment', { p_tx: tx_hash.toLowerCase(), p_amount: amountUsdc, p_credits: credits, p_sig: sign('pay|' + tx_hash.toLowerCase() + '|' + user.id + '|' + credits) }, bearer(req));
    return json(res, 200, out);
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || String(e) });
  }
};
