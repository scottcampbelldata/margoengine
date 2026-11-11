import test from 'node:test';
import assert from 'node:assert/strict';
import { Shadows } from '../dist/index.js';
import { VirtualShadows } from '../dist/virtual.js';
import { mockGPU, context, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { injectGPUFaults } from '../../../tests/support/gpu-faults.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { GPURenderer } from '../../core/dist/renderer.js';
import { box } from '../../core/dist/index.js';

// KB6434b, KB6434d, KB-C34g. Shadows and VirtualShadows make its maps outside error scopes on purpose: receivers bind them in the first frame after
// an attach, a restore or a new map size, so that frame is shadowed. A failed allocation reaches core's `uncapturederror`
// listener, which (KB6434a) reports it once and rebuilds the device; the restore makes the maps again and frames go on.
// Package containment (scoped maps, a fallback until the device confirms them) was tried on branch core34 and dropped:
// it drew the first frame after every attach unshadowed (materials browser-check catcherSun).
globalThis.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128 };
globalThis.GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 };
globalThis.GPUOutOfMemoryError ??= class GPUOutOfMemoryError extends Error {};

/** A recording device that loses itself on destroy() and dispatches events, as a WebGPU device does. */
function device() {
  const gpu = mockGPU(),
    events = new EventTarget();
  let lose;
  const scopes = [];
  Object.assign(gpu.device, {
    // Error scopes as a device keeps them: a stack whose pops report nothing unless an error was raised into them.
    pushErrorScope: (filter) => scopes.push(filter),
    popErrorScope: async () => {
      if (!scopes.pop()) throw new DOMException('No error scope', 'OperationError');
      return null;
    },
    lost: new Promise((resolve) => (lose = resolve)),
    destroy() {
      this.destroyed = true;
      lose({ reason: 'destroyed', message: 'destroyed' });
    },
    addEventListener: events.addEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    createCommandEncoder: () => ({ finish: () => ({}), beginRenderPass: () => ({ end() {} }) }),
  });
  gpu.device.queue.submit ??= () => {};
  // Views name their texture, so a test can tell which map receivers bind.
  const make = gpu.device.createTexture;
  gpu.device.createTexture = (descriptor) => {
    const texture = make(descriptor),
      view = texture.createView;
    texture.createView = (d) => Object.assign(view(d), { texture });
    return texture;
  };
  const surface = { configure() {}, unconfigure() {}, getCurrentTexture: () => ({ createView: () => ({}) }) },
    pipeline = gpu.device.createRenderPipeline({});
  // core's own renderer on this device: its `uncapturederror` listener is the one under test.
  gpu.renderer = new GPURenderer(
    { width: 128, height: 96 },
    gpu.device,
    surface,
    'bgra8unorm',
    pipeline,
    { multisample: { count: 1 }, depthStencil: { format: 'depth32float' } },
    pipeline,
  );
  gpu.view = context(gpu, { samples: 1, shader: 'let linear=direct*vec3f(1);' });
  return gpu;
}

