// Thin helpers around Supabase's REST interface. The server has no privileged key: it calls
// database functions as the signed-in user, and proves server-only actions with an HMAC signature.
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SECRET = process.env.GAME_SECRET || '';

function sign(payload) { return crypto.createHmac('sha256', SECRET).update(payload).digest('hex'); }

async function rpc(fn, args, token) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: ANON, authorization: `Bearer ${token || ANON}` },
    body: JSON.stringify(args || {})
  });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!res.ok) { const err = new Error((data && (data.message || data.hint)) || `rpc ${fn} failed (${res.status})`); err.status = res.status; err.data = data; throw err; }
  return data;
}

async function getUser(token) {
  if (!token) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  return res.json();
}

function bearer(req) {
  const h = req.headers['authorization'] || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

function json(res, status, body) { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); }

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = []; for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

module.exports = { rpc, getUser, bearer, json, readJson, sign, configured: !!(SUPABASE_URL && ANON && SECRET) };
