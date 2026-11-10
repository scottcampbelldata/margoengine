import test from 'node:test';
import assert from 'node:assert/strict';
import { VFX } from '../dist/base.js';
import { shapes } from '../dist/shapes.js';
import { emitter } from '../dist/emitter.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
test('new shapes validate distributions and delegate all original emitters', () => {
  for (const e of [
    { shape: 'hemisphere', radius: -1 },
    { shape: 'torus', tube: 1 },
    { shape: 'cylinder', height: 0 },
    { shape: 'rectangle-edge', width: 0 },
    { shape: 'grid', columns: 2.5 },
    { shape: 'grid', columns: 10000, rows: 10000 },
    { shape: 'grid', spacing: [1, NaN, 1] },
  ])
    assert.throws(() => new VFX({ emitter: e }, { emitter: shapes }), /VFX/);
  assert.throws(() => new VFX({ emitter: { shape: 'torus' } }, { emitter }), /shape/);
  for (const shape of ['hemisphere', 'cylinder', 'torus', 'rectangle-edge', 'grid', 'sphere', 'cone']) {
    const h = optionalGPU();
    h.engine.stats = { drawCalls: 0 };
    const e = new VFX({ capacity: 32, emitter: { shape } }, { emitter: shapes });
    h.engine.use(e);
    h.frame();
    if (!['sphere', 'cone'].includes(shape))
      assert.ok(h.pipelines.some((p) => p.compute?.module.code.includes('birthShape')));
    e.dispose();
    assert.ok(h.resources.every((r) => r.destroyed));
    h.cleanup();
  }
});
