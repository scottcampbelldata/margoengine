import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshBVH } from '@margoengine/bvh';
import { EFFECT_BINDING, effectEntries, moveEffects, shadowSampling } from '../src/shader.ts';
import { canTraceShadows, rayTracedFilter } from '../dist/rt.js';

globalThis.GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8, STORAGE: 128, COPY_SRC: 4 };
const bvh = MeshBVH.build({ positions: new Float32Array([-1, 0, -1, 1, 0, -1, 0, 0, 1]), indices: [0, 1, 2] });
const device = (limits = {}) => {
  const made = [];
  return {
    made,
    limits: { maxStorageBuffersPerShaderStage: 8, maxStorageBufferBindingSize: 1 << 27, maxBufferSize: 1 << 28, ...limits },
    createBuffer(d) {
      const b = { ...d, destroyed: false, destroy() { this.destroyed = true; } };
      made.push(b);
      return b;
    },
    queue: { writeBuffer() {} },
  };
};
const filter = (options) => rayTracedFilter({ gpu: device() }, bvh, options);

test('without fragment storage buffers the answer is a map filter', () => {
  assert.equal(canTraceShadows({ gpu: null }), false);
  assert.equal(canTraceShadows({ gpu: device({ maxStorageBuffersInFragmentStage: 0 }) }), false);
  assert.equal(canTraceShadows({ gpu: device() }), true);
  const compat = { gpu: device({ maxStorageBuffersInFragmentStage: 0 }) };
  assert.equal(rayTracedFilter(compat, bvh), 'soft');
  assert.equal(rayTracedFilter(compat, bvh, { fallback: 'pcf' }), 'pcf');
});
test('the tree and settings sit in the effect bindings, under names moveEffects finds', () => {
  const f = filter(),
    code = shadowSampling(1, f, false, false, false, [f]);
  assert.ok(code.includes('return f32(seen)/f32(count);'));
  assert.ok(!/\bbvh[A-Z]/.test(code), 'an unprefixed tree name would not move with a section plugin');
  for (let k = 0; k < 6; k++) assert.ok(code.includes(`@binding(${EFFECT_BINDING + k})`));
  const moved = moveEffects(code, (binding) => binding + 100);
  for (let k = 0; k < 6; k++) assert.ok(moved.includes(`@binding(${EFFECT_BINDING + 100 + k})`), `binding ${k} stayed`);
});
test('setup after a device loss builds on the new device and frees the old', () => {
  const f = filter(),
    first = device(),
    second = device();
  f.setup(first);
  assert.equal(effectEntries([f]).length, 6);
  f.setup(second);
  assert.ok(first.made.every((b) => b.destroyed), 'the old device keeps a buffer');
  assert.equal(second.made.length, 6);
  f.dispose();
  assert.ok(second.made.every((b) => b.destroyed));
});
test('ray settings out of range throw at the frame that reads them', () => {
  for (const bad of [{ rays: 0 }, { rays: 257 }, { rays: 1.5 }, { lightSize: -1 }, { bias: 0 }, { far: 0 }]) {
    const f = filter(bad),
      gpu = device();
    f.setup(gpu);
    assert.throws(() => f.update({ light: [0, 1, 0], context: { device: gpu } }), RangeError, JSON.stringify(bad));
    f.dispose();
  }
});
