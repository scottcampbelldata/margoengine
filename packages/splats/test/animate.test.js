// @margoengine/splats/animate without a GPU: option checks, the sequence clock (loop and hold), skin weights, and the
// shader conventions the GPU check (test/gpu/check.mjs) proves on a real device.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SplatSequence, SplatSkin, sequenceShader, skinShader } from '../dist/animate.js';
import { Splats } from '../dist/index.js';

const frame = (n, dx = 0) => ({
  positions: Float32Array.from({ length: n * 3 }, (_, i) => (i % 3 === 0 ? i + dx : 0)),
  covariances: Float32Array.from({ length: n * 6 }, (_, i) => ([0, 3, 5].includes(i % 6) ? 0.01 : 0)),
  colors: new Float32Array(n * 4).fill(0.5),
});

test('SplatSequence checks its cloud, frames and rate', () => {
  const cloud = Splats.reserve(2);
  assert.throws(() => new SplatSequence({}, [frame(2)]), TypeError);
  assert.throws(() => new SplatSequence(cloud, []), RangeError, 'one frame or more');
  assert.throws(() => new SplatSequence(cloud, [frame(3)]), RangeError, 'frames of the cloud size');
  assert.throws(() => new SplatSequence(cloud, [frame(2)], { fps: 0 }), RangeError);
  assert.throws(() => new SplatSequence(cloud, [{ ...frame(2), colors: new Float32Array(8).fill(2) }]), RangeError, 'a valid frame');
  assert.throws(() => new SplatSequence(cloud, [frame(2)]).setup({}), { code: 'unsupported' });
});

test('SplatSequence samples the two frames around the time, looped or held', () => {
  const s = new SplatSequence(Splats.reserve(2), [frame(2), frame(2, 1), frame(2, 2), frame(2, 3)], { fps: 2 });
  assert.equal(s.length, 4);
  assert.equal(s.duration, 2);
  assert.deepEqual(s.sample(0), { from: 0, to: 1, mix: 0 });
  assert.deepEqual(s.sample(0.75), { from: 1, to: 2, mix: 0.5 });
  assert.deepEqual(s.sample(1.75), { from: 3, to: 0, mix: 0.5 }, 'the last frame blends into the first');
  assert.deepEqual(s.sample(2.25), { from: 0, to: 1, mix: 0.5 }, 'loops');
  assert.deepEqual(s.sample(-0.25), { from: 3, to: 0, mix: 0.5 }, 'backwards too');
  s.loop = false;
  assert.deepEqual(s.sample(5), { from: 3, to: 3, mix: 0 }, 'holds the last frame');
  assert.deepEqual(s.sample(-1), { from: 0, to: 1, mix: 0 }, 'holds the first');
  s.dispose();
  assert.ok(s.disposed);
  assert.throws(() => s.setup({ gpu: {} }), { code: 'disposed' });
});

test('SplatSkin checks joints, indices and weights', () => {
  const cloud = Splats.reserve(2),
    ok = { joints: 2, indices: [0, 1, 0, 0, 1, 0, 0, 0], weights: [1, 1, 0, 0, 0, 0, 0, 0] };
  assert.throws(() => new SplatSkin({}, ok), TypeError);
  assert.throws(() => new SplatSkin(cloud, { ...ok, joints: 0 }), RangeError);
  assert.throws(() => new SplatSkin(cloud, { ...ok, indices: [0, 0, 0, 0] }), RangeError, '4 per splat');
  assert.throws(() => new SplatSkin(cloud, { ...ok, indices: [0, 2, 0, 0, 0, 0, 0, 0] }), RangeError, 'an index past the joints');
  assert.throws(() => new SplatSkin(cloud, { ...ok, weights: [1, -1, 0, 0, 0, 0, 0, 0] }), RangeError);
  const skin = new SplatSkin(cloud, ok);
  assert.deepEqual([...skin.matrices.subarray(16, 32)], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 'identity joints');
  assert.equal(skin.rebind(), skin);
  assert.throws(() => skin.setup({}), { code: 'unsupported' });
});

test('the animation shaders mix all four inputs and skin covariances as A S A^T', () => {
  assert.match(sequenceShader, /positions\[i\]=mix\(a\[i\*4\],b\[i\*4\],t\)/);
  assert.match(sequenceShader, /colors\[i\]=mix\(a\[i\*4\+3\],b\[i\*4\+3\],t\)/);
  assert.match(skinShader, /let c=l\*s\*transpose\(l\)/);
  assert.match(skinShader, /positions\[i\]=vec4f\(\(m\*vec4f\(p\.xyz,1\)\)\.xyz,positions\[i\]\.w\)/, 'opacity kept');
});
