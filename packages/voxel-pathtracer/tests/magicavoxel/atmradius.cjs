// Stage fit with the planet radius and atmosphere top free (does MagicaVoxel's curvature differ from Earth's?).
const { samples, error, nelder } = require('./atmfit.cjs');
const sets = [
  [samples('e5', 5), { r: 1, m: 1 }],
  [samples('e20', 20), { r: 1, m: 1 }],
  [samples('e45', 45), { r: 1, m: 1 }],
  [samples('e90', 90), { r: 1, m: 1 }],
  [samples('ray0', 20), { r: 0, m: 1 }],
  [samples('mie0', 20), { r: 1, m: 0 }],
];
const rayK = [45 / 255, 104 / 255, 1];
const P = (x, s) => ({
  E: Math.exp(x[0]),
  sR: s.r * Math.exp(x[1]),
  sM: s.m * Math.exp(x[2]),
  HR: Math.exp(x[3]),
  HM: Math.exp(x[4]),
  g: 0.85,
  phase: 'cs',
  mieExtScale: Math.exp(x[5]),
  R: process.env.FIXR ? Number(process.env.FIXR) : Math.exp(x[6]),
  top: process.env.FIXTOP ? Number(process.env.FIXTOP) : Math.exp(x[7]),
  rayK,
  mieK: [1, 1, 1],
  o3K: [0, 0, 0],
  sO: 0,
  amb: 0,
  steps: 32,
});
const f = (x) => Math.sqrt(sets.reduce((e, [set, s]) => e + error(P(x, s), [set]) ** 2, 0) / sets.length);
const x0 = [
  Math.log(7.077),
  Math.log(0.052599),
  Math.log(0.0041906),
  Math.log(2.8227),
  Math.log(2.3642),
  Math.log(0.57),
  Math.log(Number(process.argv[3] ?? 6360)),
  Math.log(Number(process.argv[4] ?? 100)),
];
console.log('start', f(x0).toFixed(4));
const best = nelder(f, x0, [0.2, 0.2, 0.3, 0.2, 0.3, 0.3, 0.7, 0.4], Number(process.argv[2] ?? 400));
const p = P(best.x, { r: 1, m: 1 });
console.log(
  'rms',
  best.f.toFixed(4),
  JSON.stringify({ E: p.E, sR: p.sR, sM: p.sM, HR: p.HR, HM: p.HM, mieExt: p.mieExtScale, R: p.R, top: p.top }),
);
for (const [set, s] of sets) console.log(set.name.padEnd(6), error(P(best.x, s), [set]).toFixed(3));
