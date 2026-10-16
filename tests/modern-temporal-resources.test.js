import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera, PbrMaterial, box } from '../packages/core/dist/extension.js';
import { GPURenderer } from '../packages/core/dist/renderer.js';
import { TAA } from '../packages/taa/dist/index.js';
import { Scatter, ScatterInstances } from '../packages/scatter/dist/index.js';
import { wgsl } from '../packages/core/src/shaders.ts';
import { optionalGPU } from './support/optional-gpu.js';

function batch() {
  const vertices = new Float32Array(60);
  vertices[20] = vertices[41] = 1;
  for (let i = 0; i < 3; i++) {
    vertices[i * 20 + 6] = 1;
    vertices.fill(1, i * 20 + 16, i * 20 + 20);
  }
  return {
    name: 'triangle',
    vertices,
    indices: new Uint32Array([0, 1, 2]),
    transforms: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    material: new PbrMaterial(),
  };
}

async function integration(run) {
  const keys = ['navigator', 'GPUBufferUsage', 'GPUTextureUsage', 'GPUMapMode'];
  const globals = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const h = optionalGPU(),
    device = h.engine.gpu;
  device.lost = new Promise(() => {});
  device.addEventListener = () => {};
  device.destroy = () => {};
  device.createRenderPipelineAsync = async (descriptor) => device.createRenderPipeline(descriptor);
  device.queue.submit = () => {};
  h.context.encoder.finish = () => ({});
  device.createCommandEncoder = () => h.context.encoder;
  const canvasContext = { configure() {}, unconfigure() {}, getCurrentTexture: () => ({ createView: () => ({}) }) };
  const canvas = { width: 128, height: 96, getContext: () => canvasContext };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: '',
      gpu: {
        requestAdapter: async () => ({ features: device.features, requestDevice: async () => device }),
        getPreferredCanvasFormat: () => 'bgra8unorm',
      },
    },
  });
  const camera = new Camera();
  camera.update(canvas.width / canvas.height, true);
  const lighting = { direction: new Float32Array([0, 1, 0, 1]), radiance: new Float32Array([1, 1, 1, 0.1]) };
  h.engine.camera = camera;
  h.engine.lighting = lighting;
  const taa = new TAA(),
    scatter = new ScatterInstances(() => [batch()]);
  let renderer;
  try {
    renderer = await GPURenderer.create(canvas);
    h.engine.use(taa);
    h.engine.use(scatter);
    const entries = [],
      matrices = [];
    h.engine.frameGraph.add({
      name: 'observe:taa-camera',
      order: -1,
      execute(c) {
        const cameraBinding = c.bindings.find((entry) => entry.binding === 18);
        assert.ok(cameraBinding, 'TAA must expose its camera uniform at the reserved binding');
        entries.push(cameraBinding);
        matrices.push(c.camera.matrix.slice());
      },
    });
    const frame = () => renderer.render(camera, lighting, [], h.engine.frameGraph, 1 / 60);
    await run({ ...h, camera, canvas, taa, scatter, renderer, entries, matrices, frame });
  } finally {
    scatter.dispose();
    taa.dispose();
    renderer?.dispose();
    assert.ok(
      h.resources.every((resource) => resource.destroyed),
      'Owned GPU resources survive disposal',
    );
    for (const [key, descriptor] of globals)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
  }
}

test('TAA camera updates reuse core bind groups and ScatterInstances pipelines across stable frames', async () =>
  integration((h) => {
    const unjittered = h.camera.matrix.slice();
    h.frame();
    const baseline = {
      pipelines: h.pipelines.length,
      groups: h.counts.groups,
      buffers: h.counts.buffers,
      textures: h.counts.textures,
    };
    for (let i = 0; i < 8; i++) h.frame();
    assert.deepEqual(
      {
        pipelines: h.pipelines.length - baseline.pipelines,
        groups: h.counts.groups - baseline.groups,
        buffers: h.counts.buffers - baseline.buffers,
        textures: h.counts.textures - baseline.textures,
      },
      { pipelines: 0, groups: 0, buffers: 0, textures: 0 },
      'Unchanged TAA camera buffer must not invalidate rendering resources',
    );
    assert.ok(h.entries.every((entry) => entry === h.entries[0]));
    assert.ok(h.entries.every((entry) => entry.resource === h.entries[0].resource));
    assert.notDeepEqual(h.matrices[0], h.matrices[1], 'Camera jitter must keep advancing');
    assert.deepEqual(new Float32Array(h.entries.at(-1).resource.buffer.data).subarray(0, 16), h.matrices.at(-1));
    assert.deepEqual(h.camera.matrix, unjittered, 'Public camera matrix must be restored after presentation');
  }));

