// Core writes WebGPU usage flags as their numbers, so the minifier folds each combination into one
// constant. This test runs the real GPURenderer on a fake device with no WebGPU flag namespaces defined (Node has none),
// records every usage core asks for, and compares each with the flags named by the WebGPU specification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GPURenderer } from '../packages/core/dist/renderer.js';
import { FrameGraph } from '../packages/core/dist/plugin.js';
import { Camera } from '../packages/core/dist/camera.js';
import { box } from '../packages/core/dist/geometry.js';

// The values the WebGPU specification gives each flag (GPUBufferUsage, GPUTextureUsage, GPUMapMode).
const Buffer = {
    MAP_READ: 1,
    COPY_SRC: 4,
    COPY_DST: 8,
    INDEX: 16,
    VERTEX: 32,
    UNIFORM: 64,
    STORAGE: 128,
    INDIRECT: 256,
  },
  Texture = { COPY_SRC: 1, RENDER_ATTACHMENT: 16 },
  MapMode = { READ: 1 };

function recordingRenderer() {
  const buffers = [],
    textures = [],
    maps = [],
    pass = new Proxy({}, { get: () => () => {} }),
    pipeline = { getBindGroupLayout: () => ({}) },
    device = {
      createShaderModule: () => ({}),
      createRenderPipeline: () => pipeline,
      createBindGroup: () => ({}),
      createTexture(d) {
        textures.push([d.format, d.usage]);
        return { createView: () => ({}), destroy() {} };
      },
      createBuffer(d) {
        buffers.push([d.size, d.usage]);
        return {
          destroy() {},
          async mapAsync(mode) {
            maps.push(mode);
          },
          getMappedRange: () => new Uint32Array([4]).buffer, // ids are written one up: mesh 3
          unmap() {},
        };
      },
      lost: new Promise(() => {}),
      addEventListener() {},
      destroy() {},
      features: new Set(),
      limits: { maxBufferSize: 1 << 30 },
      queue: { writeBuffer() {}, submit() {} },
      createCommandEncoder: () => ({ finish: () => ({}), beginRenderPass: () => pass, copyTextureToBuffer() {} }),
    },
    renderer = new GPURenderer(
      { width: 4, height: 4 },
      device,
      { configure() {}, unconfigure() {}, getCurrentTexture: () => ({ createView: () => ({}) }) },
      'bgra8unorm',
      pipeline,
      { multisample: { count: 4 }, depthStencil: { format: 'depth32float' }, vertex: {}, fragment: {} },
      pipeline,
    );
  return { buffers, textures, maps, renderer };
}

test('every buffer, texture and map usage core asks for is the one the WebGPU flags name', async () => {
  assert.equal(globalThis.GPUBufferUsage, undefined, 'the flag namespaces stay undefined here');
  const { buffers, textures, maps, renderer } = recordingRenderer(),
    geometry = box(),
    batch = { geometry, instances: new Float32Array(48), count: 2, mask: 1 },
    light = { direction: new Float32Array([0, 1, 0, 1]), radiance: new Float32Array(4) };
  assert.deepEqual(buffers, [[128, Buffer.UNIFORM | Buffer.COPY_DST]], 'the frame uniform');

  buffers.length = 0;
  renderer.add(geometry, 2);
  assert.deepEqual(
    buffers,
    [
      [geometry.vertices.byteLength, Buffer.VERTEX | Buffer.STORAGE | Buffer.COPY_DST],
      [geometry.indices.byteLength, Buffer.INDEX | Buffer.STORAGE | Buffer.COPY_DST],
      [192, Buffer.VERTEX | Buffer.STORAGE | Buffer.COPY_DST],
    ],
    'vertex, index and instance buffers',
  );

  buffers.length = 0;
  const graph = new FrameGraph();
  graph.add({ name: 'indirect-draw', order: 1, execute: (c) => c.draw({ clear: false, indirect: true }) });
  renderer.render(new Camera(), light, [batch], graph, 0);
  assert.deepEqual(buffers, [[20, Buffer.INDIRECT | Buffer.COPY_DST]], 'the indirect arguments');
  assert.deepEqual(
    textures,
    [
      ['bgra8unorm', Texture.RENDER_ATTACHMENT],
      ['depth32float', Texture.RENDER_ATTACHMENT],
    ],
    'the 4x colour and the depth attachment',
  );

  buffers.length = 0;
  textures.length = 0;
  assert.equal(await renderer.pick(new Camera(), light, [batch], new FrameGraph(), 1, 1), 3);
  assert.deepEqual(
    textures,
    [
      ['r32uint', Texture.RENDER_ATTACHMENT | Texture.COPY_SRC],
      ['depth32float', Texture.RENDER_ATTACHMENT],
    ],
    'the pick id and depth targets',
  );
  assert.deepEqual(
    buffers,
    [
      [4, Buffer.COPY_DST | Buffer.MAP_READ],
      [128, Buffer.UNIFORM | Buffer.COPY_DST],
    ],
    'the pick readback and uniform',
  );
  assert.deepEqual(maps, [MapMode.READ], 'the readback maps for reading');
  renderer.dispose(false);
});
