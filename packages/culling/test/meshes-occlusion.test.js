import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { CulledMeshes } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { wgsl } from '../../core/src/shaders.ts';

function harness() {
  const h = optionalGPU();
  globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 };
  const geometry = box(),
    other = box(0.5),
    core = new Map([
      [geometry, { instance: { size: 96 * 4 }, vertex: {}, index: {} }],
      [other, { instance: { size: 96 * 2 }, vertex: {}, index: {} }],
    ]);
  h.context.shader = wgsl;
  h.context.descriptor = { multisample: { count: 4 }, depthStencil: { format: 'depth32float' } };
  h.context.camera.matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -0.001, -1, 0, 0, 1, 0]);
  h.engine.canvas = { clientWidth: 64 };
  h.engine.gpu.createBindGroupLayout = (d) => d;
  h.engine.gpu.createPipelineLayout = (d) => d;
  h.engine.geometryBuffers = (g) => core.get(g);
  const batches = [
    { geometry, instances: new Float32Array(96), count: 3 },
    { geometry: other, instances: new Float32Array(48), count: 2 },
  ];
  h.context.batches = batches;
  const order = [],
    begin = h.context.encoder.beginRenderPass,
    compute = h.context.encoder.beginComputePass;
  const draws = [];
  h.context.encoder.beginRenderPass = (descriptor) => {
    order.push('depth');
    const pass = begin(descriptor);
    pass.drawIndexedIndirect = (buffer) => draws.push(buffer);
    return pass;
  };
  h.context.encoder.beginComputePass = () => {
    order.push('compute');
    return compute();
  };
  return { ...h, batches, core, order, draws, run: () => h.engine.frameGraph.execute(h.context) };
}
const entries = (h) => h.pipelines.filter((p) => p.compute).map((p) => p.compute.entryPoint);

test('occlusion draws an occluder pass and a pyramid before culling, and every batch still redirects', () => {
  const h = harness(),
    plugin = CulledMeshes.attach(h.engine, { occlusion: true });
  h.run();
  assert.deepEqual(h.order, ['compute', 'depth', 'compute', 'compute']);
  assert.equal(h.draws.length, 2, 'one occluder draw per batch');
  for (const name of ['early', 'depth0', 'reduce']) assert.ok(entries(h).includes(name), name);
  assert.ok(h.batches[0].redirect && h.batches[1].redirect);
  const created = { ...h.counts };
  for (let i = 0; i < 20; i++) h.run();
  assert.equal(h.counts.buffers, created.buffers, 'no per-frame buffers');
  assert.equal(h.counts.groups, created.groups);
  plugin.dispose();
  assert.ok(h.resources.every((r) => r.destroyed), 'occlusion storage released');
});

test('off by default: no prepass, no occlusion pipelines', () => {
  const h = harness();
  CulledMeshes.attach(h.engine);
  h.run();
  assert.deepEqual(h.order, ['compute']);
  assert.deepEqual(entries(h), ['cull', 'scan', 'scatter']);
});

test('a shader that changes surfaces falls back to frustum culling for that frame', () => {
  const h = harness(),
    plugin = CulledMeshes.attach(h.engine, { occlusion: true });
  h.context.shader = wgsl.replace('let facing=', 'if(i.position.x>0.0){discard;}let facing=');
  h.run();
  assert.deepEqual(h.order, ['compute']);
  h.context.shader = wgsl;
  h.run();
  assert.ok(h.order.includes('depth'));
  plugin.occlusion = false;
  h.order.length = 0;
  h.run();
  assert.deepEqual(h.order, ['compute'], 'occlusion switches off at any time');
});

test('a claimed batch does not occlude', () => {
  const h = harness();
  h.batches[1].claimed = true;
  CulledMeshes.attach(h.engine, { occlusion: true });
  h.run();
  assert.equal(h.draws.length, 1);
});

test('occluder bindings follow a new core instance buffer and a resize, and a grown slot gets a longer list', () => {
  const h = harness();
  CulledMeshes.attach(h.engine, { occlusion: true });
  h.run();
  const groups = h.counts.groups;
  h.core.get(h.batches[0].geometry).instance = { size: 96 * 8 };
  h.run();
  assert.ok(h.counts.groups > groups, 'rebinds for core instance buffer');
  const resized = h.counts.groups;
  h.context.width += 1;
  h.run();
  assert.ok(h.counts.groups > resized, 'rebinds for the new pyramid');
  h.batches[0].count = 300;
  h.run();
  assert.ok(h.resources.some((r) => r.size === 512 * 4 && !r.destroyed && r.usage & 32), 'occluder list regrown');
});

test('occlusion options are checked', () => {
  assert.throws(() => new CulledMeshes({ occlusion: 'yes' }), /true or false/);
  assert.throws(() => new CulledMeshes({ occluderSize: -1 }), /occluderSize/);
  const plugin = new CulledMeshes({ occlusion: true });
  assert.equal(plugin.occluderSize, 8);
});
