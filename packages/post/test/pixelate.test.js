import test from 'node:test';
import assert from 'node:assert/strict';
import { Pixelate } from '@margoengine/post/pixelate';
import { harness, modules, written } from './support.js';
test('Pixelate captures normals, samples cell centres and restores/releases both owners', async () => {
  const h = harness(),
    effect = Pixelate.attach(h.engine, { pixelSize: 8 });
  const log = h.gpu.record(() => h.frame());
  assert.deepEqual([...written(log, 48).slice(0, 3)], [8, Math.fround(0.4), Math.fround(0.3)]);
  assert.ok(modules(log).some((s) => s.includes('normal') && s.includes('MargoCapture')));
  assert.ok(modules(log).some((s) => s.includes('let q=min((vec2i(p.xy)/cell)*cell')));
  effect.options.enabled = false;
  const off = h.gpu.record(() => h.frame());
  assert.deepEqual([...written(off, 48).slice(0, 3)], [1, 0, 0]);
  h.engine.restore();
  h.frame();
  effect.dispose();
  await null;
  assert.deepEqual(h.live(), []);
});
test('Pixelate validates mutable pixel and edge settings', () => {
  for (const o of [
    { pixelSize: 0 },
    { pixelSize: 1.5 },
    { normalEdgeStrength: 2 },
    { depthEdgeStrength: NaN },
    { depthThreshold: 0 },
    { normalThreshold: Infinity },
  ])
    assert.throws(() => new Pixelate(o), RangeError);
  assert.throws(() => new Pixelate({ normal: 1 }), TypeError);
  const h = harness(),
    effect = Pixelate.attach(h.engine);
  effect.options.pixelSize = 129;
  assert.throws(() => h.frame(), RangeError);
  effect.dispose();
});
