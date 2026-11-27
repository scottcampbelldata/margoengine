import assert from 'node:assert/strict';
import test from 'node:test';
import { WakeSolver } from '../dist/sea.js';
import { PhysicsWorld } from '../dist/world.js';

const gravity = 9.81;
const depth = 0.5;
const sigma = 0.45;
const amplitude = 0.022;
const rate = 60;
const side = 32;
const cells = 128;
const spacing = side / cells;
const cutoff = 9;
const panel = 0.125;
const angularSamples = 256;

// Positive abscissae and weights of the 16-point Gauss–Legendre rule.
const abscissae = [
  0.09501250983763744, 0.2816035507792589, 0.4580167776572274, 0.6178762444026438, 0.755404408355003,
  0.8656312023878318, 0.9445750230732326, 0.9894009349916499,
];
const weights = [
  0.1894506104550685, 0.1826034150449236, 0.16915651939500254, 0.14959598881657673, 0.12462897125553387,
  0.09515851168249278, 0.06225352393864789, 0.027152459411754095,
];
const cosines = Float64Array.from({ length: angularSamples / 4 }, (_, i) =>
  Math.cos((2 * Math.PI * i) / angularSamples),
);

// DLMF 10.9.1. A periodic trapezoid with symmetry to integrate one quadrant.
function besselZero(argument) {
  let sum = 0.5 * (Math.cos(argument) + 1);
  for (let i = 1; i < cosines.length; i++) sum += Math.cos(argument * cosines[i]);
  return sum / cosines.length;
}

// Ellingsen (2014), arXiv:1407.5781, eqs. 28–30 with zero shear and capillarity.
// A Gaussian initially at rest has Hankel transform Aσ² exp(−(σk)²/2).
// Integrate J0(kr) cos(t sqrt(gk tanh(kD))) against this spectrum and k dk.
function reference(radius, time, width = panel) {
  const integrand = (s) => {
    const k = s / sigma;
    const omega = Math.sqrt(gravity * k * Math.tanh(k * depth));
    return s * Math.exp(-0.5 * s * s) * besselZero(k * radius) * Math.cos(omega * time);
  };
  let sum = 0;
  for (let centre = width / 2; centre < cutoff; centre += width) {
    for (let i = 0; i < abscissae.length; i++) {
      const offset = (width / 2) * abscissae[i];
      sum += weights[i] * (integrand(centre - offset) + integrand(centre + offset));
    }
  }
  return (width / 2) * sum;
}

function quadratureBound(radius, time) {
  const spectralTail = Math.exp(-0.5 * cutoff ** 2); // |J0|, |cos| ≤ 1 on the real axis.
  const argument = (cutoff * radius) / sigma;
  // DLMF 10.9.4 implies |Jn(x)| ≤ (x/2)^n/n!. Only angular aliases m = j*N survive.
  let firstAlias = 1;
  for (let i = 1; i <= angularSamples; i++) firstAlias *= argument / (2 * i);
  const angularError = (2 * firstAlias) / (1 - argument / (2 * (angularSamples + 1)));
  // J0(z) is bounded by exp(|Im z|) via its angular integral. On the
  // Cauchy disk |Im s| ≤ 0.5, |tanh(kD)| ≤ 1 since D |Im k| ≤ π/4.
  // The Gauss rule integrates the terms of degree <32 exactly. Bound the
  // higher terms by the Cauchy coefficient estimate and a geometric sum.
  const disk = 0.5;
  const bound =
    (cutoff + disk) *
    Math.exp(disk ** 2 / 2 + (disk * radius) / sigma + time * Math.sqrt((gravity * (cutoff + disk)) / sigma));
  const fraction = panel / (2 * disk);
  return spectralTail + angularError + (2 * cutoff * bound * fraction ** 32) / (1 - fraction);
}

function spectralAliasBound() {
  // The periodized Gaussian has Fourier weights 2πσ²/L² exp(−γ(m²+n²)).
  // Unrepresented terms alias at the sample points. Their old and new cosine
  // factors differ by at most two. Bound all four Nyquist half-planes by
  // the Gaussian sum/integral and use the union bound at the corners.
  const gamma = (2 * Math.PI ** 2 * sigma ** 2) / side ** 2;
  const nyquist = cells / 2;
  const tail = Math.exp(-gamma * nyquist ** 2) * (1 + 1 / (2 * gamma * nyquist));
  const full = 1 + Math.sqrt(Math.PI / gamma);
  return ((16 * Math.PI * sigma ** 2) / side ** 2) * tail * full;
}

