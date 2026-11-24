// The settings table of @margoengine/biomes/settings: every row rebuilds (erosion is a one-shot), the defaults give the
// bytes of a plain erode, ranges are enforced, the named looks are only row values and each changes the heights.
import test from 'node:test';
import assert from 'node:assert/strict';
import { erode } from '../dist/erosion.js';
import { createRelief } from '../dist/relief.js';
import {
  EROSION_LIVE_SETTINGS,
  EROSION_LOOKS,
  EROSION_SETTINGS,
  erodeReliefWithSettings,
  erodeWithSettings,
  erosionOptions,
  erosionSettingDefaults,
} from '../dist/settings.js';

const step = 16000;
// A seeded rough slope in mm with a valley down its middle (as tests/erosion.test.js).
function rough(nx, nz, seed = 3, noise = 18) {
  const h = new Int32Array(nx * nz);
  for (let z = 0; z < nz; z++)
    for (let x = 0; x < nx; x++) {
      const r = Math.imul((x * 73856093) ^ (z * 19349663) ^ seed, 2654435761) >>> noise;
      h[z * nx + x] = 20000 + 2500 * Math.abs(x - (nx >> 1)) + 1800 * z + r * 6;
    }
  return h;
}
const grid = () => ({ height: rough(33, 33), nx: 33, nz: 33, step });
const same = (a, b) =>
  ['height', 'flow', 'direction', 'wear', 'deposit'].every(
    (k) => Buffer.compare(Buffer.from(a[k].buffer), Buffer.from(b[k].buffer)) === 0,
  ) && a.outflow === b.outflow;

test('every row is well formed, unique and not live', () => {
  const names = new Set();
  for (const s of EROSION_SETTINGS) {
    assert.ok(!names.has(s.name), s.name);
    names.add(s.name);
    assert.equal(s.live, false, s.name);
    assert.equal(s.kind, 'number', s.name);
    assert.ok(s.about.length > 10 && typeof s.unit === 'string', s.name);
    if (s.default === null) assert.equal(s.nullable, true, s.name);
    else assert.ok(s.default >= s.min && s.default <= s.max, s.name);
  }
  assert.equal(EROSION_LIVE_SETTINGS.length, 0);
  assert.deepEqual(
    Object.keys(erosionSettingDefaults()),
    EROSION_SETTINGS.map((s) => s.name),
  );
});

test('the defaults give the bytes of a plain erode, on a grid and on a relief', () => {
  assert.ok(same(erodeWithSettings(grid()), erode(grid())));
  assert.ok(same(erodeWithSettings(grid(), erosionSettingDefaults()), erode(grid())));
  assert.deepEqual(erosionOptions(), {
    iterations: 32,
    talus: 35,
    thermal: 0.25,
    capacity: 0.01,
    incision: 0.25,
    deposition: 0.5,
  });
  const relief = createRelief({ seed: 4, size: [4096, 4096], origin: [0, 0] });
  const plain = createRelief({ seed: 4, size: [4096, 4096], origin: [0, 0], erosion: { step: 256 } });
  const withSettings = erodeReliefWithSettings(relief, { 'relief.step': 256 });
  for (const [x, z] of [
    [0, 0],
    [1000, 2000],
    [4096, 4096],
  ])
    assert.equal(withSettings.height(x, z), plain.height(x, z));
});

test('values land in the options, the sea in millimetres', () => {
  assert.deepEqual(erosionOptions({ 'erosion.iterations': 8, 'erosion.sea': 1.5, 'erosion.talus': 50 }), {
    iterations: 8,
    talus: 50,
    thermal: 0.25,
    capacity: 0.01,
    incision: 0.25,
    deposition: 0.5,
    sea: 1500,
  });
  assert.ok(
    erodeWithSettings(grid(), { 'erosion.iterations': 0 }).wear.every((v) => v === 0),
    'no rounds, no wear',
  );
  assert.ok(!same(erodeWithSettings(grid(), { 'erosion.sea': 100 }), erode(grid())), 'a sea changes the drainage');
});

test('values are checked against their rows: unknown names throw TypeError, bad values RangeError', () => {
  assert.throws(() => erodeWithSettings(grid(), { 'erosion.rain': 1 }), TypeError);
  for (const s of EROSION_SETTINGS) {
    assert.throws(() => erosionOptions({ [s.name]: s.max + 1 }), RangeError, s.name);
    assert.throws(() => erosionOptions({ [s.name]: s.min - 1 }), RangeError, s.name);
    assert.throws(() => erosionOptions({ [s.name]: 'x' }), RangeError, s.name);
    if (!s.nullable) assert.throws(() => erosionOptions({ [s.name]: null }), RangeError, s.name);
  }
  assert.throws(() => erosionOptions({ 'erosion.iterations': 1.5 }), RangeError);
  // A relief's row is not an option of erode; a relief's sea is its own.
  assert.throws(() => erodeWithSettings(grid(), { 'relief.step': 64 }), TypeError);
  const relief = createRelief({ seed: 4, size: [4096, 4096], origin: [0, 0] });
  assert.throws(() => erodeReliefWithSettings(relief, { 'erosion.sea': 5 }), TypeError);
});

test('the named looks are only row values, in range, and each changes the heights and differs from the others', () => {
  const names = new Set(EROSION_SETTINGS.map((s) => s.name)),
    plain = erode(grid()),
    seen = [plain];
  assert.deepEqual(Object.keys(EROSION_LOOKS), ['youngHills', 'oldWornHills', 'badlands', 'riverValley', 'desertWadi']);
  for (const [name, values] of Object.entries(EROSION_LOOKS)) {
    for (const key of Object.keys(values)) assert.ok(names.has(key), `${name}: ${key}`);
    const eroded = erodeWithSettings(grid(), values);
    for (const other of seen) assert.ok(!same(eroded, other), `${name} differs`);
    seen.push(eroded);
  }
});

test('disturbance rows: build-time only, defaults are those of disturbanceStates, ranges and the year rules are enforced', async () => {
  const { DISTURBANCE_SETTINGS, DISTURBANCE_LIVE_SETTINGS, disturbanceOptions, disturbanceSettingDefaults } = await import('../dist/settings.js');
  assert.equal(DISTURBANCE_SETTINGS.length, 8);
  assert.ok(DISTURBANCE_SETTINGS.every((r) => r.live === false) && DISTURBANCE_LIVE_SETTINGS.length === 0);
  const names = DISTURBANCE_SETTINGS.map((r) => r.name);
  assert.equal(new Set(names).size, 8);
  assert.deepEqual(Object.keys(disturbanceSettingDefaults()), names);
  assert.deepEqual(disturbanceOptions(), { intensity: 2000, ambient: 25, wind: 2, burnYears: 1, charYears: 30, floodPeriod: 10, floodMark: 0.5, cell: 8 });
  assert.equal(disturbanceOptions({ 'disturbance.intensity': 6000 }).intensity, 6000);
  assert.throws(() => disturbanceOptions({ 'disturbance.nope': 1 }), TypeError);
  for (const row of DISTURBANCE_SETTINGS) {
    assert.throws(() => disturbanceOptions({ [row.name]: row.min - 1 }), RangeError, row.name);
    assert.throws(() => disturbanceOptions({ [row.name]: row.max + 1 }), RangeError, row.name);
  }
  assert.throws(() => disturbanceOptions({ 'disturbance.burnYears': 1.5 }), RangeError);
  assert.throws(() => disturbanceOptions({ 'disturbance.burnYears': 5, 'disturbance.charYears': 3 }), RangeError);
});
