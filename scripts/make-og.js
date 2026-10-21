// Renders og.png (1200x630): a view of the Game #1 system, drawn with no dependencies.
// Usage: node scripts/make-og.js [seed]
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const engine = require('../lib/engine.js');

const W = 1200, H = 630, SUN_MAG = 4;
const seed = Number(process.argv[2] || 1433709681);
const world = engine.makeWorld(seed);
const px = new Float32Array(W * H * 3);

function blend(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] += (r - px[i]) * a; px[i+1] += (g - px[i+1]) * a; px[i+2] += (b - px[i+2]) * a;
}
function disc(cx, cy, rad, color, alpha, shade) {
  const x0 = Math.max(0, Math.floor(cx - rad - 1)), x1 = Math.min(W - 1, Math.ceil(cx + rad + 1));
  const y0 = Math.max(0, Math.floor(cy - rad - 1)), y1 = Math.min(H - 1, Math.ceil(cy + rad + 1));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy), cov = Math.min(1, Math.max(0, rad - d + 0.5));
    if (cov <= 0) continue;
    let [r, g, b] = color;
    if (shade) { const lx = -cx + W/2, ly = -cy + H/2, ln = Math.hypot(lx, ly) || 1, dx = (x - cx) / rad, dy = (y - cy) / rad, lit = 0.55 + 0.45 * ((dx * lx + dy * ly) / ln); r *= lit; g *= lit; b *= lit; }
    blend(x, y, r, g, b, cov * alpha);
  }
}
function ring(cx, cy, rad, color, alpha) {
  const n = Math.ceil(rad * 6);
  for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; blend(Math.round(cx + Math.cos(a) * rad), Math.round(cy + Math.sin(a) * rad), color[0], color[1], color[2], alpha); }
}
function glow(cx, cy, rad, color, alpha) {
  const x0 = Math.max(0, Math.floor(cx - rad)), x1 = Math.min(W - 1, Math.ceil(cx + rad)), y0 = Math.max(0, Math.floor(cy - rad)), y1 = Math.min(H - 1, Math.ceil(cy + rad));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const d = Math.hypot(x - cx, y - cy) / rad; if (d < 1) blend(x, y, color[0], color[1], color[2], alpha * (1 - d) * (1 - d)); }
}
function hex(c) { return [parseInt(c.slice(1,3),16), parseInt(c.slice(3,5),16), parseInt(c.slice(5,7),16)]; }

// background with a faint nebula
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 3; px[i] = 3; px[i+1] = 5; px[i+2] = 12; }
glow(900, 160, 520, [90, 60, 160], 0.14); glow(250, 520, 460, [40, 120, 150], 0.12);
let s = 12345; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
for (let i = 0; i < 700; i++) { const x = Math.floor(rnd() * W), y = Math.floor(rnd() * H), a = 0.25 + rnd() * 0.7; blend(x, y, 233, 236, 246, a); if (rnd() < 0.3) { blend(x + 1, y, 233, 236, 246, a * 0.5); blend(x, y + 1, 233, 236, 246, a * 0.5); } }

// the system, centered, orbits to scale, planets at one magnification
const outer = world.bodies[world.bodies.length - 1].orbitR, scale = (H / 2) / (outer * 1.12), cx = W / 2, cy = H / 2;
let minGap = world.bodies[0].orbitR - world.sun.radius * SUN_MAG, maxR = 0;
world.bodies.forEach((b, k) => { maxR = Math.max(maxR, b.radius); if (k > 0) minGap = Math.min(minGap, b.orbitR - world.bodies[k-1].orbitR); });
const mag = Math.max(5, Math.min(30, Math.floor(0.42 * minGap / maxR)));
world.bodies.forEach((b, k) => ring(cx, cy, b.orbitR * scale, k === world.target ? [243, 180, 87] : [143, 152, 184], k === world.target ? 0.5 : 0.28));
glow(cx, cy, world.sun.radius * scale * SUN_MAG * 5, [255, 190, 90], 0.6);
disc(cx, cy, world.sun.radius * scale * SUN_MAG, [255, 225, 150], 1, false);
world.bodies.forEach((b, k) => {
  const p = engine.bodyAt(world, k, 0), x = cx + p.x * scale, y = cy - p.y * scale, r = b.radius * scale * mag;
  glow(x, y, r * 2.2, hex(b.color), 0.35);
  disc(x, y, r, hex(b.color), 1, true);
  if (k === world.start || k === world.target) ring(x, y, r + 7, [243, 180, 87], 0.9);
});
// the rocket's trail from start toward target, and the rocket as an amber dot
const a = engine.bodyAt(world, world.start, 0), t = engine.bodyAt(world, world.target, 0);
for (let i = 0; i <= 120; i++) { const f = i / 120, bx = a.x + (t.x - a.x) * f, by = a.y + (t.y - a.y) * f + Math.sin(f * Math.PI) * 0.6 * (t.x - a.x); blend(Math.round(cx + bx * scale), Math.round(cy - by * scale), 255, 190, 90, 0.9 * (1 - f * 0.6)); }
disc(cx + a.x * scale, cy - a.y * scale, 5, [255, 230, 180], 1, false);

// encode PNG
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; for (let x = 0; x < W; x++) { const i = (y * W + x) * 3, o = y * (W * 3 + 1) + 1 + x * 3; raw[o] = Math.max(0, Math.min(255, Math.round(px[i]))); raw[o+1] = Math.max(0, Math.min(255, Math.round(px[i+1]))); raw[o+2] = Math.max(0, Math.min(255, Math.round(px[i+2]))); } }
const crcTable = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c; }
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
const out = path.join(__dirname, '..', 'og.png');
fs.writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes', world.name, 'system');
