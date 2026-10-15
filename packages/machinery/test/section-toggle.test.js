// SectionPlanes.enabled (HANDOFF 1d''): switching is a uniform change, and the cap pipelines compile in the background while off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, passes, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { wgsl } from '../../core/src/shaders.ts';
import { SectionPlanes } from '../dist/index.js';

function rig(options) {
  const gpu = mockGPU(),
    pending = [];
  gpu.device.features = new Set(['depth32float-stencil8']);
  gpu.device.createRenderPipelineAsync = (descriptor) =>
    new Promise((resolve) => pending.push(() => resolve(gpu.device.createRenderPipeline(descriptor))));
  const section = new SectionPlanes({
      planes: [
        [1, 0, 0, 0],
        [0, 1, 0, 0.5],
      ],
    }),
    run = passes(section),
    view = context(gpu, { shader: wgsl, depthFormat: 'depth32float-stencil8' });
  Object.assign(section, options);
  section.setup({ gpu: gpu.device });
  const frame = (i) => {
    const log = gpu.record(() => {
        view.begin(i);
        run(view.c);
      }),
      write = log.find((entry) => entry[0] === 'writeBuffer');
    return {
      log,
      shader: view.c.shader,
      planes: Buffer.from(write[3], 'hex').readFloatLE(96),
      caps: log.filter((entry) => entry[0] === 'beginRenderPass').length,
      created: log.filter((entry) => entry[0] === 'renderPipeline').length,
    };
  };
  return { section, frame, pending, gpu };
}

test('SectionPlanes: off keeps the clip shader and reads 0 planes; caps compile in the background and switching on waits for them', async () => {
  const on = rig().frame(0);
  assert.equal(on.planes, 2);
  assert.equal(on.caps, 6, 'reference, mask and cap passes per plane');
  assert.equal(on.created, 5, 'cap pipelines compiled on the frame');
  const { section, frame, pending } = rig({ enabled: false }),
    off = frame(0);
  assert.equal(off.shader, on.shader, 'the same patched shader, so no core pipeline change');
  assert.equal(off.planes, 0);
  assert.equal(off.caps, 0);
  assert.equal(off.created, 0);
  assert.equal(pending.length, 5, 'cap pipelines compile asynchronously');
  assert.equal(frame(1).created, 0, 'started once');
  section.enabled = true;
  const waiting = frame(2);
  assert.equal(waiting.planes, 0, 'stays off until the background compile finishes');
  assert.equal(waiting.caps, 0);
  for (const resolve of pending.splice(0)) resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  frame(3);
  const ready = frame(4);
  assert.equal(ready.planes, 2);
  assert.equal(ready.caps, 6);
  assert.equal(ready.created, 0, 'no synchronous compile when switched on');
  section.enabled = false;
  const again = frame(5);
  assert.equal(again.planes, 0);
  assert.equal(again.caps, 0);
  assert.equal(again.shader, on.shader);
  section.dispose();
});
