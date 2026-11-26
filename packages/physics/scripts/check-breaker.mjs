// A plunging breaker from a dispersively focused packet (as Erinin et al. 2023 describe it, with their frequencies),
// inside a FlipSolver box held to the linear packet at its sides. Measures the crest speed before overturning and the
// fastest water in the jet, against Erinin et al.'s jet tip speed of 1.24 to 1.33 times the crest speed.
// Results on an Apple M6 with the density projection (S = 0.55, box 5.6 m): jet over crest 1.26 (cells of 1.25 cm, start
// 1.4 s before the focus), 1.46 (1.25 cm, 1.8 s before) and 1.72 (0.9 cm, 1.4 s before), against Erinin et al.'s 1.24 to
// 1.33: the crest plunges, but the ratio scatters and does not converge (docs/limits.md, "Grid-particle liquids").
// Cells of 2 cm do not resolve the plunge (no jet).
// Usage (after npm run build): node scripts/check-breaker.mjs [S] [cell size, m] [start, s] [box length, m]
import { FlipSolver } from '../dist/flip.js';
import { PhysicsWorld } from '../dist/world.js';
const G = 9.81,
  S = Number(process.argv[2] ?? 0.55),
  h = Number(process.argv[3] ?? 0.009),
  N = 32,
  wbar = 2 * Math.PI * 1.15,
  dw = (0.77 * wbar) / N,
  comps = Array.from({ length: N }, (_, i) => {
    const w = wbar + (i - (N - 1) / 2) * dw,
      k = (w * w) / G;
    return { w, k, a: S / N / k };
  }),
  xb = 0,
  tb = 3.0;
// Linear deep-water packet focusing at (xb, tb); velocities by Wheeler stretching above the still level.
const sea = {
  elevation(x, _z, t) {
    let e = 0;
    for (const c of comps) e += c.a * Math.cos(c.k * (x - xb) - c.w * (t - tb));
    return e;
  },
  water: {
    sample(x, y, _z, t, out = { velocity: [0, 0, 0], density: 1000, temperature: 288 }) {
      const eta = this.parent.elevation(x, 0, t),
        ys = eta > -1 ? y - eta : y;
      let u = 0,
        v = 0;
      for (const c of comps) {
        const th = c.k * (x - xb) - c.w * (t - tb),
          e = c.a * c.w * Math.exp(c.k * Math.min(ys, 0));
        u += e * Math.cos(th);
        v += e * Math.sin(th);
      }
      out.velocity[0] = u;
      out.velocity[1] = v;
      out.velocity[2] = 0;
      return out;
    },
  },
};
sea.water.parent = sea;
const t0 = Number(process.argv[4] ?? 1.6);
const depth = 0.6,
  air = 0.4,
  L = Number(process.argv[5] ?? 3.6),
  // A longer box reaches further downstream, where an earlier start's waves break.
  x0 = xb - (L > 3.6 ? 3 : 2.5),
  nx = Math.round(L / h),
  ny = Math.round((depth + air) / h);
const liquid = new FlipSolver(),
  rate = 240,
  world = new PhysicsWorld({ rate: { num: rate, den: 1 }, gravity: [0, -G, 0] }).add(liquid, {
    cells: [nx, ny, 1],
    cellSize: h,
    origin: [x0, -depth, 0],
    sea: {
      ...sea,
      elevation: (x, z, t) => sea.elevation(x, z, t + t0),
      water: { sample: (x, y, z, t, o) => sea.water.sample(x, y, z, t + t0, o) },
    },
    blend: 8,
    rate: 2,
    maxSubsteps: 256,
    capacity: nx * ny * 8,
  });
let crest = [],
  fastest = 0,
  fastestAt = 0,
  start = performance.now();
for (let f = 1; f <= Math.round((tb + (L > 3.6 ? 1.4 : 0.9) - t0) * rate); f++) {
  world.advance(f);
  const t = t0 + f / rate,
    p = liquid.positions(),
    words = liquid['words'](liquid['particleRegion']);
  // The crest: the highest particle away from the band.
  let top = -1e9,
    topX = 0,
    frameFastest = 0;
  for (let q = 0; q < p.length / 3; q++) {
    const x = p[3 * q],
      y = p[3 * q + 1];
    if (x < x0 + 10 * h || x > x0 + L - 10 * h) continue;
    if (y > top) [top, topX] = [y, x];
    // The fastest water above the still level: the jet.
    const u = words[q * 15 + 3];
    if (y > 0.02 && u > fastest) [fastest, fastestAt] = [u, t];
    if (y > 0.02 && u > frameFastest) frameFastest = u;
  }
  crest.push([t, topX, top, frameFastest]);
  if (f % 24 === 0)
    console.log(
      t.toFixed(3),
      'crest',
      topX.toFixed(3),
      top.toFixed(3),
      'fastest',
      fastest.toFixed(3),
      'count',
      liquid.count,
      ((performance.now() - start) / 1000).toFixed(0) + 's',
    );
}
// Crest speed: the crest point's x over the 0.3 s before it reaches its greatest height.
const peak = crest.reduce((a, b) => (b[2] > a[2] ? b : a)),
  win = crest.filter((c) => c[0] > peak[0] - 0.3 && c[0] <= peak[0]),
  n = win.length,
  mt = win.reduce((s, c) => s + c[0], 0) / n,
  mx = win.reduce((s, c) => s + c[1], 0) / n,
  slope = win.reduce((s, c) => s + (c[0] - mt) * (c[1] - mx), 0) / win.reduce((s, c) => s + (c[0] - mt) ** 2, 0),
  // The jet: the fastest water above the still level from the crest's peak to 0.17 s on, when Erinin et al.'s jets land
  // (149 to 170 ms after they form); later water is the splash-up the landing throws.
  jet = crest.filter((c) => c[0] >= peak[0] && c[0] <= peak[0] + 0.17).reduce((m, c) => Math.max(m, c[3]), 0);
console.log('jet', jet.toFixed(3), 'jet over crest', (jet / slope).toFixed(3));
console.log(
  'peak crest',
  peak.map((v) => v.toFixed(3)),
  'crest speed',
  slope.toFixed(3),
  'fastest',
  fastest.toFixed(3),
  'at',
  fastestAt.toFixed(3),
  'ratio',
  (fastest / slope).toFixed(3),
);
