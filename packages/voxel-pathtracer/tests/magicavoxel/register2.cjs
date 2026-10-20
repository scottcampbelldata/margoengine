// Best shift (dx, dy) and separate scales (sx, sy) about the image centre mapping ours onto MagicaVoxel's (edge pixels).
const { decode } = require('./measure.cjs');
const name = process.argv[2];
const a = decode(`${name}-mv.png`), b = decode(`${name}-ours.png`), W = a.width, H = a.height;
const g = (img, x, y) => { const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0; const p = (X, Y) => img.data[4 * (Math.min(H - 1, Math.max(0, Y)) * W + Math.min(W - 1, Math.max(0, X)))]; return (p(x0, y0) * (1 - fx) + p(x0 + 1, y0) * fx) * (1 - fy) + (p(x0, y0 + 1) * (1 - fx) + p(x0 + 1, y0 + 1) * fx) * fy; };
const pts = [];
for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) { const i = 4 * (y * W + x); if (Math.max(Math.abs(a.data[i + 4] - a.data[i - 4]), Math.abs(a.data[i + 4 * W] - a.data[i - 4 * W])) > 30) pts.push([x, y]); }
const region = process.argv[3]; // 'top' | 'bottom' | undefined
const use = pts.filter(([, y]) => (region === 'top' ? y < H / 2 : region === 'bottom' ? y >= H / 2 : true));
const err = (dx, dy, sx, sy) => { let e = 0; for (const [x, y] of use) { const d = a.data[4 * (y * W + x)] - g(b, W / 2 + (x + 0.5 - W / 2) / sx - 0.5 - dx, H / 2 + (y + 0.5 - H / 2) / sy - 0.5 - dy); e += d * d; } return Math.sqrt(e / use.length); };
let best = [0, 0, 1, 1, err(0, 0, 1, 1)];
for (const [st, ss] of [[0.2, 0.002], [0.05, 0.0005], [0.01, 0.0001]]) {
  const [bx, by, bsx, bsy] = best;
  for (let dx = bx - 3 * st; dx <= bx + 3 * st + 1e-9; dx += st) for (let dy = by - 3 * st; dy <= by + 3 * st + 1e-9; dy += st)
    for (let sx = bsx - 3 * ss; sx <= bsx + 3 * ss + 1e-12; sx += ss) for (let sy = bsy - 3 * ss; sy <= bsy + 3 * ss + 1e-12; sy += ss) { const e = err(dx, dy, sx, sy); if (e < best[4]) best = [dx, dy, sx, sy, e]; }
}
console.log(name, region ?? 'all', 'identity', err(0, 0, 1, 1).toFixed(2), 'best dx', best[0].toFixed(3), 'dy', best[1].toFixed(3), 'sx', best[2].toFixed(5), 'sy', best[3].toFixed(5), 'rms', best[4].toFixed(2));
