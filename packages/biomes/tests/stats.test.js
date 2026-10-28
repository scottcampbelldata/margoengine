// The statistics entry against known answers: complete spatial randomness gives L near 0, g near 1, G and F near
// 1 - exp(-lambda pi r^2) and J near 1; a lattice is rejected by the global envelopes and a Poisson pattern is not; the
// Kolmogorov-Smirnov and Anderson-Darling tests accept the right distribution and reject a wrong one; quantile
// regression finds a known frontier.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  andersonDarling,
  emptyF,
  globalEnvelope,
  jFunction,
  kFunction,
  ksTest,
  lFunction,
  nearestG,
  pairCorrelation,
  quantileFit,
} from '../dist/stats.js';
import { random } from './random.js';

const poisson = (seed, n, size = 100) => {
  const rng = random(seed),
    x = [],
    z = [];
  for (let i = 0; i < n; i++) {
    x.push(rng() * size);
    z.push(rng() * size);
  }
  return { x, z, window: [0, 0, size, size] };
};
const radii = Float64Array.from({ length: 10 }, (_, i) => 0.5 + i * 0.5);

test('complete spatial randomness: L near 0, g near 1, G and F near 1 - exp(-lambda pi r^2), J near 1', () => {
  const p = poisson(1, 2000),
    lambda = 0.2,
    l = lFunction(p, radii),
    g = pairCorrelation(p, radii, 0.4),
    gg = nearestG(p, radii),
    f = emptyF(p, radii, 80),
    j = jFunction(p, radii.slice(0, 4), 80),
    k = kFunction(p, radii);
  for (let q = 0; q < radii.length; q++) {
    const csr = 1 - Math.exp(-lambda * Math.PI * radii[q] ** 2);
    assert.ok(Math.abs(l[q]) < 0.15, `L(${radii[q]}) ${l[q]}`);
    assert.ok(Math.abs(k[q] / (Math.PI * radii[q] ** 2) - 1) < 0.12, `K(${radii[q]})`);
    if (radii[q] >= 1) assert.ok(Math.abs(g[q] - 1) < 0.2, `g(${radii[q]}) ${g[q]}`);
    assert.ok(Math.abs(gg[q] - csr) < 0.05, `G(${radii[q]}) ${gg[q]} vs ${csr}`);
    assert.ok(Math.abs(f[q] - csr) < 0.05, `F(${radii[q]}) ${f[q]} vs ${csr}`);
  }
  for (const v of j) assert.ok(Math.abs(v - 1) < 0.3, `J ${v}`);
});

test('global envelopes: a Poisson pattern passes, a jittered lattice fails (both kinds)', () => {
  const sims = Array.from({ length: 199 }, (_, i) => lFunction(poisson(100 + i, 500), radii)),
    rng = random(9),
    x = [],
    z = [];
  for (let a = 0; a < 22; a++)
    for (let b = 0; b < 22; b++) {
      x.push((a + 0.5) * (100 / 22) + (rng() - 0.5) * 0.5);
      z.push((b + 0.5) * (100 / 22) + (rng() - 0.5) * 0.5);
    }
  const lattice = lFunction({ x, z, window: [0, 0, 100, 100] }, radii),
    fair = lFunction(poisson(7, 500), radii);
  assert.ok(!globalEnvelope(fair, sims).reject, 'Poisson passes (mad)');
  assert.ok(globalEnvelope(lattice, sims).reject, 'lattice fails (mad)');
  assert.ok(globalEnvelope(lattice, sims, { type: 'rank' }).p <= 0.05, 'lattice fails (rank)');
  const e = globalEnvelope(fair, sims);
  for (let q = 0; q < radii.length; q++) assert.ok(e.lo[q] <= e.hi[q]);
  assert.throws(() => globalEnvelope(fair, sims.slice(0, 5)), RangeError);
});

test('Kolmogorov-Smirnov and Anderson-Darling: accept the right distribution, reject a wrong one', () => {
  const rng = random(3),
    exp = Array.from({ length: 2000 }, () => -Math.log(1 - rng())),
    right = (x) => 1 - Math.exp(-x),
    wrong = (x) => 1 - Math.exp(-1.3 * x);
  assert.ok(ksTest(exp, right).p > 0.05 && andersonDarling(exp, right).p > 0.05);
  assert.ok(ksTest(exp, wrong).p < 0.001 && andersonDarling(exp, wrong).p < 0.001);
});

test('quantile regression finds an upper frontier', () => {
  const rng = random(5),
    x = [],
    y = [];
  for (let i = 0; i < 300; i++) {
    const v = rng() * 4;
    x.push(v);
    y.push(5 - 1.6 * v - rng() * 2); // the frontier is y = 5 - 1.6 x
  }
  const { slope, intercept } = quantileFit(x, y, 0.98);
  assert.ok(Math.abs(slope + 1.6) < 0.15 && Math.abs(intercept - 5) < 0.3, `${slope} ${intercept}`);
});
