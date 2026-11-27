import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WAKE_BREAKING_HEADER_WORDS,
  WAKE_BREAKING_LAYOUT,
  WAKE_BREAKING_THRESHOLD,
  WAKE_BREAKING_WORDS,
  writeWakeBreaking,
} from '../src/sea/wake-breaking.ts';

const box = { cells: [15, 13], cellSize: 0.2, origin: [5, -7] };
const normal = [0.6, 0.8];
const dt = 0.02;
const crestHeight = 0.24;
const origin = [6.5, -5.7];
const offset = 0.033;

function field({ cells: [nx, nz], origin: [x0, z0], cellSize }, evaluate) {
  return Float64Array.from({ length: nx * nz }, (_, i) =>
    evaluate(x0 + ((i % nx) + 0.5) * cellSize, z0 + (Math.floor(i / nx) + 0.5) * cellSize),
  );
}

function signalRegion(capacity = 256) {
  return new Float64Array(WAKE_BREAKING_HEADER_WORDS + WAKE_BREAKING_WORDS * capacity);
}

function signalRows(out) {
  return Array.from({ length: out[0] }, (_, row) => {
    const begin = WAKE_BREAKING_HEADER_WORDS + row * WAKE_BREAKING_WORDS;
    return Array.from(out.subarray(begin, begin + WAKE_BREAKING_WORDS));
  });
}

function along(x, z) {
  return normal[0] * (x - origin[0]) + normal[1] * (z - origin[1]);
}

function movingCrest(crestSpeed, particleSpeed, current = [0, 0]) {
  const projectedCurrent = normal[0] * current[0] + normal[1] * current[1];
  const oldOffset = offset - (crestSpeed + projectedCurrent) * dt;
  const shape = (displacement) => field(box, (x, z) => crestHeight - 0.4 * (along(x, z) - displacement) ** 2);
  return {
    previous: shape(oldOffset),
    height: shape(offset),
    potential: field(box, (x, z) => {
      const distance = along(x, z) - offset;
      const tangent = normal[0] * (z - origin[1]) - normal[1] * (x - origin[0]);
      // Add a transverse flow and a nonconstant normal flow: only the
      // along-crest-motion gradient at the fitted subcell crest should count.
      return particleSpeed * distance + 0.5 * distance ** 2 + 2 * tangent;
    }),
  };
}

function diagnose(inputs, out = signalRegion(), current, pressure, damping) {
  writeWakeBreaking(out, box, inputs.previous, inputs.height, inputs.potential, dt, current, pressure, damping);
  return out;
}

test('SEA-04 resolves a subcell crest and particle velocity in a common water frame', () => {
  const cases = [
    { crestSpeed: 1.25, current: [0, 0] },
    // A following or opposing uniform current changes ground motion; this
    // opposing flow even reverses ground motion while retaining the ratio.
    { crestSpeed: 1.25, current: [-1.3, -1.2] },
    { crestSpeed: -1.25, current: [0.6, 0.1] },
  ];
  for (const { crestSpeed, current } of cases) {
    const particleSpeed = 0.91 * crestSpeed;
    const out = diagnose(movingCrest(crestSpeed, particleSpeed, current), undefined, current);
    assert.ok(out[0] > 5);
    assert.equal(out[0], out[1]);
    for (const [x, z, h, nx, nz, c, u, b] of signalRows(out)) {
      const sign = Math.sign(crestSpeed);
      for (const [actual, expected] of [
        [along(x, z), offset],
        [h, crestHeight],
        [nx, sign * normal[0]],
        [nz, sign * normal[1]],
        [c, Math.abs(crestSpeed)],
        [u, Math.abs(particleSpeed)],
        [b, particleSpeed / crestSpeed],
      ])
        assert.ok(Math.abs(actual - expected) < 2e-12, `${actual} differs from ${expected}`);
    }
  }
});

test('SEA-04 measures converging crest and fluid speeds on a resolved travelling mode', (t) => {
  const waveNumber = Math.PI;
  const depth = 0.48;
  const crestSpeed = Math.sqrt((9.81 / waveNumber) * Math.tanh(waveNumber * depth));
  const particleSpeed = 0.98 * crestSpeed;
  const shift = 0.037;
  const errors = [16, 32, 64].map((n) => {
    const grid = { cells: [2 * n, 2 * n], cellSize: 2 / n, origin: [-2, -2] };
    // Refine space and time together with a fixed quarter-cell crest shift.
    const step = (0.25 * grid.cellSize) / crestSpeed;
    const phase = (x, z) => waveNumber * (normal[0] * x + normal[1] * z - shift);
    const height = field(grid, (x, z) => crestHeight * Math.cos(phase(x, z)));
    const previous = field(grid, (x, z) => crestHeight * Math.cos(phase(x, z) + waveNumber * crestSpeed * step));
    const potential = field(grid, (x, z) => (particleSpeed / waveNumber) * Math.sin(phase(x, z)));
    const out = signalRegion(8 * n);
    writeWakeBreaking(out, grid, previous, height, potential, step);
    assert.ok(out[0] > n);
    assert.equal(out[0], out[1]);
    const maxError = (compare) => Math.max(...signalRows(out).map(compare));
    return {
      crest: maxError((row) => Math.abs(row[5] - crestSpeed) / crestSpeed),
      particle: maxError((row) => Math.abs(row[6] - particleSpeed) / particleSpeed),
    };
  });
  t.diagnostic(JSON.stringify(errors));
  for (const quantity of ['crest', 'particle']) {
    assert.ok(errors[1][quantity] < errors[0][quantity] * 0.35);
    assert.ok(errors[2][quantity] < errors[1][quantity] * 0.35 && errors[2][quantity] < 0.005);
  }
});

