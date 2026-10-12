import test from 'node:test';
import assert from 'node:assert/strict';
import {GPURenderer} from '../packages/core/dist/renderer.js';
import {Camera} from '../packages/core/dist/camera.js';
import {FrameGraph} from '../packages/core/dist/plugin.js';

async function harness(run) {
  const saved = Object.fromEntries(['navigator', 'GPUBufferUsage', 'GPUTextureUsage', 'GPUMapMode'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const textures = [], pipelines = [], passes = [], canvas = {width: 8, height: 6};
  const pipeline = descriptor => {pipelines.push(descriptor); return {getBindGroupLayout: () => ({})};};
  let acquisition = 0;
  const device = {
    features: new Set(), lost: new Promise(() => {}), addEventListener() {}, destroy() {},
    queue: {writeBuffer() {}, submit() {}},
    createBuffer: () => ({destroy() {}, async mapAsync() {}, getMappedRange: () => new Uint32Array([4294967295]).buffer, unmap() {}}),
    createBindGroup: () => ({}), createShaderModule: descriptor => descriptor,
    createRenderPipeline: pipeline, createRenderPipelineAsync: async descriptor => pipeline(descriptor),
    createTexture(descriptor) {
      const texture = {...descriptor, destroyed: false, destroy() {this.destroyed = true;}, createView() {return {texture};}};
      textures.push(texture); return texture;
    },
    createCommandEncoder: () => ({finish() {}, copyTextureToBuffer() {}, beginRenderPass(descriptor) {
      passes.push({...descriptor, colorAttachments: [...descriptor.colorAttachments].map(a => ({...a})), depthStencilAttachment: descriptor.depthStencilAttachment && {...descriptor.depthStencilAttachment}});
      return {setPipeline() {}, setBindGroup() {}, end() {}};
    }}),
  };
  const context = {configure() {}, unconfigure() {}, getCurrentTexture: () => ({createView: () => ({canvas: ++acquisition})})};
  canvas.getContext = () => context;
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {gpu: {requestAdapter: async () => ({features: device.features, requestDevice: async () => device}), getPreferredCanvasFormat: () => 'bgra8unorm'}}});
  globalThis.GPUBufferUsage = {UNIFORM: 1, COPY_DST: 2, COPY_SRC: 4, MAP_READ: 8};
  globalThis.GPUTextureUsage = {RENDER_ATTACHMENT: 1, COPY_SRC: 2};
  globalThis.GPUMapMode = {READ: 1};
  let renderer;
  try {
    renderer = await GPURenderer.create(canvas);
    const camera = new Camera(), lighting = {direction: new Float32Array([0, 1, 0, 1]), radiance: new Float32Array([1, 1, 1, 0.15])};
    await run({renderer, canvas, textures, pipelines, passes, camera, lighting, frame: graph => renderer.render(camera, lighting, [], graph, 0)});
  } finally {
    renderer?.dispose();
    for (const [key, descriptor] of Object.entries(saved)) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
  assert.ok(textures.every(texture => texture.destroyed));
}

test('4x canvas targets resolve fresh swapchain views and resize/dispose together', async () => harness(({canvas, textures, pipelines, passes, frame}) => {
  const graph = new FrameGraph();
  assert.equal(pipelines[0].multisample.count, 4);
  frame(graph); frame(graph);
  assert.deepEqual(textures.map(t => t.sampleCount), [1, 4, 4]);
  assert.ok(textures.every(t => t.size[0] === 8 && t.size[1] === 6));
  assert.deepEqual(passes.map(p => p.colorAttachments[0].resolveTarget.canvas), [1, 2]);
  assert.ok(passes.every(p => p.colorAttachments[0].storeOp === 'discard' && p.depthStencilAttachment.depthStoreOp === 'discard'));
  canvas.width = 16; canvas.height = 12; frame(graph);
  assert.ok(textures.slice(0, 3).every(t => t.destroyed));
  assert.deepEqual(textures.slice(3).map(t => t.sampleCount), [1, 4, 4]);
  assert.ok(textures.slice(3).every(t => t.size[0] === 16 && t.size[1] === 12));
  assert.equal(passes[2].colorAttachments[0].view.texture, textures[4]);
  assert.equal(passes[2].colorAttachments[0].resolveTarget.canvas, 3);
}));

test('extension passes retain MSAA attachments until final resolve and HDR stays single sampled', async () => harness(({passes, pipelines, frame}) => {
  const graph = new FrameGraph();
  const remove = graph.add({name: 'overlay', order: 1, execute(c) {
    assert.equal(c.descriptor.multisample.count, 4);
    c.encoder.beginRenderPass({colorAttachments: [{view: c.color, loadOp: 'load', storeOp: 'store'}]}).end();
  }});
  frame(graph);
  assert.equal(passes[0].colorAttachments[0].storeOp, 'store');
  assert.equal(passes[1].colorAttachments[0].view, passes[0].colorAttachments[0].view);
  assert.equal(passes[2].colorAttachments[0].resolveTarget.canvas, 1);
  assert.equal(passes[2].depthStencilAttachment.depthStoreOp, 'discard');
  remove();
  const hdrColor = {}, hdrDepth = {};
  const capture = graph.add({name: 'hdr', order: -1, execute(c) {c.color = hdrColor; c.depth = hdrDepth; c.format = 'rgba16float';}});
  frame(graph);
  assert.equal(pipelines.at(-1).multisample.count, 1);
  assert.equal(passes.at(-1).colorAttachments[0].view, hdrColor);
  assert.equal(passes.at(-1).colorAttachments[0].resolveTarget, undefined);
  capture(); frame(graph);
  assert.equal(passes.at(-1).colorAttachments[0].resolveTarget.canvas, 3);
  frame(new FrameGraph());
  assert.equal(passes.at(-1).depthStencilAttachment.depthStoreOp, 'discard');
  assert.equal(passes.at(-1).colorAttachments[0].resolveTarget.canvas, 4);
}));

test('integer picking remains single sampled with the MSAA renderer', async () => harness(async ({renderer, camera, lighting, pipelines, textures}) => {
  assert.equal(await renderer.pick(camera, lighting, [], new FrameGraph(), 0, 0), null);
  assert.equal(pipelines.at(-1).multisample.count, 1);
  assert.ok(textures.every(t => t.sampleCount === undefined));
}));

test('color-only capture retains compatible single-sample depth', async () => harness(({passes, pipelines, frame}) => {
  const graph = new FrameGraph(), color = {};
  graph.add({name: 'capture', order: -1, execute(c) {c.color = color;}});
  frame(graph);
  assert.equal(pipelines.at(-1).multisample.count, 1);
  assert.equal(passes[0].colorAttachments[0].view, color);
  assert.equal(passes[0].depthStencilAttachment.view.texture.sampleCount, 1);
}));
