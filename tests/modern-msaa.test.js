import test from 'node:test';
import assert from 'node:assert/strict';
import { GPURenderer } from '../packages/core/dist/renderer.js';
import { GLRenderer } from '../packages/webgl/dist/index.js';
import { SceneTarget } from '../packages/shared/msaa.js';
import { gpuHarness } from './support/postfx-gpu.js';
import { Camera } from '../packages/core/dist/camera.js';
import { FrameGraph } from '../packages/core/dist/plugin.js';

async function harness(run, userAgent = '') {
  const saved = Object.fromEntries(
    ['navigator', 'GPUBufferUsage', 'GPUTextureUsage', 'GPUMapMode'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const textures = [],
    pipelines = [],
    passes = [],
    canvas = { width: 8, height: 6 };
  const pipeline = (descriptor) => {
    pipelines.push(descriptor);
    return { getBindGroupLayout: () => ({}) };
  };
  let acquisition = 0;
  const device = {
    features: new Set(),
    lost: new Promise(() => {}),
    addEventListener() {},
    destroy() {},
    queue: { writeBuffer() {}, submit() {} },
    createBuffer: () => ({
      destroy() {},
      async mapAsync() {},
      getMappedRange: () => new Uint32Array([4294967295]).buffer,
      unmap() {},
    }),
    createBindGroup: () => ({}),
    createShaderModule: (descriptor) => descriptor,
    createRenderPipeline: pipeline,
    createRenderPipelineAsync: async (descriptor) => pipeline(descriptor),
    createTexture(descriptor) {
      const texture = {
        ...descriptor,
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
        createView() {
          return { texture };
        },
      };
      textures.push(texture);
      return texture;
    },
    createCommandEncoder: () => ({
      finish() {},
      copyTextureToBuffer() {},
      beginRenderPass(descriptor) {
        passes.push({
          ...descriptor,
          colorAttachments: [...descriptor.colorAttachments].map((a) => ({ ...a })),
          depthStencilAttachment: descriptor.depthStencilAttachment && { ...descriptor.depthStencilAttachment },
        });
        return { setPipeline() {}, setBindGroup() {}, end() {} };
      },
    }),
  };
  const context = {
    configure() {},
    unconfigure() {},
    getCurrentTexture: () => ({ createView: () => ({ canvas: ++acquisition }) }),
  };
  canvas.getContext = () => context;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent,
      gpu: {
        requestAdapter: async () => ({ features: device.features, requestDevice: async () => device }),
        getPreferredCanvasFormat: () => 'bgra8unorm',
      },
    },
  });
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2, COPY_SRC: 4, MAP_READ: 8 };
  globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 1, COPY_SRC: 2 };
  globalThis.GPUMapMode = { READ: 1 };
  let renderer;
  try {
    renderer = await GPURenderer.create(canvas);
    const camera = new Camera(),
      lighting = { direction: new Float32Array([0, 1, 0, 1]), radiance: new Float32Array([1, 1, 1, 0.15]) };
    await run({
      renderer,
      canvas,
      textures,
      pipelines,
      passes,
      camera,
      lighting,
      frame: (graph) => renderer.render(camera, lighting, [], graph, 0),
    });
  } finally {
    renderer?.dispose();
    for (const [key, descriptor] of Object.entries(saved))
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
  }
  assert.ok(textures.every((texture) => texture.destroyed));
}

test('4x canvas targets resolve fresh swapchain views and resize/dispose together', async () =>
  harness(({ canvas, textures, pipelines, passes, frame }) => {
    const graph = new FrameGraph();
    assert.equal(pipelines[0].multisample.count, 4);
    frame(graph);
    frame(graph);
    assert.deepEqual(
      textures.map((t) => t.sampleCount),
      [4, 4],
    );
    assert.ok(textures.every((t) => t.size[0] === 8 && t.size[1] === 6));
    assert.deepEqual(
      passes.map((p) => p.colorAttachments[0].resolveTarget.canvas),
      [1, 2],
    );
    assert.ok(
      passes.every(
        (p) => p.colorAttachments[0].storeOp === 'discard' && p.depthStencilAttachment.depthStoreOp === 'discard',
      ),
    );
    canvas.width = 16;
    canvas.height = 12;
    frame(graph);
    assert.ok(textures.slice(0, 2).every((t) => t.destroyed));
    assert.deepEqual(
      textures.slice(2).map((t) => t.sampleCount),
      [4, 4],
    );
    assert.ok(textures.slice(2).every((t) => t.size[0] === 16 && t.size[1] === 12));
    assert.equal(passes[2].colorAttachments[0].view.texture, textures[2]);
    assert.equal(passes[2].colorAttachments[0].resolveTarget.canvas, 3);
  }));

