// KB-LOOK-TV-SHIMMER1: a scattered plant's sway is bounded by its own height and stiffness (CPU side; the GPU pose is
// proven in sway.browser.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { SWAY_REACH, Scatter, swayFrequency, swayTip } from '../dist/index.js';
import { ScatterTiles } from '../dist/tiles.js';
import { SCATTER_SETTINGS, applyScatterSettings } from '../dist/settings.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const close = (a, b, d = 1e-3) => assert.ok(Math.abs(a - b) <= d, `${a} against ${b}`);

test('swayTip keeps a blade bend for short plants and levels off at the reach for tall ones', () => {
  assert.equal(SWAY_REACH, 1.2);
  assert.equal(swayTip(0), 0);
  close(swayTip(0.3), 0.066); // the old blade bend H^2 / (1 + H) gave 0.069
  close(swayTip(5), 0.932);
  close(swayTip(25), 1.142);
  close(swayTip(60), 1.177);
  for (let h = 0; h <= 100; h += 0.25) {
    assert.ok(swayTip(h) <= Math.min(0.3541 * h, 1.2), `bounded at ${h} m`);
    assert.ok(swayTip(h, 10) <= 0.12 && swayTip(h, 0.1) <= 12);
  }
  close(swayTip(25, 2), 0.585);
  assert.throws(() => swayTip(-1), RangeError);
  assert.throws(() => swayTip(2, 0.05), RangeError);
});

test('swayFrequency falls with height (2.55 H^-0.59 Hz)', () => {
  close(swayFrequency(25), 0.382);
  close(swayFrequency(0.3), 5.19, 0.01);
  close(swayFrequency(1), 2.55);
  assert.equal(swayFrequency(0), swayFrequency(0.01));
  assert.throws(() => swayFrequency(Number.NaN), RangeError);
});

test('sway option and live sway: ranges, defaults and the frame values', () => {
  for (const sway of [{ stiffness: 0.05 }, { stiffness: 11 }, { height: 0 }, { height: -2 }, { height: Infinity }, 3])
    assert.throws(() => new Scatter(box(), { count: 4, sway }), RangeError);
  const h = optionalGPU(),
    scatter = new Scatter(box(1, 4, 1), { count: 4, wind: [1, 0, 1, 20] });
  h.engine.use(scatter);
  h.frame();
  assert.deepEqual([...scatter.values.subarray(84, 86)], [2, 1.2].map(Math.fround), 'the box top and the reach');
  scatter.sway = { stiffness: 4, height: 7 };
  h.frame();
  assert.deepEqual([...scatter.values.subarray(84, 86)], [7, 0.3].map(Math.fround));
  assert.throws(() => (scatter.sway = { stiffness: 0 }), RangeError);
  assert.deepEqual(scatter.sway, { stiffness: 4, height: 7 });
  scatter.dispose();
});

test('wind.stiffness setting writes the stiffness and keeps the height', () => {
  const row = SCATTER_SETTINGS.find((r) => r.name === 'wind.stiffness');
  assert.deepEqual([row.default, row.min, row.max], [1, 0.1, 10]);
  const target = new Scatter(box(), { count: 4, sway: { height: 3 } });
  applyScatterSettings(target, { 'wind.stiffness': 2.5 });
  assert.deepEqual(target.sway, { height: 3, stiffness: 2.5 });
});

test('a mesh that shares another sways as one plant: both take the larger top', () => {
  const h = optionalGPU(),
    options = { bounds: [0, 0, 512, 512], slots: 2, slotSize: 4 },
    trunks = new ScatterTiles(box(0.3, 6, 0.3), options),
    crowns = new ScatterTiles(box(2, 2, 2), { ...options, share: trunks });
  h.engine.use(trunks);
  h.engine.use(crowns);
  h.frame();
  assert.equal(trunks.values[84], 3);
  assert.equal(crowns.values[84], 3);
  crowns.dispose();
  trunks.dispose();
});
