// The shot driver (tools/shot/driver.js) on the WebGL2 compatibility layer (KB-SHOT-COMPAT-DET1). In a forced-
// compatibility run (MARGO_COMPAT=1, scripts/support/compat-shim.js) the layer's classes replace the browser's GPU
// interfaces on the first requestAdapter(), after the driver is installed. The driver used to patch the browser's own
// classes at install, so on the layer it tracked no device, no buffer map and no canvas texture: a readback the page
// started in frame N landed before frame N + 1 on one render and after it on the other, and `npm run test:shot`'s
// determinism check failed on MARGO_COMPAT=1 ("14 of 30 frames differ", RTX A6000). The driver now queues its GPU
// patch on the shim's `__margoOnLayer` and runs it on the layer's classes. Runs the driver as Playwright does (its
// source serialised into a page realm), here a vm context with stand-in GPU classes. No browser and no GPU.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { installShotDriver } from '../tools/shot/driver.js';

/** A stand-in set of GPU interfaces: a map, a device request and a canvas context that never finish on their own. */
function gpuClasses(tag) {
  const maps = [];
  class GPUBuffer {
    mapAsync() {
      const promise = new Promise(() => {});
      maps.push(promise);
      return promise;
    }
  }
  class GPUQueue {
    onSubmittedWorkDone() {
      return Promise.resolve();
    }
  }
  class GPUDevice {
    queue = new GPUQueue();
    lost = new Promise(() => {});
    createBuffer() {
      return new GPUBuffer();
    }
  }
  class GPUAdapter {
    requestDevice() {
      return Promise.resolve(new GPUDevice());
    }
  }
  class GPUShaderModule {}
  class GPUCanvasContext {
    configured = null;
    configure(config) {
      this.configured = config;
    }
    getCurrentTexture() {
      return { width: 4, height: 4, tag };
    }
  }
  return { tag, maps, GPUBuffer, GPUQueue, GPUDevice, GPUAdapter, GPUShaderModule, GPUCanvasContext };
}

/** A page realm with the browser's stand-in classes, the shot driver installed, and `compat` as the shim sets it. */
function page(compat) {
  const browser = gpuClasses('browser');
  const realm = createContext({
    performance: {},
    setTimeout,
    clearTimeout,
    document: { createElement: () => ({ getContext: () => null }), querySelector: () => null },
    __margoCompat: compat || undefined,
    ...browser,
  });
  runInContext(
    `(${installShotDriver})(${JSON.stringify({
      seed: 1,
      start: 0,
      epoch: 0,
      cell: [4, 4],
      cells: 1,
      out: [4, 4],
      msaa: null,
      noise: [0],
      noiseSize: 1,
    })})`,
    realm,
  );
  return { realm, browser };
}

/** What compatShim's load() does once the layer is installed: the layer's classes become the globals, then each queued patch runs. */
function installLayer(realm) {
  const layer = gpuClasses('layer');
  for (const [name, value] of Object.entries(layer)) if (name.startsWith('GPU')) realm[name] = value;
  for (const patch of realm.__margoOnLayer?.splice(0) ?? []) patch({});
  return layer;
}

test('on the WebGL2 layer the driver tracks the layer device, its buffer maps and its canvas textures', async () => {
  const { realm } = page(true);
  assert.equal(realm.__margoOnLayer?.length, 1, 'the GPU patch waits for the layer in a compatibility run');
  const layer = installLayer(realm);
  const device = await new layer.GPUAdapter().requestDevice();
  assert.equal(realm.__margoShot.pending, 0);
  // A readback the page starts in a frame: settle() must wait for it before the next frame.
  device.createBuffer().mapAsync(1);
  assert.equal(layer.maps.length, 1);
  assert.equal(
    realm.__margoShot.pending,
    1,
    "the layer's buffer map is not tracked, so a frame can run before it lands",
  );
  // The canvas is read from its texture (capture 'gpu'): configure asks for COPY_SRC beside the page's usage.
  const context = new layer.GPUCanvasContext();
  context.canvas = {};
  context.configure({ device, format: 'rgba8unorm', usage: 0x10 });
  assert.equal(context.configured.usage, 0x11, "the layer's canvas texture cannot be copied out");
});

test('on native WebGPU the driver patches the browser classes at once and queues nothing', async () => {
  const { realm, browser } = page(false);
  assert.equal(realm.__margoOnLayer, undefined);
  const device = await new browser.GPUAdapter().requestDevice();
  device.createBuffer().mapAsync(1);
  assert.equal(realm.__margoShot.pending, 1);
});
