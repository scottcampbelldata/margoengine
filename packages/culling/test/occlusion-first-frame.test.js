import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { CulledMeshes } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { wgsl } from '../../core/src/shaders.ts';

// AMD GPU hunt R7 row 35: since KB6434c (6c8a6339f) a slot's buffers wait for the device's confirmation, and its occluder
// lists waited for a confirmation of their own, which held every batch's occlusion off for the frame a new geometry was
// first culled; the new geometry, with no last frame, then listed no occluders either. A wall that appeared hid nothing
// for two more frames (culling test:gpu:bounds, meshes: 25 drawn behind the wall where 1 was before). The lists are now
// made inside the slot's own check, and a new slot's instances all start as occluder candidates.
function harness() {
  const h = optionalGPU(),
    gpu = h.engine.gpu,
    wall = box(4),
    rods = box(0.1),
    core = new Map([
      [wall, { instance: { size: 96 * 4 }, vertex: {}, index: {} }],
      [rods, { instance: { size: 96 * 4 }, vertex: {}, index: {} }],
    ]);
  globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 };
  h.context.shader = wgsl;
  h.context.descriptor = { multisample: { count: 4 }, depthStencil: { format: 'depth32float' } };
  h.context.camera.matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -0.001, -1, 0, 0, 1, 0]);
  // Error scopes as a device keeps them: pops resolve later, with no error.
  const scopes = [];
  gpu.pushErrorScope = (filter) => scopes.push(filter);
  gpu.popErrorScope = async () => {
    if (!scopes.pop()) throw new DOMException('No error scope', 'OperationError');
    return null;
  };
  h.engine.canvas = { clientWidth: 64 };
  gpu.createBindGroupLayout = (d) => d;
  gpu.createPipelineLayout = (d) => d;
  h.engine.geometryBuffers = (g) => core.get(g);
  const batches = [{ geometry: rods, instances: new Float32Array(96), count: 3 }];
  h.context.batches = batches;
  let draws = 0,
    depth = false;
  const begin = h.context.encoder.beginRenderPass;
  h.context.encoder.beginRenderPass = (descriptor) => {
    depth = true;
    const pass = begin(descriptor);
    pass.drawIndexedIndirect = () => draws++;
    return pass;
  };
  return {
    ...h,
    batches,
    wall,
    // One frame: whether it drew the occluder pass, and how many occluder draws.
    run() {
      draws = 0;
      depth = false;
      h.engine.frameGraph.execute(h.context);
      return { depth, draws };
    },
  };
}
const checked = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a geometry that appears occludes from the first frame it is culled, and keeps the others occluding (R7 row 35)', async () => {
  const h = harness(),
    plugin = CulledMeshes.attach(h.engine, { occlusion: true });
  // The frame uniform, then the rods' slot, then the occlusion set are confirmed: occlusion within a few frames.
  let frame;
  for (let i = 0; i < 6 && !(frame = h.run()).depth; i++) await checked();
  assert.deepEqual(frame, { depth: true, draws: 1 }, 'the rods occlude once their buffers are confirmed');
  await checked();
  // The wall appears. Its slot is unconfirmed this frame: core draws it, the rods still occlude.
  h.batches.push({ geometry: h.wall, instances: new Float32Array(96), count: 1 });
  const writes = h.bufferWrites.length;
  assert.deepEqual(h.run(), { depth: true, draws: 1 }, 'an unconfirmed slot leaves the others occluding');
  assert.equal(h.batches[1].redirect, undefined, 'the unconfirmed wall is drawn by core');
  const seed = h.bufferWrites
    .slice(writes)
    .find((w) => w.bytes === 256 * 4 && new Uint32Array(w.buffer.data).every((v) => v === 1));
  assert.ok(seed, "the wall's instances all start as occluder candidates");
  await checked();
  // Its first culled frame: the wall is an occluder already, beside the rods.
  assert.deepEqual(h.run(), { depth: true, draws: 2 }, 'the new slot occludes in its first culled frame');
  assert.ok(h.batches[1].redirect, 'the wall is culled');
  plugin.dispose();
  h.cleanup();
});
