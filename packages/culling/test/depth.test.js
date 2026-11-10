import test from 'node:test';
import assert from 'node:assert/strict';
import { DepthPyramid, depthPyramidShader } from '../dist/depth.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { wgsl } from '../../core/src/shaders.ts';

test('public depth pyramid rebuilds for odd view sizes, samples and device restoration', () => {
  const h = optionalGPU(),
    p = new DepthPyramid();
  h.context.shader = wgsl;
  h.context.descriptor.multisample = { count: 1 };
  h.context.width = 17;
  h.context.height = 9;
  p.encode(h.context, h.engine);
  const old = p.buffer;
  const u = new Uint32Array(p.uniform.data);
  assert.deepEqual([...u.slice(40, 43)], [17, 9, 6]);
  assert.deepEqual([...u.slice(48, 51)], [0, 17, 9]);
  h.context.width = 7;
  p.encode(h.context, h.engine);
  assert.ok(old.destroyed);
  const view = p.buffer;
  h.context.descriptor.multisample = { count: 4 };
  p.encode(h.context, h.engine);
  assert.ok(view.destroyed);
  assert.ok(depthPyramidShader.includes('fn unoccluded'));
  p.release();
  p.encode(h.context, h.engine);
  p.dispose();
  p.dispose();
  assert.throws(() => p.encode(h.context, h.engine), /disposed/);
  assert.ok(h.resources.every((r) => r.destroyed));
});
