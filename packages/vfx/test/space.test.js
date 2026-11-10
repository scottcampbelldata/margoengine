import test from 'node:test';
import assert from 'node:assert/strict';
import { VFX } from '../dist/base.js';
import { space } from '../dist/space.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

test('space validates rigid frames and requires its optional feature', () => {
  assert.throws(() => new VFX({ space: { mode: 'local' } }), /space/);
  for (const value of [
    { mode: 'bad' },
    { inheritVelocity: 2 },
    { ratePerDistance: -1 },
    { transform: [] },
    { transform: [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
  ]) {
    assert.throws(() => new VFX({ space: value }, { space }), /space/);
  }
});

test('distance budget carries fractional travel and resets without phantom velocity or births', () => {
  const h = optionalGPU();
  h.engine.stats = { drawCalls: 0 };
  const effect = new VFX(
    { capacity: 32, rate: 0, position: [0, 0, 0], space: { mode: 'local', ratePerDistance: 2, inheritVelocity: 0.5 } },
    { space },
  );
  h.engine.use(effect);
  const budget = () => new Uint32Array(h.resources.find((r) => r.size === 224).data)[53];
  h.frame();
  assert.equal(budget(), 0);
  effect.options.position = [0.2, 0, 0];
  h.frame();
  assert.equal(budget(), 0);
  effect.options.position = [1.2, 0, 0];
  h.frame();
  assert.equal(budget(), 2);
  const uniform = new Float32Array(h.resources.find((r) => r.size === 160).data);
  assert.equal(uniform[32], 1);
  assert.ok(Math.abs(uniform[37] - 0.3) < 1e-6);
  effect.reset();
  h.frame();
  assert.equal(budget(), 0);
  assert.equal(new Float32Array(h.resources.find((r) => r.size === 160).data)[32], 0);
  effect.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
  h.cleanup();
});