function periodicImageBound(radius, time) {
  // Shift the continuum Fourier contour by i*a along the observation ray.
  // For real Fourier vector k, the shifted radial wavenumber q satisfies
  // |Im q| ≤ a and |q| ≤ |k| + a. With D*a < π/4, |tanh(Dq)| ≤ 1.
  const shift = 1.5;
  const tangentAt = 2;
  const slope = (time * Math.sqrt(gravity)) / (2 * Math.sqrt(tangentAt + shift));
  const intercept = time * Math.sqrt(gravity * (tangentAt + shift)) - slope * tangentAt;
  // Bound sqrt(|k|+a) by its tangent, then slope*k ≤ σ²*k²/4 + slope²/σ².
  // The remaining radial Gaussian integral gives the factor two.
  const envelope = 2 * Math.exp((sigma * shift) ** 2 / 2 + intercept + (slope / sigma) ** 2);
  const decay = Math.exp(-shift * side);
  // The j-th square shell contains 8j image origins at distance ≥ jL − r.
  return (8 * envelope * Math.exp(shift * radius) * decay) / (1 - decay) ** 2;
}

function initialImageBound() {
  // The solver starts with one Gaussian. At each grid point the extra
  // periodized images in the j-th shell are at distance ≥ (j−1/2)L.
  // Cosine evolution contracts the discrete L2 norm. sqrt(N*N)=N then bounds
  // the evolved pointwise error from the maximum initial difference.
  const decay = Math.exp(-(side ** 2) / (2 * sigma ** 2));
  return (8 * cells * Math.exp(-(side ** 2) / (8 * sigma ** 2))) / (1 - decay) ** 2;
}

test('SEA-04 releases a finite-depth Cauchy–Poisson ring from a resting Gaussian surface', (t) => {
  const wake = new WakeSolver();
  const world = new PhysicsWorld({ rate: { num: rate, den: 1 }, gravity: [0, -gravity, 0] });
  world.add(wake, {
    cells: [cells, cells],
    cellSize: spacing,
    centre: [spacing / 2, spacing / 2],
    depth,
    sponge: 0,
    initial: (x, z) => [amplitude * Math.exp(-(x * x + z * z) / (2 * sigma ** 2)), 0],
  });
  const ticks = [0, 30, 60, 90];
  const gauges = [
    [0, []],
    [0.5, []],
    [0.75, []],
    [1, []],
    [1.25, [[0.75, 1]]],
    [1.5, []],
    [2, []],
    [2.5, [[1.5, 2]]],
    [3, []],
    [3.75, [[2.25, 3]]],
  ];
  const endTime = ticks.at(-1) / rate;
  const radius = gauges.at(-1)[0];
  // c_g ≤ c_phase ≤ sqrt(gD) in finite depth. The 6σ release and every
  // resolved group stay well inside the box. The image bound also covers
  // nonlocal tails, for which this group-speed estimate is not a front.
  assert.ok(6 * sigma + Math.sqrt(gravity * depth) * endTime < side / 2);
  const quadrature = quadratureBound(radius, endTime);
  const alias = spectralAliasBound();
  const images = periodicImageBound(radius, endTime) + initialImageBound();
  assert.ok(quadrature < 1e-12 && images < 1e-10 && alias < 1e-6);
  const roundoff = 2e-9;
  const budget = quadrature + alias + images + roundoff;
  assert.ok(Math.abs(reference(radius, endTime) - reference(radius, endTime, panel / 2)) < 1e-12);
  let maxError = 0;
  let maxAsymmetry = 0;
  let snapshot;
  const crestRadii = [];
  for (const tick of ticks) {
    world.advance(tick);
    if (tick === ticks[1]) snapshot = world.takeSnapshot();
    const time = tick / rate;
    const profile = gauges.map(([r, diagonals]) => {
      const expected = reference(r, time);
      if (tick === 0) assert.ok(Math.abs(expected - Math.exp(-(r ** 2) / (2 * sigma ** 2))) < 1e-12);
      const probes = [[r, 0], [-r, 0], [0, r], [0, -r], ...diagonals, ...diagonals.map(([x, z]) => [-z, x])];
      const values = probes.map(([x, z]) => wake.sample(x, z).height / amplitude);
      maxError = Math.max(maxError, ...values.map((value) => Math.abs(value - expected)));
      maxAsymmetry = Math.max(maxAsymmetry, Math.max(...values) - Math.min(...values));
      return values[0];
    });
    crestRadii.push(gauges[profile.indexOf(Math.max(...profile))][0]);
    const volume = spacing ** 2 * wake.heights().reduce((sum, value) => sum + value, 0);
    assert.ok(Math.abs(volume / (2 * Math.PI * amplitude * sigma ** 2) - 1) < 1e-10);
  }
  assert.deepEqual(crestRadii, [0, 1, 2, 3]);
  assert.ok(maxError < budget, `normalized elevation error ${maxError} exceeds ${budget}`);
  assert.ok(maxAsymmetry < 2 * budget, `normalized azimuthal variation ${maxAsymmetry} exceeds ${2 * budget}`);
  const hash = world.hash();
  world.restoreSnapshot(snapshot.bytes);
  world.advance(ticks.at(-1));
  assert.equal(world.hash(), hash);
  t.diagnostic(JSON.stringify({ crestRadii, maxError, maxAsymmetry, quadrature, alias, images, budget, hash }));
});
