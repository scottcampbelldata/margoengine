import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { GPURenderer } from '../packages/core/dist/renderer.js';
import { EngineKernel } from '../packages/core/dist/index.js';
import { Stats } from '../packages/stats/dist/index.js';
import { Toon } from '../packages/toon/dist/index.js';
import { optionalGPU } from './support/optional-gpu.js';

function harness(t, offered) {
  const saved = Object.fromEntries(
      ['navigator', 'GPUBufferUsage', 'GPUTextureUsage'].map((key) => [
        key,
        Object.getOwnPropertyDescriptor(globalThis, key),
      ]),
    ),
    requests = [],
    devices = [],
    pipelines = [];
  const context = {
      configure() {},
      unconfigure() {},
      getCurrentTexture() {
        return { createView: () => ({}) };
      },
    },
    canvas = { width: 8, height: 6, clientWidth: 8, clientHeight: 6, getContext: () => context };
  const adapter = {
    features: new Set(offered),
    async requestDevice(descriptor) {
      assert.equal(this, adapter);
      requests.push(descriptor.requiredFeatures);
      const resources = [];
      const resource = () => {
        const value = {
          destroyed: false,
          destroy() {
            this.destroyed = true;
          },
        };
        resources.push(value);
        return value;
      };
      const device = {
        features: new Set(descriptor.requiredFeatures),
        resources,
        queries: 0,
        destroyed: false,
        lost: new Promise(() => {}),
        addEventListener() {},
        destroy() {
          this.destroyed = true;
        },
        queue: { writeBuffer() {}, submit() {} },
        createShaderModule: (descriptor) => descriptor,
        createBindGroup: () => ({}),
        createBuffer: resource,
        createQuerySet() {
          this.queries++;
          return resource();
        },
        createTexture(descriptor) {
          return Object.assign(resource(), descriptor, { createView: () => ({}) });
        },
        async createRenderPipelineAsync(descriptor) {
          pipelines.push(descriptor);
          return { getBindGroupLayout: () => ({}) };
        },
        createCommandEncoder: () => ({
          beginRenderPass(descriptor) {
            assert.equal(descriptor.timestampWrites, undefined);
            return { setPipeline() {}, setBindGroup() {}, end() {} };
          },
          beginComputePass() {},
          finish() {
            return {};
          },
          resolveQuerySet() {
            assert.fail('Off scene queried GPU');
          },
          copyBufferToBuffer() {
            assert.fail('Off scene read back GPU');
          },
        }),
      };
      devices.push(device);
      return device;
    },
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: '',
      gpu: { requestAdapter: async () => adapter, getPreferredCanvasFormat: () => 'bgra8unorm' },
    },
  });
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2, QUERY_RESOLVE: 4, COPY_SRC: 8, MAP_READ: 16 };
  globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 1 };
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    for (const [key, descriptor] of Object.entries(saved))
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
  };
  t.after(restore);
  return { adapter, canvas, requests, devices, pipelines, restore };
}

test('renderer requests only the advertised depth-stencil feature (never timestamp queries) and preserves effective primitive defaults', async (t) => {
  for (const offered of [
    [],
    ['timestamp-query'],
    ['depth32float-stencil8'],
    ['timestamp-query', 'depth32float-stencil8'],
  ]) {
    const h = harness(t, offered),
      renderer = await GPURenderer.create(h.canvas);
    try {
      assert.deepEqual(h.requests[0], offered.includes('depth32float-stencil8') ? ['depth32float-stencil8'] : []);
      const descriptor = h.pipelines[0];
      assert.equal(Object.hasOwn(descriptor, 'primitive'), false);
      assert.deepEqual(
        [
          descriptor.primitive?.topology ?? 'triangle-list',
          descriptor.primitive?.frontFace ?? 'ccw',
          descriptor.primitive?.cullMode ?? 'none',
        ],
        ['triangle-list', 'ccw', 'none'],
      );
      assert.equal(
        descriptor.depthStencil.format,
        offered.includes('depth32float-stencil8') ? 'depth32float-stencil8' : 'depth32float',
      );
      assert.equal(h.devices[0].queries, 0);
    } finally {
      renderer.dispose();
      h.restore();
    }
  }
});

test('engine restoration renegotiates support and Stats never allocates timestamp queries without the feature', async (t) => {
  const h = harness(t, ['timestamp-query', 'depth32float-stencil8']),
    dom = new JSDOM('<body></body>');
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  const engine = await EngineKernel.create(h.canvas, { capacity: 1, backend: 'webgpu' });
  try {
    const stats = Stats.attach(engine, { parent: dom.window.document.body });
    for (let i = 0; i < 30; i++) engine.render({ delta: 0.016 });
    assert.equal(h.devices[0].queries, 0);
    assert.equal(stats.gpuPassMilliseconds, null);
    assert.equal(stats.gpuTime, null);
    await engine.rebootDevice();
    assert.deepEqual(h.requests, [['depth32float-stencil8'], ['depth32float-stencil8']]);
    assert.equal(h.devices[0].destroyed, true);
    for (let i = 0; i < 30; i++) engine.render({ delta: 0.016 });
    assert.equal(h.devices[1].queries, 0);
    stats.enableGPUProfiling(h.devices[1]);
    assert.equal(h.devices[1].queries, 0, 'core no longer requests timestamp-query');
  } finally {
    engine.dispose();
    dom.window.close();
  }
  assert.ok(h.devices.every((device) => device.destroyed && device.resources.every((resource) => resource.destroyed)));
});

test('omitted default primitive state remains compatible with Toon outline overrides', () => {
  const h = optionalGPU(),
    effect = new Toon();
  delete h.context.descriptor.primitive;
  try {
    h.engine.use(effect);
    h.frame();
    const outline = h.pipelines.at(-1);
    assert.equal(outline.primitive.cullMode, 'front');
    assert.equal(outline.primitive.topology ?? 'triangle-list', 'triangle-list');
    assert.equal(outline.primitive.frontFace ?? 'ccw', 'ccw');
  } finally {
    effect.dispose();
    h.cleanup();
  }
});

test('failed pipeline setup destroys the negotiated device and retains its error', async (t) => {
  const h = harness(t, ['timestamp-query']),
    create = h.adapter.requestDevice;
  h.adapter.requestDevice = async function (...args) {
    const device = await create.apply(this, args);
    device.createRenderPipelineAsync = async () => {
      throw new Error('pipeline failed');
    };
    return device;
  };
  await assert.rejects(GPURenderer.create(h.canvas), /pipeline failed/);
  assert.equal(h.devices[0].destroyed, true);
  assert.equal(h.devices[0].queries, 0);
});

test('apps can opt in to extra GPU features, kept across device restores', async (t) => {
  const h = harness(t, ['timestamp-query', 'depth32float-stencil8']),
    dom = new JSDOM('<body></body>');
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  const engine = await EngineKernel.create(h.canvas, {
    capacity: 1,
    backend: 'webgpu',
    features: ['timestamp-query', 'shader-f16'],
  });
  try {
    assert.deepEqual(
      h.requests[0],
      ['depth32float-stencil8', 'timestamp-query'],
      'only features the adapter offers are requested',
    );
    assert.equal(h.devices[0].features.has('timestamp-query'), true, 'the device Stats profiles on has the feature');
    await engine.rebootDevice();
    assert.deepEqual(h.requests[1], ['depth32float-stencil8', 'timestamp-query'], 'restoration asks again');
  } finally {
    engine.dispose();
    dom.window.close();
  }
});
