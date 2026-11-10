import test from 'node:test';
import assert from 'node:assert/strict';
import { Water } from '../dist/index.js';
import { WaterScatter } from '../dist/scatter.js';

test('scatter validates settings atomically, copies them and disposes once', () => {
  const surface = new Water();
  for (const settings of [
    { strength: -1 },
    { strength: 101 },
    { power: 0.1 },
    { power: NaN },
    { distortion: 2 },
    { color: [1, 1] },
    { color: [1, 1, 2] },
  ])
    assert.throws(() => new WaterScatter({ surface, ...settings }), /scatter/);
  assert.throws(() => new WaterScatter({}), /surface/);
  const color = [0.1, 0.5, 0.4];
  const scatter = new WaterScatter({ surface, color, power: 8 });
  color[0] = NaN;
  assert.deepEqual(
    scatter.settings.color.map((c) => Math.round(c * 100) / 100),
    [0.1, 0.5, 0.4],
  );
  assert.equal(scatter.settings.power, 8);
  assert.equal(scatter.settings.distortion, Math.fround(0.3));
  // A bad field leaves every other field as it was.
  assert.throws(() => scatter.set({ strength: 2, distortion: -1 }), /distortion/);
  assert.equal(scatter.settings.strength, 1);
  assert.equal(scatter.set({ strength: 2 }), scatter);
  assert.equal(scatter.settings.strength, 2);
  scatter.dispose();
  scatter.dispose();
  assert.throws(() => scatter.set({}), { code: 'disposed' });
  surface.dispose();
});
