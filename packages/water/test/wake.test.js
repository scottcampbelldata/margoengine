// WaterWake (`@margoengine/water/wake`) on the CPU: what it refuses, each with its fix named, and that a wake grid it
// accepts is a real one. The drawn surface itself is checked on the GPU (test/wake-agreement.browser.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { WaterWake } from '../dist/wake.js';

const water = { onDispose: () => () => {} };
const wake = (cells = [64, 32], cellSize = 0.5) => ({
  grid: { cells, cellSize, origin: [-16, -8] },
  heights: () => new Float64Array(cells[0] * cells[1]),
});

test('WaterWake refuses a missing Water, a wake without a grid and a grid too small to read', () => {
  assert.throws(() => new WaterWake({ wake: wake() }), { name: 'TypeError', message: /pass options\.surface/ });
  assert.throws(() => new WaterWake({ surface: water, wake: { heights: () => [] } }), {
    name: 'TypeError',
    message: /pass a WakeSolver/,
  });
  assert.throws(() => new WaterWake({ surface: water, wake: wake([3, 64]) }), { name: 'TypeError', message: /4 x 4/ });
  assert.throws(() => new WaterWake({ surface: water, wake: wake([64, 64], 0) }), TypeError);
  assert.throws(() => new WaterWake(undefined), TypeError);
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
