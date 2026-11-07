import test from 'node:test';
import assert from 'node:assert/strict';
import { Splats } from '../dist/index.js';
import { SplatDepth } from '../dist/depth.js';

const cloud = () =>
  new Splats({
    positions: new Float32Array([0, 0, 0]),
    covariances: new Float32Array([0.1, 0, 0, 0.1, 0, 0.1]),
    colors: new Float32Array([1, 0, 0, 1]),
  });

test('SplatDepth checks its cloud, threshold and order', () => {
  assert.throws(() => new SplatDepth({}), TypeError);
  assert.throws(() => new SplatDepth(undefined), TypeError);
  for (const threshold of [-0.01, 1.01, Number.NaN, '0.5'])
    assert.throws(() => new SplatDepth(cloud(), { threshold }), RangeError, String(threshold));
  assert.throws(() => new SplatDepth(cloud(), { order: Number.POSITIVE_INFINITY }), RangeError);
  const depth = new SplatDepth(cloud());
  assert.equal(depth.threshold, 0.5);
  assert.equal(depth.order, 3.5);
  depth.threshold = 0;
  assert.equal(depth.threshold, 0);
  assert.throws(() => (depth.threshold = 2), RangeError);
  assert.equal(depth.threshold, 0, 'a rejected threshold keeps the old one');
});

test('SplatDepth needs WebGPU, and writes nothing for a cloud that is not attached', () => {
  const depth = new SplatDepth(cloud());
  assert.throws(() => depth.setup({ stats: { drawCalls: 0 } }), { code: 'unsupported' });
  const passes = [];
  depth.registerPasses({ add: (p) => passes.push(p) });
  assert.equal(passes.length, 1);
  assert.equal(passes[0].order, 3.5);
  // A frame with an unattached cloud must not touch the device or the encoder.
  passes[0].execute({ backend: 'webgpu', get device() { throw new Error('touched the device'); } });
  assert.equal(cloud().attached, false);
  depth.dispose();
  assert.throws(() => depth.setup({ gpu: {}, stats: { drawCalls: 0 } }), { code: 'disposed' });
});
