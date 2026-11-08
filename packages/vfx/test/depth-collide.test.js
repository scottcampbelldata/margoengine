import test from 'node:test';
import assert from 'node:assert/strict';
import { VFX } from '../dist/index.js';
import { VFX as Base } from '../dist/base.js';
import { depthCollide } from '../dist/depth-collide.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const attach = (options, features) => {
  const h = optionalGPU();
  h.engine.stats = { drawCalls: 0 };
  const effect = features ? new Base(options, features) : new VFX(options);
  h.engine.use(effect);
  return { h, effect };
};
const depthTexture = (more = {}) => ({
  format: 'depth32float',
  dimension: '2d',
  sampleCount: 1,
  usage: 4 | 16,
  width: 64,
  height: 64,
  createView: () => ({}),
  ...more,
});
const collisions = (h) => h.pipelines.filter((p) => p.compute?.entryPoint === 'collideDepth');

test('depth collision runs from the second frame, against last frame camera, and only while depth exists', () => {
  let depth;
  const { h, effect } = attach(
    { capacity: 300, initialCount: 300, depth: () => depth, depthCollide: { thickness: 2 } },
    { depthCollide },
  );
  const passes = () => h.counts.compute;
  h.frame();
  const one = passes();
  assert.equal(collisions(h).length, 0, 'the first frame has no last frame to collide with');
  depth = depthTexture();
  const camera = [...h.context.camera.matrix];
  h.frame();
  assert.equal(passes(), 2 * one + 1, 'one more compute pass: the collision');
  const [pipeline] = collisions(h);
  assert.ok(pipeline.compute.module.code.includes('texture_depth_2d;'), 'one sample');
  const uniform = h.resources.find((r) => r.size === 176);
  const values = new Float32Array(uniform.data);
  assert.deepEqual([...values.subarray(0, 16)], camera, "the projection is last frame's camera");
  assert.deepEqual([values[40], +values[41].toFixed(6)], [2, 0.3], 'thickness, and the effect bounce');
  const groups = h.counts.groups;
  h.frame();
  assert.equal(h.counts.groups, groups, 'the same depth keeps its bind group');
  depth = depthTexture({ sampleCount: 4 });
  h.frame();
  assert.ok(collisions(h).some((p) => p.compute.module.code.includes('texture_depth_multisampled_2d')));
  depth = undefined;
  const before = passes();
  h.frame();
  assert.equal(passes(), before + one, 'no depth this frame: no collision pass');
  depth = depthTexture({ format: 'rgba8unorm' });
  assert.throws(() => h.frame(), /sampleable depth texture/);
  effect.dispose();
});

test('depth collision is validated and needs its feature and the depth option', () => {
  assert.throws(() => new Base({ depth: () => undefined, depthCollide: {} }, {}), /@margoengine\/vfx\/depth-collide/);
  assert.throws(() => new VFX({ depthCollide: {} }), /needs scene depth/);
  assert.throws(() => new VFX({ depth: () => undefined, depthCollide: { thickness: 0 } }), RangeError);
  assert.throws(() => new VFX({ depth: () => undefined, depthCollide: null }), TypeError);
  const { h, effect } = attach({ capacity: 8, depth: () => depthTexture(), depthCollide: {} });
  h.frame();
  effect.options.depthCollide = {};
  assert.throws(() => h.frame(), /fixed at attach/);
  const plain = attach({ capacity: 8, depth: () => depthTexture() });
  plain.h.frame();
  plain.h.frame();
  assert.equal(collisions(plain.h).length, 0, 'effects without it compile no collision kernel');
  effect.dispose();
});
