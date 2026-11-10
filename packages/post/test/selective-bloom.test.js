import test from 'node:test';
import assert from 'node:assert/strict';
import { SelectiveBloom } from '@margoengine/post/selective-bloom';
import { harness, modules, written } from './support.js';

test('SelectiveBloom extracts coverage before the bloom chain and composites only the added light', async () => {
  const h = harness(),
    mask = h.gpu.device.createTexture({ size: [16, 16], format: 'rgba8unorm', usage: 4 });
  const effect = SelectiveBloom.attach(h.engine, { mask: () => mask, inverted: true, strength: 2 });
  const log = h.gpu.record(() => h.frame());
  const shaders = modules(log);
  assert.ok(shaders.some((s) => s.includes('s.rgb*w*u.z')));
  assert.ok(shaders.some((s) => s.includes('textureLoad(bloomed,q,0).rgb-textureLoad(selected,q,0).rgb')));
  assert.deepEqual([...written(log, 16)], [1, 1, 1, 0]);
  effect.options.mask = () => undefined;
  const empty = h.gpu.record(() => h.frame());
  assert.equal(written(empty, 16)[2], 0, 'missing selection never lights the scene, even inverted');
  effect.options.strength = -1;
  assert.throws(() => h.frame(), RangeError);
  effect.options.strength = 1;
  h.engine.restore();
  h.frame();
  effect.dispose();
  await null;
  assert.deepEqual(
    h.live().filter((r) => r !== mask),
    [],
  );
  mask.destroy();
});

test('SelectiveBloom validates mask, booleans and bloom ranges', () => {
  assert.throws(() => new SelectiveBloom({ mask: 1 }), TypeError);
  assert.throws(() => new SelectiveBloom({ mask: () => undefined, inverted: 1 }), TypeError);
  assert.throws(() => new SelectiveBloom({ mask: () => undefined, radius: 2 }), RangeError);
  assert.throws(() => new SelectiveBloom({ mask: () => undefined, exposure: Infinity }), RangeError);
});
