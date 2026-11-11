import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { CulledMeshes } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { injectGPUFaults } from '../../../tests/support/gpu-faults.js';
import { wgsl } from '../../core/src/shaders.ts';

// KB6434c: WebGPU reports a failed createBuffer later, to the innermost error scope or else as `uncapturederror`, which
// core treats as a fault of every frame. CulledMeshes makes its buffers inside error scopes, leaves them unused until the
// device confirms them, and on a failure reports once and draws the meshes unculled until the next device restore.
function harness() {
  const h = optionalGPU(),
    gpu = h.engine.gpu,
    geometry = box(),
    core = new Map([[geometry, { size: 96 * 4 }]]),
    errors = [];
  globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 };
  h.context.shader = wgsl;
  h.context.descriptor = {
    multisample: { count: 1 },
    depthStencil: { format: 'depth32float' },
    vertex: { buffers: [] },
    fragment: { targets: [] },
  };
  // Error scopes as a device keeps them: a stack whose pops report nothing unless an error was raised into them.
  const scopes = [];
  gpu.pushErrorScope = (filter) => scopes.push(filter);
  gpu.popErrorScope = async () => {
    if (!scopes.pop()) throw new DOMException('No error scope', 'OperationError');
    return null;
  };
  const uncaptured = [];
  gpu.dispatchEvent = (event) => uncaptured.push(event.error);
  h.engine.canvas = { clientWidth: 64 };
  h.engine.gpu.createBindGroupLayout = (d) => d;
  h.engine.gpu.createPipelineLayout = (d) => d;
  h.engine.geometryBuffers = (g) => ({ instance: core.get(g) });
  h.engine.onError = (error) => errors.push(error);
  const batches = [{ geometry, instances: new Float32Array(96), count: 3 }];
  h.context.batches = batches;
  return {
    ...h,
    batches,
    errors,
    uncaptured,
    run(frames = 1) {
      for (let i = 0; i < frames; i++) h.engine.frameGraph.execute(h.context);
    },
  };
}
// Error scopes resolve after the device checks the calls: a few promise turns and a task here.
const checked = () => new Promise((resolve) => setTimeout(resolve, 0));

for (const [what, size] of [
  ['the frame uniform', 176],
  ['a slot buffer (the drawn instances)', 256 * 96],
]) {
  test(`CulledMeshes: a refused allocation of ${what} is reported once; the meshes draw unculled until a restore (KB6434c)`, async () => {
    const h = harness(),
      plugin = new CulledMeshes({ minRadius: 2, occlusion: false });
    h.engine.use(plugin);
    {
      using faults = injectGPUFaults(h.engine.gpu, {
        createBuffer: 1,
        select: (method, descriptor) => method === 'createBuffer' && descriptor.size === size,
      });
      // The frame buffer is made (and checked) first, the slots on the frame after it is confirmed.
      for (let i = 0; i < 2 && !faults.injected.length; i++) {
        h.run();
        assert.equal(h.batches[0].redirect, undefined, 'nothing unconfirmed is used: core draws the batch');
        await checked();
      }
      assert.equal(faults.injected.length, 1, 'the allocation was made and failed');
    }
    assert.deepEqual(h.uncaptured, [], 'the failure stays in the package: nothing reaches uncapturederror');
    assert.equal(h.errors.length, 1, 'reported once');
    assert.match(h.errors[0].message, /CulledMeshes could not make its GPU buffers.*draw unculled/);
    const buffers = h.counts.buffers,
      groups = h.counts.groups,
      writes = h.bufferWrites.length;
    h.run(5);
    await checked();
    assert.equal(h.errors.length, 1, 'later frames report nothing more');
    assert.equal(h.batches[0].redirect, undefined, 'the batch stays unculled');
    assert.equal(h.counts.buffers, buffers, 'no retry before a restore');
    assert.equal(h.counts.groups, groups, 'no bind group over a failed buffer');
    assert.ok(
      h.bufferWrites.slice(writes).every((w) => !w.buffer.destroyed),
      'no write to a released buffer',
    );
    assert.ok(
      h.resources.filter((r) => r.size === size).every((r) => r.destroyed),
      'the failed set is released',
    );
    // A device restore tries again; once the device confirms the buffers, the batch is culled.
    // The frame buffer is confirmed first, then each slot: two checked frames, then culled.
    plugin.onDeviceRestored(h.engine);
    for (let i = 0; i < 2; i++) {
      h.run();
      assert.equal(h.batches[0].redirect, undefined, 'unconfirmed buffers are not used after the restore either');
      await checked();
    }
    h.run();
    assert.ok(h.batches[0].redirect, 'culled again after the restore');
    assert.equal(h.errors.length, 1);
    plugin.dispose();
    h.cleanup();
  });
}
