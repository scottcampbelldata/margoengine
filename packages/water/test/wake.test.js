// WaterWake (`@margoengine/water/wake`) on the CPU: what it refuses, each with its fix named, and that a wake grid it
// accepts is a real one. The drawn surface itself is checked on the GPU (test/wake-agreement.browser.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { wallOvertoppingSpawn, WaterWake } from '../dist/wake.js';

const water = { onDispose: () => () => {} };
const wake = (cells = [64, 32], cellSize = 0.5) => ({
  grid: { cells, cellSize, origin: [-16, -8] },
  heights: () => new Float64Array(cells[0] * cells[1]),
});

test('WaterWake refuses a missing Water, a wake without a grid and a grid too small to read', () => {
  const coded = { name: 'MargoError', code: 'state' };
  assert.throws(() => new WaterWake({ wake: wake() }), { ...coded, message: /pass options\.surface/ });
  assert.throws(() => new WaterWake({ surface: water, wake: { heights: () => [] } }), {
    ...coded,
    message: /pass a WakeSolver/,
  });
  for (const grid of [wake([3, 64]), wake([64, 64], 0), wake(null), wake([64, 64], Infinity)])
    assert.throws(() => new WaterWake({ surface: water, wake: grid }), { ...coded, message: /4 x 4/ });
  assert.throws(() => new WaterWake({ surface: water, wake: wake(), minWetZ: NaN }), {
    ...coded,
    message: /finite world Z/,
  });
  assert.throws(() => new WaterWake(undefined), coded);
});

test('wall spray checks runtime samples and uses only a resolved rising crest crossing', () => {
  const before = { height: 0.5, velocity: [0, 1, 0] };
  const after = { height: 1.5, velocity: [2, 3, 0] };
  const crest = [10, 1, -3];
  const coded = { name: 'MargoError', code: 'state', message: /consecutive samples.+XYZ crest/ };
  for (const malformed of [
    null,
    {},
    { height: NaN, velocity: [0, 0, 0] },
    { height: 1, velocity: [0, 0] },
    { height: 1, velocity: [0, Infinity, 0] },
  ]) {
    assert.throws(() => wallOvertoppingSpawn(malformed, after, crest), coded);
    assert.throws(() => wallOvertoppingSpawn(before, malformed, crest), coded);
  }
  for (const malformed of [null, [0, 0], [0, 0, 0, 0], [0, Infinity, 0]])
    assert.throws(() => wallOvertoppingSpawn(before, after, malformed), coded);
  assert.deepEqual(wallOvertoppingSpawn(before, after, crest), {
    position: crest,
    velocity: [1, 2, 0],
    fraction: 0.5,
  });
  assert.equal(wallOvertoppingSpawn(before, after, [0, 2, 0]), undefined);
  assert.equal(wallOvertoppingSpawn(after, before, crest), undefined);
  assert.equal(
    wallOvertoppingSpawn({ ...before, velocity: [0, -3, 0] }, { ...after, velocity: [0, -1, 0] }, crest),
    undefined,
  );
});

test('a WaterWake for a real grid has its own plugin name, and needs a WebGPU engine to draw', () => {
  const a = new WaterWake({ surface: water, wake: wake() }),
    b = new WaterWake({ surface: water, wake: wake([16, 16], 2) });
  assert.match(a.name, /^water:wake-\d+$/);
  assert.notEqual(a.name, b.name);
  assert.throws(() => a.setup({ gpu: null }), /needs a WebGPU engine; attach it to the Water's engine/);
  b.dispose();
  assert.throws(() => b.setup({ gpu: {} }), /disposed; attach a new one/);
});
