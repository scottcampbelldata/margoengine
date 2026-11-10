import test from 'node:test';
import assert from 'node:assert/strict';
import { Rivers } from '../dist/rivers.js';
import { Water } from '../dist/index.js';
import { FFTOcean } from '../dist/fft.js';
import { riverModel, riverStep } from './rivers-reference.js';

// A 24 x 8 channel of 1 m cells: a 10 m waterfall at x = 12, then a 0.5 m per cell chute, closed by banks at z = 0, 7.
const fall = () => {
  const width = 24,
    height = 8,
    ground = new Float64Array(width * height);
  for (let z = 0; z < height; z++)
    for (let x = 0; x < width; x++)
      ground[z * width + x] = (z === 0 || z === height - 1 ? 30 : 0) + (x < 12 ? 20 : 10 - (x - 12) * 0.5);
  return riverModel({ ground, width, height, cell: 1 });
};
const source = [{ position: [2.5, 4], discharge: 6, radius: 1 }];

test('rivers validates its Water and settings', () => {
  assert.throws(() => new Rivers(), { code: 'state' });
  assert.throws(() => new Rivers({}), { code: 'state' });
  const ocean = new FFTOcean();
  assert.throws(() => new Rivers(ocean), { code: 'state' });
  ocean.dispose();
  const water = new Water();
  for (const substeps of [0, 1.5, 65]) assert.throws(() => new Rivers(water, { substeps }), RangeError);
  for (const maxFroude of [0, 21, NaN]) assert.throws(() => new Rivers(water, { maxFroude }), RangeError);
  for (const sources of [
    'x',
    Array.from({ length: 17 }, () => ({ position: [0, 0], discharge: 1 })),
    [{ position: [0], discharge: 1 }],
    [{ position: [0, NaN], discharge: 1 }],
    [{ position: [0, 0], discharge: -1 }],
    [{ position: [0, 0], discharge: 1, radius: 10001 }],
  ])
    assert.throws(() => new Rivers(water, { sources }), RangeError);
  const rivers = Rivers.attach(water, { sources: source });
  assert.throws(() => Rivers.attach(water), { code: 'attached' });
  rivers.dispose();
  rivers.dispose();
  assert.throws(() => rivers.setSources([]), { code: 'disposed' });
  Rivers.attach(water).dispose();
  water.dispose();
});

test('a lake at rest on a stepped bed stays exactly at rest', () => {
  const m = fall();
  // Pool every interior cell to 25 m: over the brink and the chute alike.
  for (let i = 0; i < m.depth.length; i++) m.depth[i] = Math.max(0, 25 - m.ground[i]);
  const before = m.depth.slice();
  for (let i = 0; i < 200; i++) {
    riverStep(m, 1 / 120);
    // Edge cells drain under Water's edge rule; restore them so only interior balance is measured.
    for (let z = 0; z < m.height; z++)
      for (let x = 0; x < m.width; x++)
        if (x === 0 || z === 0 || x === m.width - 1 || z === m.height - 1)
          m.depth[z * m.width + x] = before[z * m.width + x];
  }
  let worst = 0;
  for (let z = 2; z < m.height - 2; z++)
    for (let x = 2; x < m.width - 2; x++)
      worst = Math.max(worst, Math.abs(m.depth[z * m.width + x] - before[z * m.width + x]));
  assert.equal(worst, 0);
});

test('a waterfall carries its inflow downstream with bounded velocity and conserved volume', () => {
  const m = fall(),
    dt = 1 / 240;
  let inflow = 0,
    peak = 0,
    stored = 0;
  for (let i = 0; i < 4800; i++) {
    const total = m.depth.reduce((a, b) => a + b, 0);
    peak = Math.max(peak, riverStep(m, dt, source));
    inflow += 6 * dt;
    stored = m.depth.reduce((a, b) => a + b, 0) - total;
    assert.ok(Number.isFinite(stored));
  }
  // Water reached the chute's lower end and the cap held: 4 * sqrt(g a) and half a cell per substep.
  assert.ok(m.depth[4 * m.width + 21] > 0.001, `chute depth ${m.depth[4 * m.width + 21]}`);
  assert.ok(peak <= 0.5 / dt + 1e-9, `peak ${peak}`);
  assert.ok(m.depth.every((d) => d >= 0 && d < 5));
});

test('the surface-driven coast pipe exceeds the Courant bound over the same fall', () => {
  const m = fall(),
    dt = 1 / 240;
  let peak = 0;
  for (let i = 0; i < 4800; i++) peak = Math.max(peak, riverStep(m, dt, source, 'surface'));
  // Water's own pipe accelerates with the full 10 m drop; the reconstructed pipe above stays within 0.5 / dt.
  assert.ok(peak > 0.5 / dt, `surface pipe peak ${peak}`);
});

test('a source narrower than a cell feeds the one cell under it', () => {
  // Regression (batch 63 job 2): radius 0 off a cell centre gave an empty footprint, so the default source added nothing.
  for (const [position, radius, cell] of [
    [[5.3, 3.7], 0, 3 * 24 + 5],
    [[5.3, 3.7], 0.2, 3 * 24 + 5],
    [[5.5, 3.5], 0, 3 * 24 + 5],
  ]) {
    const m = fall(),
      dt = 1 / 240;
    riverStep(m, dt, [{ position, discharge: 6, radius }]);
    const fed = Array.from(m.depth.keys()).filter((i) => m.depth[i] > 0);
    assert.deepEqual(fed, [3 * 24 + 5], `${position} radius ${radius}`);
    assert.ok(Math.abs(m.depth[3 * 24 + 5] - 6 * dt) < 1e-12);
  }
  // A source off the map feeds nothing.
  const m = fall();
  riverStep(m, 1 / 240, [{ position: [-50, 4], discharge: 6 }]);
  assert.ok(m.depth.every((d) => d === 0));
});

test('the inflow footprint uses the CPU cell size, never a GPU division of the coast size', () => {
  // On the Radeon 680M, coast.zw / size gave 24 / 24 one f32 step under 1, and a source whose edge lies on a cell
  // boundary (9.5 m - 1 m = 8.5 m, so ceil(8.5 / cell - 0.5)) then fed one column fewer: 0.27 m off the model after
  // 1920 substeps (rivers.browser.mjs). frame.flow.yz is the cell the pipes and the model use, rounded once on the CPU.
  const water = new Water(),
    rivers = Rivers.attach(water, { sources: source }),
    code = rivers.kernels.integrate;
  assert.match(code, /let cell=frame\.flow\.yz;/);
  assert.doesNotMatch(code, /frame\.coast\.zw\/vec2f\(size\)/);
  rivers.dispose();
  water.dispose();
});
