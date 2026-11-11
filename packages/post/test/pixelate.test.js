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
test('Pixelate falls back to its owned normal capture when the normal provider is deleted mid-run (KB5641a)', async () => {
  const h = harness(),
    supplied = h.gpu.device.createTexture({ size: [4, 4], format: 'rgba16float', usage: 0x4 | 0x10 }),
    effect = Pixelate.attach(h.engine, { normal: () => supplied });
  const before = h.gpu.record(() => h.frame());
  assert.ok(!modules(before).some((s) => s.includes('MargoCapture')), 'a supplied provider needs no owned capture');
  delete effect.options.normal;
  h.frame();
  const after = h.gpu.record(() => h.frame());
  assert.ok(
    modules(after).some((s) => s.includes('normal') && s.includes('MargoCapture')) ||
      [...h.plugins.keys()].some((k) => k.startsWith('scene-targets:')),
    'the owned SceneTargets capture is active once the provider is gone',
  );
  assert.ok([...h.plugins.keys()].some((k) => k.startsWith('scene-targets:')));
  effect.dispose();
  supplied.destroy();
  await null;
  assert.deepEqual(h.live(), []);
});
