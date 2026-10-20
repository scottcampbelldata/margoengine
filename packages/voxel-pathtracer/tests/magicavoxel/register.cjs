// Best sub-pixel shift (dx, dy) and scale s that map our image onto MagicaVoxel's: MagicaVoxel(p) ~ ours(c + (p - c) / s - d).
const { decode } = require('./measure.cjs');
const name = process.argv[2];
const a = decode(`${name}-mv.png`), b = decode(`${name}-ours.png`), W = a.width, H = a.height;
const g = (img, x, y) => { const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0; const p = (X, Y) => img.data[4 * (Math.min(H - 1, Math.max(0, Y)) * W + Math.min(W - 1, Math.max(0, X)))]; return (p(x0, y0) * (1 - fx) + p(x0 + 1, y0) * fx) * (1 - fy) + (p(x0, y0 + 1) * (1 - fx) + p(x0 + 1, y0 + 1) * fx) * fy; };
// edge pixels only (where MagicaVoxel has a strong gradient)
const pts = [];
for (let y = 2; y < H - 2; y += 1) for (let x = 2; x < W - 2; x += 1) { const i = 4 * (y * W + x); const gx = Math.abs(a.data[i + 4] - a.data[i - 4]), gy = Math.abs(a.data[i + 4 * W] - a.data[i - 4 * W]); if (Math.max(gx, gy) > 30) pts.push([x, y]); }
const err = (dx, dy, s) => { let e = 0; for (const [x, y] of pts) { const d = a.data[4 * (y * W + x)] - g(b, W / 2 + (x + 0.5 - W / 2) / s - 0.5 - dx, H / 2 + (y + 0.5 - H / 2) / s - 0.5 - dy); e += d * d; } return Math.sqrt(e / pts.length); };
let best = [0, 0, 1, err(0, 0, 1)];
for (const step of [0.2, 0.05, 0.01]) {
  const [bx, by, bs] = best;
  for (let dx = bx - 4 * step; dx <= bx + 4 * step + 1e-9; dx += step) for (let dy = by - 4 * step; dy <= by + 4 * step + 1e-9; dy += step)
    for (const s of [bs - 0.0004 * step * 10, bs, bs + 0.0004 * step * 10]) { const e = err(dx, dy, s); if (e < best[3]) best = [dx, dy, s, e]; }
}
console.log(name, 'edge pixels', pts.length, 'rms at identity', err(0, 0, 1).toFixed(2), '-> best dx', best[0].toFixed(3), 'dy', best[1].toFixed(3), 'scale', best[2].toFixed(5), 'rms', best[3].toFixed(2));
