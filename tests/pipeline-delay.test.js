// scripts/browser.js delayPipelines, the slow-compiler stand-in of the `slow-compile` GPU suites: async pipeline
// creation resolves later with the real pipeline, sync creation holds the thread, errors pass through.
import test from 'node:test';
import assert from 'node:assert/strict';
import { delayPipelines } from '../scripts/browser.js';
import { compatShim } from '../scripts/support/compat-shim.js';

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
    delete globalThis.__margoDelayPipelines;
  }
});

test('delayPipelines is a no-op without WebGPU', () => {
  assert.equal(typeof globalThis.GPUDevice, 'undefined');
  assert.doesNotThrow(() => delayPipelines(10));
  delete globalThis.__margoDelayPipelines;
});

test('lazy compatibility installation delays the actual device and counts its pending promise', { timeout: 10_000 }, async (t) => {
  const ownLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const ownGpu = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  const ownDelay = Object.getOwnPropertyDescriptor(globalThis, '__margoDelayPipelines');
  const timers = [];
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => { timers.push({ callback, ms }); return 1; });
  const fixture = `
export class CompatDevice {
  createRenderPipelineAsync(descriptor) { return Promise.resolve(descriptor); }
  createComputePipelineAsync(descriptor) { return descriptor.fail ? Promise.reject(descriptor.fail) : Promise.resolve(descriptor); }
  createRenderPipeline(descriptor) { return descriptor; }
  createComputePipeline(descriptor) { return descriptor; }
}
export async function installCompat() {
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: {
    requestAdapter: async () => ({ requestDevice: async () => new CompatDevice() })
  }});
  return { installed: true };
}`;
  try {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'http://localhost/' } });
    delayPipelines(500); // Native WebGPU is absent and compatibility has not loaded yet.
    compatShim(`data:text/javascript,${encodeURIComponent(fixture)}`);
    const device = await (await navigator.gpu.requestAdapter()).requestDevice();
    for (const method of ['createRenderPipelineAsync', 'createComputePipelineAsync']) {
      const pipeline = { label: method };
      let settled = false;
      const promise = device[method](pipeline).then((result) => { settled = true; return result; });
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(timers.length, 1, `${method}: the installed device schedules exactly one delay`);
      assert.equal(timers[0].ms, 500);
      assert.equal(settled, false);
      assert.equal(globalThis.__margoPipelines.pending, 1);
      timers.shift().callback();
      assert.equal(await promise, pipeline, 'preserve pipeline identity');
      assert.equal(globalThis.__margoPipelines.pending, 0);
    }
    const failure = new Error('invalid compute shader');
    await assert.rejects(device.createComputePipelineAsync({ fail: failure }), (error) => error === failure);
    assert.equal(timers.length, 0, 'validation rejection is not delayed or replaced');
    assert.equal(globalThis.__margoPipelines.pending, 0, 'failed compilation releases readiness');
  } finally {
    if (ownGpu) Object.defineProperty(navigator, 'gpu', ownGpu); else delete navigator.gpu;
    if (ownLocation) Object.defineProperty(globalThis, 'location', ownLocation); else delete globalThis.location;
    if (ownDelay) Object.defineProperty(globalThis, '__margoDelayPipelines', ownDelay); else delete globalThis.__margoDelayPipelines;
    delete globalThis.__margoCompat;
    delete globalThis.__margoPipelines;
  }
});
