import test from 'node:test';
import assert from 'node:assert/strict';
import { box, PbrMaterial } from '../packages/core/dist/index.js';
import { Scatter, ScatterInstances } from '../packages/scatter/dist/index.js';
import { wgsl } from '../packages/core/src/shaders.ts';
import { optionalGPU } from './support/optional-gpu.js';

for (const fixed of [false, true])
  test(`${fixed ? 'Fixed' : 'GPU LOD'} Scatter observes mutable lighting bindings and retries failed groups`, () => {
    const h = optionalGPU(),
      d = h.engine.gpu;
    h.engine.lighting = { direction: new Float32Array([0, 1, 0, 1]), radiance: new Float32Array([1, 1, 1, 0.1]) };
    h.context.shader = wgsl;
    const first = d.createBuffer({ size: 512, usage: GPUBufferUsage.UNIFORM }),
      second = d.createBuffer({ size: 512, usage: GPUBufferUsage.UNIFORM }),
      resource = { buffer: first, offset: 0, size: 64 },
      entry = { binding: 1, resource };
    h.context.bindings = [entry];
    const vertices = new Float32Array(60),
      indices = new Uint32Array([0, 1, 2]),
      transforms = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const effect = fixed
      ? new ScatterInstances(() => [{ name: 'test', vertices, indices, transforms, material: new PbrMaterial() }])
      : new Scatter(box(), { count: 1, material: new PbrMaterial() });
    h.engine.use(effect);
    const frame = () => h.engine.frameGraph.execute(h.context);
    try {
      frame();
      const initial = h.counts.groups,
        pipelines = h.pipelines.length;
      for (let i = 0; i < 120; i++) frame();
      assert.equal(h.counts.groups, initial);
      resource.offset = 256;
      frame();
      assert.equal(h.counts.groups, initial + 1);
      resource.size = 16;
      frame();
      assert.equal(h.counts.groups, initial + 2);
      resource.buffer = second;
      frame();
      assert.equal(h.counts.groups, initial + 3);
      entry.binding = 2;
      frame();
      assert.equal(h.counts.groups, initial + 4);
      assert.equal(h.pipelines.length, pipelines);
      const create = d.createBindGroup,
        failure = new Error('Lighting group failed');
      resource.offset = 0;
      d.createBindGroup = () => {
        throw failure;
      };
      assert.throws(frame, (error) => error === failure);
      d.createBindGroup = create;
      frame();
      assert.equal(h.counts.groups, initial + 5);
      for (let i = 0; i < 120; i++) frame();
      assert.equal(h.counts.groups, initial + 5);
      const latest = h.groups.at(-1).entries.at(-1);
      assert.equal(latest.binding, 2);
      assert.equal(latest.resource.buffer, second);
      assert.equal(latest.resource.offset, 0);
      effect.onDeviceRestored(h.engine);
      frame();
      assert.equal(h.groups.at(-1).entries.at(-1).resource.buffer, second);
    } finally {
      effect.dispose();
      first.destroy();
      second.destroy();
      assert.ok(h.resources.every((r) => r.destroyed));
    }
  });