test('extension passes retain 4x attachments through HDR scene capture', async () =>
  harness(({ passes, pipelines, frame }) => {
    const graph = new FrameGraph();
    const remove = graph.add({
      name: 'overlay',
      order: 1,
      execute(c) {
        assert.equal(c.descriptor.multisample.count, 4);
        c.encoder.beginRenderPass({ colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }] }).end();
      },
    });
    frame(graph);
    assert.equal(passes[0].colorAttachments[0].storeOp, 'store');
    assert.equal(passes[1].colorAttachments[0].view, passes[0].colorAttachments[0].view);
    assert.equal(passes[2].colorAttachments[0].resolveTarget.canvas, 1);
    assert.equal(passes[2].depthStencilAttachment.depthStoreOp, 'discard');
    remove();
    const hdrColor = {},
      hdrDepth = {};
    const capture = graph.add({
      name: 'hdr',
      order: -1,
      execute(c) {
        c.color = hdrColor;
        c.depth = hdrDepth;
        c.format = 'rgba16float';
      },
    });
    frame(graph);
    assert.equal(pipelines.at(-1).multisample.count, 4);
    assert.equal(passes.at(-2).colorAttachments[0].view, hdrColor);
    assert.equal(passes.at(-2).colorAttachments[0].resolveTarget, undefined);
    capture();
    frame(graph);
    assert.equal(passes.at(-1).colorAttachments[0].resolveTarget.canvas, 3);
    frame(new FrameGraph());
    assert.equal(passes.at(-1).depthStencilAttachment.depthStoreOp, 'discard');
    assert.equal(passes.at(-1).colorAttachments[0].resolveTarget.canvas, 4);
  }));

test('integer picking remains single sampled with the MSAA renderer', async () =>
  harness(async ({ renderer, camera, lighting, pipelines, textures }) => {
    assert.equal(await renderer.pick(camera, lighting, [], new FrameGraph(), 0, 0), null);
    assert.equal(pipelines.at(-1).multisample.count, 1);
    assert.ok(textures.every((t) => t.sampleCount === undefined));
  }));

test('color-only capture retains 4x scene depth', async () =>
  harness(({ passes, pipelines, frame }) => {
    const graph = new FrameGraph(),
      color = {};
    graph.add({
      name: 'capture',
      order: -1,
      execute(c) {
        c.color = color;
      },
    });
    frame(graph);
    assert.equal(pipelines[0].multisample.count, 4);
    assert.equal(passes[0].colorAttachments[0].view, color);
    assert.equal(passes[0].depthStencilAttachment.view.texture.sampleCount, 4);
  }));

test('iPhone scene writes directly to the canvas without MSAA textures or resolves', async () =>
  harness(({ passes, pipelines, textures, frame }) => {
    const graph = new FrameGraph();
    graph.add({
      name: 'overlay',
      order: 1,
      execute(c) {
        assert.equal(c.descriptor.multisample.count, 1);
        c.encoder.beginRenderPass({ colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }] }).end();
      },
    });
    frame(graph);
    frame(graph);
    assert.equal(textures.length, 1);
    assert.equal(textures[0].sampleCount, 1);
    assert.ok(pipelines.every((p) => p.multisample.count === 1));
    assert.ok(
      passes.every(
        (p) =>
          p.colorAttachments[0].view.canvas &&
          p.colorAttachments[0].resolveTarget === undefined &&
          p.colorAttachments[0].storeOp === 'store',
      ),
    );
  }, 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'));

test('phone WebGL fallback also disables canvas multisampling', () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    for (const [userAgent, antialias] of [
      ['iPhone Mobile', false],
      ['Android', false],
      ['Windows NT', true],
    ]) {
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent } });
      assert.throws(
        () =>
          new GLRenderer({
            getContext(type, options) {
              assert.equal(type, 'webgl2');
              assert.equal(options.antialias, antialias);
              return null;
            },
          }),
        /No WebGL2/,
      );
    }
  } finally {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved);
    else delete globalThis.navigator;
  }
});

test('single-sample optional captures allocate no intermediates and never resolve', () => {
  const h = gpuHarness(),
    color = h.engine.gpu.createTexture({ size: [128, 96], format: 'rgba16float' }),
    depth = h.engine.gpu.createTexture({ size: [128, 96], format: 'depth32float' }),
    count = h.counts.textures;
  const target = new SceneTarget(h.engine.gpu, color, depth, 1);
  assert.equal(h.counts.textures, count);
  assert.throws(() => new SceneTarget(h.engine.gpu, color, depth, 2), /1 or 4/);
  h.context.descriptor.multisample.count = 1;
  target.begin(h.context);
  target.resolve(h.context.encoder, true);
  target.restore(h.context);
  assert.equal(h.counts.render, 0);
  assert.equal(h.pipelines.length, 0);
  assert.equal(h.context.color, h.originalColor);
  assert.equal(h.context.depth, h.originalDepth);
  target.dispose();
  assert.equal(color.destroyed, false);
  assert.equal(depth.destroyed, false);
  color.destroy();
  depth.destroy();
});

test('standalone 4x HDR captures resolve depth and discard samples without an outer scene', () => {
  const h = gpuHarness(),
    color = h.engine.gpu.createTexture({ size: [128, 96], format: 'rgba16float' }),
    depth = h.engine.gpu.createTexture({ size: [128, 96], format: 'depth32float' });
  const target = new SceneTarget(h.engine.gpu, color, depth, 4);
  target.resolve(h.context.encoder, true);
  const pass = h.context.presentation;
  assert.equal(pass.colorAttachments[0].resolveTarget.texture, color);
  assert.equal(pass.colorAttachments[0].storeOp, 'discard');
  assert.equal(pass.depthStencilAttachment.depthStoreOp, 'discard');
  assert.equal(h.pipelines[0].multisample.count, 1);
  assert.match(h.pipelines[0].fragment.module.code, /return max/);
  target.dispose();
  assert.ok(h.resources.slice(2).every((t) => t.destroyed));
  assert.equal(color.destroyed, false);
  color.destroy();
  depth.destroy();
});