async function harness() {
  const first = device(),
    store = await TransformStore.create(16),
    canvas = { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    engine = new Engine(canvas, store, first.renderer, { position: [0, 2, 6], target: [0, 0, 0] }, null),
    errors = [];
  engine.onError = (error) => errors.push(error);
  const cube = engine.createMesh().setGeometry(box()).setPosition([0, 0.5, 0]);
  return {
    first,
    engine,
    cube,
    errors,
    /** One frame through the shadows pass on `gpu`; returns the depth passes it began. */
    frame(shadows, gpu) {
      store.tick(false);
      gpu.view.begin(0);
      gpu.view.camera.position = [0, 2, 6];
      const log = gpu.record(() => passes(shadows)(gpu.view.c));
      return log.filter(([name]) => name === 'beginRenderPass').length;
    },
  };
}
/** The shadow map receivers bind, and whether it is a live texture of `gpu`. */
const bound = (shadows) => shadows.bindings().find((e) => e.resource?.texture?.format === 'depth32float')?.resource.texture;

test('Shadows: the first frame after attach draws the depth passes and binds the real maps (KB-C34g)', async () => {
  const h = await harness(),
    shadows = new Shadows({ resolution: 64, cascades: 2 });
  try {
    h.engine.use(shadows);
    shadows.add(h.cube);
    assert.ok(h.frame(shadows, h.first) > 0, 'the depth passes draw in the first frame');
    assert.ok(shadows.depthTexture, 'the map is handed out at once');
    assert.equal(bound(shadows), shadows.depthTexture, 'receivers bind the map the depth passes drew into');
    assert.equal(bound(shadows).width, 64);
  } finally {
    h.engine.dispose();
  }
});

for (const [what, method, select] of [
  ['the combined depth map', 'createTexture', (d) => d.format === 'depth32float' && d.size?.[0] === 64],
  ['the shadow uniform', 'createBuffer', (d) => d.size === 384],
]) {
  test(`Shadows: an out-of-memory ${what} is reported once and core's device rebuild gives working shadows (KB6434b)`, async () => {
    const h = await harness(),
      next = device(),
      shadows = new Shadows({ resolution: 64, cascades: 2 }),
      create = GPURenderer.create;
    GPURenderer.create = async () => next.renderer;
    try {
      {
        using faults = injectGPUFaults(h.first.device, { [method]: 1, select: (m, d) => m === method && select(d) });
        h.engine.use(shadows);
        shadows.add(h.cube);
        assert.equal(faults.injected.length, 1, 'the allocation was made and failed');
      }
      // The failure reaches uncapturederror in a later task; core destroys the device and restores on a new one.
      for (let i = 0; i < 50 && h.engine.gpu !== next.device; i++) await new Promise((r) => setTimeout(r, 0));
      assert.equal(h.first.device.destroyed, true, 'the failed device is destroyed');
      assert.equal(h.engine.gpu, next.device, 'the engine moved to a new device');
      assert.equal(h.errors.length, 1, 'reported once');
      assert.match(String(h.errors[0].message), /GPU out of memory/);
      assert.ok(h.frame(shadows, next) > 0, 'the depth passes draw on the new device');
      const map = bound(shadows);
      assert.equal(map, shadows.depthTexture, 'receivers bind the remade map');
      assert.ok(!map.destroyed && map.width === 64);
      for (const e of shadows.bindings()) {
        const resource = e.resource?.buffer ?? e.resource?.texture;
        if (resource) assert.ok(!resource.destroyed, `binding ${e.binding} is live`);
      }
      assert.equal(h.errors.length, 1, 'nothing more is reported');
    } finally {
      GPURenderer.create = create;
      h.engine.dispose();
    }
  });
}

// KB6434d: VirtualShadows goes the same way. Its pools, page table, uniform and buffers are made outside error scopes,
// so receivers bind them at once; an out-of-memory one is recovered by core's device rebuild.
for (const [what, method, select] of [
  ['page pool', 'createTexture', (d) => d.format === 'depth32float' && d.size?.[0] === 1024],
  ['uniform', 'createBuffer', (d) => d.size === 528],
]) {
  test(`VirtualShadows: an out-of-memory ${what} is reported once and core's device rebuild gives a working pool (KB6434d)`, async () => {
    const h = await harness(),
      next = device(),
      shadows = new VirtualShadows({ poolSize: 1024, levels: 4 }),
      create = GPURenderer.create;
    GPURenderer.create = async () => next.renderer;
    try {
      {
        using faults = injectGPUFaults(h.first.device, { [method]: 1, select: (m, d) => m === method && select(d) });
        h.engine.use(shadows);
        shadows.add(h.cube);
        assert.equal(faults.injected.length, 1, 'the allocation was made and failed');
        assert.equal(bound(shadows).width, 1024, 'receivers bind the pool in the first frame');
      }
      for (let i = 0; i < 50 && h.engine.gpu !== next.device; i++) await new Promise((r) => setTimeout(r, 0));
      assert.equal(h.first.device.destroyed, true, 'the failed device is destroyed');
      assert.equal(h.engine.gpu, next.device, 'the engine moved to a new device');
      assert.equal(h.errors.length, 1, 'reported once');
      assert.match(String(h.errors[0].message), /GPU out of memory/);
      h.frame(shadows, next);
      assert.ok(!bound(shadows).destroyed && bound(shadows).width === 1024, 'receivers bind the remade pool');
      for (const e of shadows.bindings()) {
        const resource = e.resource?.buffer ?? e.resource?.texture;
        if (resource) assert.ok(!resource.destroyed, `binding ${e.binding} is live`);
      }
      assert.equal(h.errors.length, 1, 'nothing more is reported');
    } finally {
      GPURenderer.create = create;
      h.engine.dispose();
    }
  });
}
