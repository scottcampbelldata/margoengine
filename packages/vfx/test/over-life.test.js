import test from 'node:test';
import assert from 'node:assert/strict';
import { VFX } from '../dist/base.js';
import { overLife } from '../dist/over-life.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
test('over-life validates growth, signed spin, zero speed and animated limits', () => {
  assert.throws(() => new VFX({ overLife: { size: [1, 2] } }), /overLife/);
  for (const v of [
    {},
    { size: [1] },
    { size: [1, -1] },
    { speed: [0, Infinity] },
    { spin: [-1001, 0] },
    { velocityLimit: -1 },
  ])
    assert.throws(() => new VFX({ overLife: v }, { overLife }), /overLife/);
  const h = optionalGPU();
  h.engine.stats = { drawCalls: 0 };
  const effect = new VFX(
    { capacity: 32, overLife: { size: [0, 4], speed: [0, 2], spin: [-2, 4], velocityLimit: [2, 0] } },
    { overLife },
  );
  h.engine.use(effect);
  h.frame();
  const curve = h.resources.find((r) => r.size === 528),
    counts = new Uint32Array(curve.data, 0, 4),
    values = new Float32Array(curve.data);
  assert.deepEqual([...counts], [2, 2, 2, 2]);
  assert.deepEqual([...values.slice(68, 70)], [0, 4]);
  assert.equal(h.resources.filter((r) => r.size === 512).length, 1);
  effect.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
  h.cleanup();
});