test('TAA resize keeps the camera binding and device restoration replaces it without retaining old buffers', async () =>
  integration((h) => {
    h.frame();
    const original = h.entries.at(-1),
      oldBuffer = original.resource.buffer;
    h.canvas.width = 256;
    h.frame();
    assert.equal(h.entries.at(-1), original, 'Resize changes textures, not the camera uniform buffer');
    h.taa.onDeviceRestored(h.engine);
    assert.equal(oldBuffer.destroyed, true);
    h.frame();
    const restored = h.entries.at(-1);
    assert.notEqual(restored, original);
    assert.notEqual(restored.resource.buffer, oldBuffer);
    const cameraGroups = h.groups.filter((group) =>
      group.entries.some((entry) => entry.binding === 18 && entry.resource === restored.resource),
    );
    assert.equal(cameraGroups.length, 2, 'Core and Scatter must bind the recreated camera buffer');
    const counts = { pipelines: h.pipelines.length, groups: h.counts.groups };
    h.frame();
    assert.deepEqual({ pipelines: h.pipelines.length, groups: h.counts.groups }, counts);
    h.scatter.onDeviceRestored(h.engine);
    h.frame();
    const afterScatterRestore = { pipelines: h.pipelines.length, groups: h.counts.groups };
    h.frame();
    assert.deepEqual({ pipelines: h.pipelines.length, groups: h.counts.groups }, afterScatterRestore);
  }));

test('ScatterInstances replaces changed lighting bindings without recompiling an unchanged shader pipeline', () => {
  const h = optionalGPU();
  h.engine.lighting = { direction: new Float32Array([0, 1, 0, 1]), radiance: new Float32Array([1, 1, 1, 0.1]) };
  h.context.shader =
    '@group(0) @binding(8) var<uniform> taaCamera:mat4x4f;\n' +
    wgsl.replace('o.clip=frame.camera*p', 'o.clip=taaCamera*p');
  const buffer = () => h.engine.gpu.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const first = buffer(),
    second = buffer(),
    scatter = new ScatterInstances(() => [batch()]);
  try {
    h.context.bindings = [{ binding: 8, resource: { buffer: first, size: 64 } }];
    h.engine.use(scatter);
    h.engine.frameGraph.execute(h.context);
    const pipelineCount = h.pipelines.length,
      groupCount = h.counts.groups;
    h.context.bindings = [{ binding: 8, resource: { buffer: second, size: 64 } }];
    h.engine.frameGraph.execute(h.context);
    assert.equal(
      h.pipelines.length,
      pipelineCount,
      'Changing a GPU buffer does not change the pipeline layout or shader',
    );
    assert.equal(h.counts.groups, groupCount + 1);
    assert.equal(h.groups.at(-1).entries.find((entry) => entry.binding === 8).resource.buffer, second);
    h.engine.frameGraph.execute(h.context);
    assert.equal(h.counts.groups, groupCount + 1);
    h.context.shader = h.context.shader.replace('let linear=direct*', 'let linear=direct*0.75*');
    h.engine.frameGraph.execute(h.context);
    assert.equal(h.pipelines.length, pipelineCount + 1, 'Shader changes must still recreate the pipeline');
    h.context.format = 'rgba16float';
    h.engine.frameGraph.execute(h.context);
    assert.equal(h.pipelines.length, pipelineCount + 2);
    h.context.descriptor = { ...h.context.descriptor, multisample: { count: 1 } };
    h.engine.frameGraph.execute(h.context);
    assert.equal(h.pipelines.length, pipelineCount + 3);
    const depth = h.engine.gpu.createTexture({
      size: [h.context.width, h.context.height],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    try {
      h.context.depth = depth.createView();
      h.context.descriptor = {
        ...h.context.descriptor,
        depthStencil: { ...h.context.descriptor.depthStencil, format: depth.format },
      };
      h.engine.frameGraph.execute(h.context);
      assert.equal(
        h.pipelines.length,
        pipelineCount + 4,
        'A changed depth attachment format needs a compatible ScatterInstances pipeline',
      );
      assert.equal(h.pipelines.at(-1).depthStencil.format, depth.format);
      h.engine.frameGraph.execute(h.context);
      assert.equal(h.pipelines.length, pipelineCount + 4);
    } finally {
      depth.destroy();
    }
  } finally {
    scatter.dispose();
    first.destroy();
    second.destroy();
    assert.ok(h.resources.every((resource) => resource.destroyed));
  }
});

test('GPU Scatter caches distinct pipelines for public context depth-format transitions', () => {
  for (const material of [undefined, new PbrMaterial()]) {
    const h = optionalGPU();
    h.engine.lighting = { direction: new Float32Array([0, 1, 0, 1]), radiance: new Float32Array([1, 1, 1, 0.1]) };
    h.context.shader = wgsl;
    const scatter = new Scatter(box(), { count: 1, material }),
      original = h.context.descriptor,
      originalDepth = h.context.depth;
    const depth = h.engine.gpu.createTexture({
      size: [h.context.width, h.context.height],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    try {
      h.engine.use(scatter);
      h.engine.frameGraph.execute(h.context);
      const pipelines = h.pipelines.length;
      h.context.depth = depth.createView();
      h.context.descriptor = { ...original, depthStencil: { ...original.depthStencil, format: depth.format } };
      h.engine.frameGraph.execute(h.context);
      assert.equal(h.pipelines.length, pipelines + 1, 'Changed depth format must compile one compatible pipeline');
      assert.equal(h.pipelines.at(-1).depthStencil.format, depth.format);
      h.engine.frameGraph.execute(h.context);
      assert.equal(h.pipelines.length, pipelines + 1);
      h.context.descriptor = original;
      h.context.depth = originalDepth;
      h.engine.frameGraph.execute(h.context);
      assert.equal(h.pipelines.length, pipelines + 1, 'Returning to a known format reuses its pipeline');
    } finally {
      scatter.dispose();
      depth.destroy();
      assert.ok(h.resources.every((resource) => resource.destroyed));
    }
  }
});
