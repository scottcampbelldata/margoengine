// The silent WebGPU startup hang (Intel Arc 140V, 2026-10-30): with 3 or 4 WebGPU pages alive in one browser process,
// the 4th page's `requestDevice` (or its second `createRenderPipelineAsync`) never settled. `Engine.create` then never
// settled either: no rejection, no console message, a blank 300x150 canvas and no WebGL2 fallback. Each startup step now
// warns once, rejects with MargoError code `timeout` naming the step, honours `signal`, and destroys a late device.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Engine } from '../packages/core/dist/index.js';
import { GPURenderer } from '../packages/core/dist/renderer.js';
import { createStage } from '../packages/stage/dist/index.js';
import { webglRenderer } from '../packages/webgl/dist/index.js';
import { glDrawHarness } from './support/core-draw-gpu.js';

const never = () => new Promise(() => {});
const quick = { startupWarning: 20, startupTimeout: 80 };

/** A fake WebGPU whose steps answer or hang as `stall` says: 'adapter', 'device', 'pipeline' (the 2nd compile). */
function fakeGPU(t, { stall, lateDevice = false } = {}) {
  const saved = Object.fromEntries(
    ['navigator', 'GPUBufferUsage', 'GPUTextureUsage'].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]),
  );
  const devices = [],
    compiles = [];
  const makeDevice = () => {
    const device = {
      features: new Set(),
      destroyed: false,
      lost: never(),
      destroy() {
        this.destroyed = true;
      },
      createShaderModule: (d) => d,
      createRenderPipelineAsync(descriptor) {
        compiles.push(descriptor);
        return stall === 'pipeline' && compiles.length === 2 ? never() : Promise.resolve({});
      },
    };
    devices.push(device);
    return device;
  };
  let releaseDevice;
  const adapter = {
    features: new Set(),
    limits: { maxTextureArrayLayers: 256 },
    requestDevice() {
      if (lateDevice) return new Promise((resolve) => (releaseDevice = () => resolve(makeDevice())));
      return stall === 'device' ? never() : Promise.resolve(makeDevice());
    },
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: 'test',
      gpu: {
        requestAdapter: () => (stall === 'adapter' ? never() : Promise.resolve(adapter)),
        getPreferredCanvasFormat: () => 'bgra8unorm',
      },
    },
  });
  t.after(() => {
    for (const [k, d] of Object.entries(saved))
      if (d) Object.defineProperty(globalThis, k, d);
      else delete globalThis[k];
  });
  return { devices, compiles, release: () => releaseDevice() };
}

const canvas = () => ({ width: 8, height: 6, getContext: () => null });

for (const [stall, step] of [
  ['adapter', 'requestAdapter'],
  ['device', 'requestDevice'],
  ['pipeline', 'createRenderPipelineAsync'],
])
  test(`a ${step} that never settles warns once, then rejects with code timeout naming it`, async (t) => {
    const gpu = fakeGPU(t, { stall });
    const warn = t.mock.method(console, 'warn', () => {});
    const started = Date.now();
    await assert.rejects(GPURenderer.create(canvas(), [], 1, quick), (error) => {
      assert.equal(error.name, 'MargoError');
      assert.equal(error.code, 'timeout');
      assert.match(
        error.message,
        new RegExp(`WebGPU ${step} never settled; see https://margoengine.com/errors#timeout`),
      );
      return true;
    });
    assert.ok(Date.now() - started < 2000, 'rejects near its limit');
    assert.equal(warn.mock.callCount(), 1, 'one warning');
    assert.match(
      warn.mock.calls[0].arguments[0],
      new RegExp(`^Margo: still waiting for ${step} after 0.02 s; see https://margoengine.com/errors#timeout$`),
    );
    // A device made before the stalled compile is released with the rejection.
    if (stall === 'pipeline') assert.ok(gpu.devices[0].destroyed, 'the device of a stalled compile is destroyed');
  });

test('a step that settles before the warning neither warns nor leaves a timer behind', async (t) => {
  fakeGPU(t);
  const warn = t.mock.method(console, 'warn', () => {});
  await assert.rejects(GPURenderer.create(canvas(), [], 1, quick), /No WebGPU canvas/);
  // fixed-wait: longer than the warning and the limit, to prove neither fires after the steps settled
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(warn.mock.callCount(), 0);
});

test('a device that arrives after the limit is destroyed, not leaked', async (t) => {
  const gpu = fakeGPU(t, { lateDevice: true });
  t.mock.method(console, 'warn', () => {});
  await assert.rejects(GPURenderer.create(canvas(), [], 1, quick), { code: 'timeout' });
  gpu.release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gpu.devices.length, 1);
  assert.ok(gpu.devices[0].destroyed, 'the late device was destroyed');
  assert.equal(gpu.compiles.length, 0, 'nothing was built on it');
});

test("backend 'auto' falls back to WebGL2 when WebGPU startup times out", async (t) => {
  fakeGPU(t, { stall: 'device' });
  t.mock.method(console, 'warn', () => {});
  const h = glDrawHarness(t);
  const engine = await Engine.create(h.canvas, { fallback: webglRenderer, ...quick });
  t.after(() => engine.dispose());
  assert.equal(engine.backend, 'webgl2');
  assert.match(engine.fallbackReason, /requestDevice never settled/);
});

test("backend 'webgpu' rejects with the timeout instead of hanging", async (t) => {
  fakeGPU(t, { stall: 'pipeline' });
  t.mock.method(console, 'warn', () => {});
  await assert.rejects(Engine.create(canvas(), { backend: 'webgpu', ...quick }), {
    code: 'timeout',
    message: /createRenderPipelineAsync/,
  });
});

test('signal aborts a pending step with its reason and never falls back', async (t) => {
  const gpu = fakeGPU(t, { stall: 'device' });
  const warn = t.mock.method(console, 'warn', () => {});
  const controller = new AbortController(),
    reason = new Error('page closed');
  const pending = Engine.create(glDrawHarness(t).canvas, { fallback: webglRenderer, signal: controller.signal });
  // fixed-wait: lets creation reach the stalled requestDevice before aborting
  await new Promise((resolve) => setTimeout(resolve, 30));
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(warn.mock.callCount(), 0, 'no warning after an abort (default warning is 8 s)');
  assert.equal(gpu.devices.length, 0);
});

test('an already aborted signal rejects before WebGPU is asked', async (t) => {
  let asked = 0;
  fakeGPU(t);
  navigator.gpu.requestAdapter = () => (asked++, never());
  await assert.rejects(Engine.create(canvas(), { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(asked, 0);
});

test('createStage passes signal and the startup limits to Engine.create', async (t) => {
  fakeGPU(t, { stall: 'adapter' });
  t.mock.method(console, 'warn', () => {});
  const { document } = new JSDOM('<body><div id="scene"></div></body>').window,
    host = document.querySelector('#scene');
  await assert.rejects(createStage(host, { controls: false, autoStart: false, backend: 'webgpu', ...quick }), {
    code: 'timeout',
    message: /requestAdapter/,
  });
  await assert.rejects(createStage(host, { controls: false, signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(host.querySelector('canvas'), null, 'the canvas the stage made is removed on a failed start');
});