test('SEA-04 leaves untrackable, subthreshold, counterflow and forced stencils without a breaking signal', () => {
  for (const state of [movingCrest(0, 1), movingCrest(1.25, -1.25), movingCrest(1, 0.83), movingCrest(20, 20)]) {
    const out = diagnose(state, signalRegion(1));
    assert.deepEqual([...out], [0, 0, box.cellSize, ...Array(WAKE_BREAKING_WORDS).fill(0)]);
  }
  const isotropic = movingCrest(1, 1);
  isotropic.height = field(box, (x, z) => crestHeight - 0.4 * ((x - origin[0]) ** 2 + (z - origin[1]) ** 2));
  assert.equal(diagnose(isotropic)[0], 0);
  const state = movingCrest(1, 1);
  const pressure = new Float64Array(state.height.length).fill(101);
  const damping = new Float64Array(state.height.length).fill(0.5);
  assert.equal(diagnose(state, undefined, undefined, pressure)[0], 0);
  assert.equal(diagnose(state, undefined, undefined, undefined, damping)[0], 0);
});

test('SEA-04 writes a bounded deterministic layout-1 region and clears old rows', () => {
  assert.equal(WAKE_BREAKING_LAYOUT, 1);
  const state = movingCrest(1, 1);
  const complete = diagnose(state);
  const capped = diagnose(state, signalRegion(2).fill(22));
  assert.equal(capped[0], 2);
  assert.equal(capped[1], complete[1]);
  assert.deepEqual(signalRows(capped), signalRows(complete).slice(0, 2));
  assert.deepEqual(diagnose(state, signalRegion(2)), capped);
  assert.deepEqual(diagnose(movingCrest(0, 1), capped), diagnose(movingCrest(0, 1), signalRegion(2)));
  assert.throws(
    () => diagnose(state, new Float64Array(9)),
    (error) => error.code === 'state' && /Match the breaking grid/.test(error.message),
  );
  const unchanged = state.height.slice();
  assert.throws(
    () => diagnose(state, state.height.subarray(0, WAKE_BREAKING_HEADER_WORDS + WAKE_BREAKING_WORDS)),
    (error) => error.code === 'state' && /region disjoint/.test(error.message),
  );
  assert.deepEqual(state.height, unchanged);
});

test('SEA-04 checks the fixed onset ratio against Saket intermediate-depth crest measurements', (t) => {
  // Saket et al. (2018), Table 1, https://arxiv.org/abs/1703.04354.
  // All 13 unforced groups, measured pairs [C, Us] in m/s.
  const table = [
    [0.959, 0.791, 0.964, 0.837],
    [0.958, 0.768, 0.967, 0.826],
    [0.887, 0.726, 0.904, 0.786],
    [0.87, 0.688, 0.896, 0.761],
    [1.028, 0.794, 1.055, 0.886],
    [0.944, 0.753, 0.963, 0.824],
    [0.95, 0.743, 0.965, 0.812],
    [0.893, 0.693, 0.921, 0.806],
    [0.867, 0.654, 0.903, 0.782],
    [1.191, 0.936, 1.24, 1.041],
    [1.209, 0.955, 1.232, 1.043],
    [1.137, 0.918, 1.17, 0.995],
    [1.109, 0.879, 1.123, 0.963],
  ];
  let triggered = 0;
  let widestMiss = 0;
  for (const [cRecurring, uRecurring, cMarginal, uMarginal] of table) {
    assert.equal(diagnose(movingCrest(cRecurring, uRecurring), signalRegion(1))[0], 0);
    if (diagnose(movingCrest(cMarginal, uMarginal), signalRegion(1))[0]) triggered++;
    else widestMiss = Math.max(widestMiss, WAKE_BREAKING_THRESHOLD - uMarginal / cMarginal);
  }
  assert.equal(triggered, 8);
  assert.ok(widestMiss < 0.02, 'all nominal marginal misses are within the reported uncertainty of a data point');
  t.diagnostic(JSON.stringify({ marginalTriggered: triggered, marginalTotal: table.length, widestMiss }));
});
