// Runs an entrant's bot in a sealed worker thread against the engine, with a wall-clock budget.
// The bot gets a bare context: Math, JSON and friends, the world, and sim. No require, no network.
const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');

const ENGINE_SRC = fs.readFileSync(path.join(__dirname, 'engine.js'), 'utf8');

const WORKER_SRC = `
const { parentPort, workerData } = require('worker_threads');
const vm = require('vm');
${ENGINE_SRC}
const { code, world, budgetMs } = workerData;
const t0 = Date.now(); let flights = 0;
const sim = {
  fly(ctrl) {
    if (typeof ctrl !== 'function') throw new Error('sim.fly needs a controller function');
    flights++;
    return fly(world, ctrl, { record: false });
  },
  timeLeft() { return budgetMs - (Date.now() - t0); },
  get flights() { return flights; }
};
let controller;
try {
  const ctx = vm.createContext({ Math, JSON, Number, String, Array, Object, Boolean, Infinity, NaN, isFinite, isNaN, parseFloat, parseInt, Error, TypeError, RangeError });
  vm.runInContext(code + '\\n;if (typeof bot !== "function") throw new Error("Define function bot(world, sim)"); globalThis.__bot = bot;', ctx, { timeout: 5000 });
  controller = ctx.__bot(world, sim);
  if (typeof controller !== 'function') throw new Error('bot() must return a controller function');
} catch (err) {
  parentPort.postMessage({ type: 'error', message: String(err && err.message || err) });
  process.exit(0);
}
const thinkMs = Date.now() - t0;
let result;
try { result = fly(world, controller, { record: true }); }
catch (err) { parentPort.postMessage({ type: 'error', message: 'Controller threw during the official flight: ' + (err && err.message || err) }); process.exit(0); }
parentPort.postMessage({ type: 'result', result, flights, thinkMs });
`;

function runBot(code, world, budgetMs) {
  return new Promise((resolve) => {
    const w = new Worker(WORKER_SRC, { eval: true, workerData: { code, world, budgetMs }, resourceLimits: { maxOldGenerationSizeMb: 512 } });
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); w.terminate().catch(() => {}); resolve(v); } };
    const timer = setTimeout(() => finish({ type: 'error', message: 'Out of time. bot() did not return a controller within ' + (budgetMs / 1000) + ' s.' }), budgetMs + 8000);
    w.on('message', (m) => finish(m));
    w.on('error', (e) => finish({ type: 'error', message: 'Worker error: ' + (e && e.message || e) }));
    w.on('exit', (c) => { if (!settled) finish({ type: 'error', message: 'Worker exited early (code ' + c + ')' }); });
  });
}

module.exports = { runBot };
