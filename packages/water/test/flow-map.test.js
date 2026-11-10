import test from 'node:test';
import assert from 'node:assert/strict';
import { Water } from '../dist/index.js';
import { WaterFlow } from '../dist/flow.js';

test('flow validates all construction settings and copies authored vectors', () => {
  const surface = new Water();
  for (const settings of [
    { speed: -1 },
    { strength: NaN },
    { tileSize: 0 },
    { period: Infinity },
    { direction: [2, 0] },
    { origin: [1] },
    { size: [0, 1] },
    { signed: 1 },
    { normalMaps: [() => undefined] },
    { map: 1 },
  ])
    assert.throws(() => new WaterFlow({ surface, ...settings }));
  assert.throws(() => new WaterFlow({}), /surface/);
  const direction = [1, 0];
  const flow = new WaterFlow({ surface, direction });
  direction[0] = NaN;
  assert.equal(flow.setTime(1), flow);
  assert.throws(() => flow.setTime(NaN), /time/);
  flow.dispose();
  flow.dispose();
  assert.throws(() => flow.setTime(0), { code: 'disposed' });
  surface.dispose();
});
