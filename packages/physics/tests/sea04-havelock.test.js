import assert from 'node:assert/strict';
import test from 'node:test';
import { WakeSolver } from '../dist/sea.js';
import { PhysicsWorld } from '../dist/world.js';

const gravity = 9.81;
const density = 1000;
const head = 0.05;
const speed = 3.75;
const radius = 0.8;
const cells = 160;
const dx = 0.125;
const startX = -3;
const rate = 60;
const scale = (2 * Math.PI) / (cells * dx);
const gauges = [
  [-2.5, 0.75],
  [-1.375, 0.875],
  [-2.25, 1.5],
  [0.125, 1.25],
  [-3, 2],
];

// Havelock (1908), §§12–13, eqs. 67–69, https://doi.org/10.1098/rspa.1908.0097.
// Convolve his deep-water point impulse with b(s) = (1+cos(πs))/2 for 0 ≤ s < 1.
// For q=kR, B(q)=∫₀¹ s b(s) J₀(qs) ds. A pressure held at the midpoint of tick j gives
// -head ∫₀∞ q B(q) J₀(q |gauge−source_j|/R) [cos(ω(T−t_{j+1}))−cos(ω(T−t_j))] dq,
// where ω=√(gq/R). The observations below sum all holds from rest in metres, with no amplitude fit.
// Evaluation recipe: expand b in powers of 1−s² through degree 25 (constant and linear terms vanish).
// Coefficient m is ½ Σ_{n≥m} (−1)^(n+m) π^(2n) binom(n,m)/(2n)!. The transform of each term
// is 2^m m! J_{m+1}(q)/q^(m+1). Use 70-digit coefficients, Jv/J0, and 16-point Gauss–Legendre
// panels of width 1/8 through q=4096. Independent 12-point panels of width 1/4 agreed within 8e−18 m.
const continuum = new Map([
  [
    60,
    [-0.00494016342851703, -0.012462613162271888, -0.0010561317356112064, 0.003177146381180706, 0.00047976972126111513],
  ],
  [
    90,
    [0.004840502516605459, 0.010099763120139393, -0.0050193267650268485, -0.004402735568458584, -0.0034656142269922636],
  ],
]);

function continuumBound(x, z, ticks) {
  const cutoff = 4096;
  // Two radial integrations by parts with Δb=b''+b'/s and the J₁ primitive give
  // |B(q)| ≤ 3[|Δb(1)|+∫₀¹√s |(Δb)'| ds]/q^(7/2).
  // |(Δb)'| ≤ (π³/2)(1+1/2) follows by writing sinc(πs)=∫₀¹ cos(πsu) du.
  // |J₀(w)|,|J₁(w)| ≤ 3/√w: in their angular integrals, split the ends at 1/√w and integrate
  // the interior by parts using sin(θ) ≥ 2 min(θ,π−θ)/π. For w<1 use |J| ≤ 1 instead.
  // |gauge−source_j| ≥ z, and each cosine difference has modulus at most two.
  const laplacianVariation = (Math.PI ** 2 + Math.PI ** 3) / 2;
  const tail = (head * 9 * ticks * laplacianVariation * Math.sqrt(radius / z)) / cutoff ** 2;
  // The integrand is entire in q. On each unit Cauchy disk, |J₀(qs)| ≤ e^s, and
  // |Im sqrt(q)| ≤ 1. A degree-31 exact rule bounds the remaining geometric Taylor tail.
  const far = Math.max(Math.hypot(x - startX, z), Math.hypot(x - startX - (speed * ticks) / rate, z)) / radius;
  const envelope = head * (cutoff + 1) * ticks * Math.exp(1 + far + (ticks / rate) * Math.sqrt(gravity / radius));
  const fraction = 1 / 16;
  const quadrature = (2 * cutoff * envelope * fraction ** 32) / (1 - fraction);
  // The pressure polynomial remainder is bounded by Cauchy's estimate on |1−s²|=16.
  const pressureRemainder = (0.5 * (1 + Math.exp(Math.PI * Math.sqrt(17))) * 16 ** -26) / (1 - 1 / 16);
  const polynomial = (head * ticks * cutoff ** 2 * pressureRemainder) / 2;
  return tail + quadrature + polynomial + 2e-12;
}

