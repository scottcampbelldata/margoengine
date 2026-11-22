// scripts/support/gpu-ready.js waitForPipelines: the time limit bounds the wait for pipelines, not the frames.
// KB-GPUREADY-CALM: on the WebGL2 layer under load a page's first frame drew for 25 to 29 s with no pipeline started
// or compiling, and the wait threw "not ready ... 0 pipelines compiling" without drawing its confirming frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import { trackPipelines, waitForPipelines } from '../scripts/support/gpu-ready.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeGPU(t) {
  class FakeDevice {
    createRenderPipelineAsync(descriptor) {
      return descriptor.never ? new Promise(() => {}) : Promise.resolve(descriptor);
    }
    createComputePipelineAsync(descriptor) {
      return Promise.resolve(descriptor);
    }
  }
  globalThis.GPUDevice = FakeDevice;
  t.after(() => {
    delete globalThis.GPUDevice;
    delete globalThis.__margoPipelines;
  });
  trackPipelines();
  return new FakeDevice();
}

test('a frame longer than the time limit that leaves nothing pending is ready after its confirming frame', async (t) => {
  fakeGPU(t);
  let frames = 0;
  // The stand-in of the slow first frame: all its work is synchronous, no pipeline starts or stays compiling.
  const ms = await waitForPipelines(
    async () => {
      if (frames++ === 0) await sleep(80);
    },
    { timeoutMs: 30 },
  );
  assert.equal(frames, 2, 'the slow calm frame and one confirming frame');
  assert.ok(ms >= 80);
});

test('a pipeline that never compiles still fails, with its label', async (t) => {
  const device = fakeGPU(t);
  let frames = 0;
  await assert.rejects(
    waitForPipelines(
      () => {
        if (frames++ === 0) void device.createRenderPipelineAsync({ label: 'water surface', never: true });
        return sleep(5);
      },
      { timeoutMs: 30 },
    ),
    /not ready after \d+ ms and \d+ frames: 1 pipelines compiling \(water surface\)/,
  );
});

test('a page that starts a pipeline every frame, or whose ready() stays false, fails after the time limit', async (t) => {
  const device = fakeGPU(t);
  await assert.rejects(
    waitForPipelines(
      async () => {
        await device.createComputePipelineAsync({ label: 'churn' });
        await sleep(5);
      },
      { timeoutMs: 30 },
    ),
    /0 pipelines compiling, 1 started in the last frame/,
  );
  await assert.rejects(
    waitForPipelines(() => sleep(5), { timeoutMs: 30, ready: () => false, describe: () => 'tiles 3/4' }),
    /0 pipelines compiling, 0 started in the last frame, ready\(\) false tiles 3\/4/,
  );
});

test('settled pipelines leave the compiling list', async (t) => {
  const device = fakeGPU(t);
  await device.createRenderPipelineAsync({ label: 'a' });
  await device.createComputePipelineAsync({});
  assert.deepEqual(globalThis.__margoPipelines, { pending: 0, created: 2, names: [] });
});
