// scripts/browser.js delayPipelines, the slow-compiler stand-in of the `slow-compile` GPU suites: async pipeline
// creation resolves later with the real pipeline, sync creation holds the thread, errors pass through.
import test from 'node:test';
import assert from 'node:assert/strict';
import { delayPipelines } from '../scripts/browser.js';

test('delayPipelines makes pipeline creation slower and changes nothing else', async () => {
  const pipeline = { label: 'real' };
  class FakeDevice {
    createRenderPipelineAsync() {
      return Promise.resolve(pipeline);
    }
    createComputePipelineAsync() {
      return Promise.reject(new Error('bad shader'));
    }
    createRenderPipeline() {
      return pipeline;
    }
    createComputePipeline() {
      return pipeline;
    }
  }
  globalThis.GPUDevice = FakeDevice;
  try {
    delayPipelines(60);
    const device = new FakeDevice();
    let start = performance.now();
    assert.equal(await device.createRenderPipelineAsync({}), pipeline);
    assert.ok(performance.now() - start >= 55, 'async creation resolves after the delay');
    await assert.rejects(device.createComputePipelineAsync({}), /bad shader/);
    start = performance.now();
    assert.equal(device.createRenderPipeline({}), pipeline);
    assert.equal(device.createComputePipeline({}), pipeline);
    assert.ok(performance.now() - start >= 115, 'each sync creation holds the thread for the delay');
  } finally {
    delete globalThis.GPUDevice;
  }
});

test('delayPipelines is a no-op without WebGPU', () => {
  assert.equal(typeof globalThis.GPUDevice, 'undefined');
  assert.doesNotThrow(() => delayPipelines(10));
});