// Independent finite periodic check. The patch crosses exactly half a cell per tick, so only two
// sampled stencils are needed. Transform their pressure by direct summation, without the engine FFT,
// and convolve every held impulse with the exact linear Green function at each displayed grid mode.
function periodicReference(ticks) {
  const extent = Math.ceil(radius / dx) + 1;
  const result = new Float64Array(gauges.length);
  for (let iz = -cells / 2; iz < cells / 2; iz++) {
    const kz = iz * scale;
    const columns = [0.25, 0.75].map((offset) =>
      Array.from({ length: 2 * extent + 1 }, (_, i) => {
        let sum = 0;
        for (let j = -extent; j <= extent; j++) {
          const s = Math.hypot((i - extent - offset) * dx, j * dx) / radius;
          if (s < 1) sum += 0.5 * (1 + Math.cos(Math.PI * s)) * Math.cos(kz * j * dx);
        }
        return sum;
      }),
    );
    for (let ix = -cells / 2; ix < cells / 2; ix++) {
      const kx = ix * scale;
      const phase = Math.sqrt(gravity * Math.hypot(kx, kz)) / rate;
      const pressure = columns.map((column) => {
        let re = 0;
        let im = 0;
        for (const [i, value] of column.entries()) {
          const angle = -kx * ((i - extent) * dx);
          re += value * Math.cos(angle);
          im += value * Math.sin(angle);
        }
        return [re, im];
      });
      let re = 0;
      let im = 0;
      for (let j = 0; j < ticks; j++) {
        const angle = -kx * (startX + Math.floor(j / 2) * dx);
        const a = Math.cos(angle);
        const b = Math.sin(angle);
        const [p, q] = pressure[j % 2];
        const held = Math.cos(phase * (ticks - j - 1)) - Math.cos(phase * (ticks - j));
        re += (a * p - b * q) * held;
        im += (a * q + b * p) * held;
      }
      for (const [i, [x, z]] of gauges.entries()) {
        const angle = kx * x + kz * z;
        result[i] -= (head / (cells * cells)) * (re * Math.cos(angle) - im * Math.sin(angle));
      }
    }
  }
  return result;
}

test('SEA-04 reproduces Havelock’s finite-time moving-pressure amplitude at absolute gauges', (t) => {
  const wake = new WakeSolver();
  const world = new PhysicsWorld({ rate: { num: rate, den: 1 }, gravity: [0, -gravity, 0] });
  world.add(wake, {
    cells: [cells, cells],
    cellSize: dx,
    centre: [dx / 2, dx / 2],
    density,
    depth: Infinity,
    sponge: 0,
    sources: (time) => [{ x: startX + speed * time, z: 0, radius, pressure: density * gravity * head, volume: 0 }],
  });
  let maxPeriodicError = 0;
  let maxContinuumError = 0;
  let maxContinuumBudget = 0;
  let checkpoint;
  for (const [ticks, integral] of continuum) {
    const periodic = periodicReference(ticks);
    // Conservative floating-point allowance for the direct sums over all cells and all held steps.
    const roundoff = 64 * Number.EPSILON * cells * cells * ticks * head;
    const budgets = gauges.map(([x, z], i) => {
      const quadrature = continuumBound(x, z, ticks);
      const samplingAndImages = Math.abs(periodic[i] - integral[i]);
      // This a priori budget uses the two independent references, before the solver advances.
      // Their difference includes the finite periodic box and rasterized pressure together.
      assert.ok(samplingAndImages < head / 400);
      return samplingAndImages + quadrature + roundoff;
    });
    world.advance(ticks);
    if (ticks === 60) checkpoint = world.takeSnapshot();
    for (const [i, [x, z]] of gauges.entries()) {
      const height = wake.sample(x, z).height;
      const periodicError = Math.abs(height - periodic[i]);
      const continuumError = Math.abs(height - integral[i]);
      assert.ok(periodicError < roundoff, `periodic moving pressure at (${x}, ${z}) tick ${ticks}: ${periodicError}`);
      assert.ok(continuumError < budgets[i], `Hankel amplitude at (${x}, ${z}) tick ${ticks}: ${continuumError}`);
      maxPeriodicError = Math.max(maxPeriodicError, periodicError);
      maxContinuumError = Math.max(maxContinuumError, continuumError);
      maxContinuumBudget = Math.max(maxContinuumBudget, budgets[i]);
    }
    assert.ok(Math.abs(dx * dx * wake.heights().reduce((sum, value) => sum + value, 0)) < 1e-11);
  }
  const accepted = world.hash();
  world.restoreSnapshot(checkpoint.bytes);
  world.advance(90);
  assert.equal(world.hash(), accepted);
  t.diagnostic(JSON.stringify({ maxPeriodicError, maxContinuumError, maxContinuumBudget, accepted }));
});
