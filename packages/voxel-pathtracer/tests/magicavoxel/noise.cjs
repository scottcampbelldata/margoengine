// node noise.cjs <name> [suffix]: within-3 share of MagicaVoxel vs ours<suffix>, raw and after a 3x3 / 5x5 box blur of
// both (blur removes noise but keeps real differences), and where the >3 pixels are (edges vs flat areas).
const { decode } = require('./measure.cjs');
const [name, suffix = ''] = process.argv.slice(2);
const a = decode(`${name}-mv.png`),
  b = decode(`${name}-ours${suffix}.png`),
  w = a.width,
  h = a.height;
const blur = (img, r) => {
  const o = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        let s = 0,
          n = 0;
        for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++) {
            const X = x + dx,
              Y = y + dy;
            if (X >= 0 && Y >= 0 && X < w && Y < h) {
              s += img.data[4 * (Y * w + X) + c];
              n++;
            }
          }
        o[3 * (y * w + x) + c] = s / n;
      }
  return o;
};
const edge = new Uint8Array(w * h);
for (let y = 1; y < h - 1; y++)
  for (let x = 1; x < w - 1; x++) {
    let g = 0;
    for (let c = 0; c < 3; c++) {
      const p = (X, Y) => a.data[4 * (Y * w + X) + c];
      g = Math.max(g, Math.abs(p(x + 1, y) - p(x - 1, y)), Math.abs(p(x, y + 1) - p(x, y - 1)));
    }
    edge[y * w + x] = g > 24 ? 1 : 0;
  }
const out = [];
for (const r of [0, 1, 2]) {
  const A = blur(a, r),
    B = blur(b, r);
  let ok = 0,
    bad = 0,
    badEdge = 0;
  for (let i = 0; i < w * h; i++) {
    const m = Math.max(...[0, 1, 2].map((c) => Math.abs(A[3 * i + c] - B[3 * i + c])));
    if (m <= 3) ok++;
    else {
      bad++;
      if (edge[i]) badEdge++;
    }
  }
  out.push(
    `blur${2 * r + 1}: ${((100 * ok) / (w * h)).toFixed(2)}% (of the rest ${((100 * badEdge) / Math.max(bad, 1)).toFixed(0)}% on edges)`,
  );
}
console.log(name.padEnd(11), suffix.padEnd(4), out.join('  '));
