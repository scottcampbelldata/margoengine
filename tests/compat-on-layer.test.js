// KB-COMPAT-AUDIT1: an init script that audits GPU work by patching `GPUDevice.prototype` (creative's earth audit,
// margo-module-tests' phone MSAA audit) patched the browser's own classes in a forced-compatibility run, which the
// WebGL2 layer's devices never call, so the audit counted nothing on the layer. compatShim (scripts/support/
// compat-shim.js) runs the patches queued on `__margoOnLayer` once, after the layer is installed, so they patch the
// layer's classes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compatShim } from '../scripts/support/compat-shim.js';

test('compatShim runs the patches queued on __margoOnLayer after the layer installs, on its classes', {
  timeout: 10_000,
}, async () => {
  const ownLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const ownGpu = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  const ownDevice = Object.getOwnPropertyDescriptor(globalThis, 'GPUDevice');
  const fixture = `
export class CompatDevice {
  createTexture(descriptor) { return { descriptor }; }
  createRenderPipelineAsync(descriptor) { return Promise.resolve(descriptor); }
  createComputePipelineAsync(descriptor) { return Promise.resolve(descriptor); }
}
export async function installCompat() {
  Object.defineProperty(globalThis, 'GPUDevice', { configurable: true, writable: true, value: CompatDevice });
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: {
    requestAdapter: async () => ({ requestDevice: async () => new CompatDevice() })
  }});
  return { installed: true };
}`;
  class NativeDevice {
    createTexture() {
      throw new Error('the layer never calls the browser device');
    }
  }
  try {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'http://localhost/' } });
    globalThis.GPUDevice = NativeDevice;
    compatShim(`data:text/javascript,${encodeURIComponent(fixture)}`);
    // An audit init script, as creative and margo-module-tests write theirs.
    const audit = { textures: 0, calls: 0, module: null };
    const patch = (module) => {
      audit.calls++;
      audit.module = module;
      const create = GPUDevice.prototype.createTexture;
      GPUDevice.prototype.createTexture = function (descriptor) {
        if ((descriptor.sampleCount ?? 1) > 1) audit.textures++;
        return create.call(this, descriptor);
      };
    };
    assert.equal(globalThis.__margoCompat, true);
    if (globalThis.__margoCompat) (globalThis.__margoOnLayer ??= []).push(patch);
    else patch();
    assert.equal(audit.calls, 0, 'nothing is patched before the layer installs');
    const device = await (await navigator.gpu.requestAdapter()).requestDevice();
    assert.equal(audit.calls, 1, 'the queued patch ran once');
    assert.equal(audit.module.CompatDevice, device.constructor, 'it receives the layer module');
    assert.notEqual(GPUDevice, NativeDevice);
    device.createTexture({ sampleCount: 4 });
    device.createTexture({ sampleCount: 1 });
    assert.equal(audit.textures, 1, "the audit counts the layer device's work");
    assert.deepEqual(globalThis.__margoOnLayer, [], 'the queue is drained');
    await navigator.gpu.requestAdapter();
    assert.equal(audit.calls, 1, 'a second adapter does not patch twice');
  } finally {
    if (ownGpu) Object.defineProperty(navigator, 'gpu', ownGpu);
    else delete navigator.gpu;
    if (ownLocation) Object.defineProperty(globalThis, 'location', ownLocation);
    else delete globalThis.location;
    if (ownDevice) Object.defineProperty(globalThis, 'GPUDevice', ownDevice);
    else delete globalThis.GPUDevice;
    delete globalThis.__margoCompat;
    delete globalThis.__margoOnLayer;
    delete globalThis.__margoPipelines;
  }
});

test('the MSAA audits of creative and margo-module-tests defer to __margoOnLayer and prove they counted work', () => {
  for (const file of ['packages/creative/scripts/test-browser.js', 'scripts/margo-module-tests.js']) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(text, /addInitScript\(compatShim/, `${file} installs the shim on its own pages`);
    assert.match(text, /__margoOnLayer \?\?= \[\]\)\.push\(/, `${file} queues its GPU-class patch for the layer`);
  }
});
