import test from 'node:test';
import assert from 'node:assert/strict';
import { GPURenderer } from '../packages/core/dist/renderer.js';
import { FrameGraph } from '../packages/core/dist/plugin.js';
import { Camera } from '../packages/core/dist/camera.js';
import { Engine, TransformStore, box } from '../packages/core/dist/extension.js';

globalThis.GPUBufferUsage = {
  COPY_DST: 8,
  COPY_SRC: 4,
  MAP_READ: 1,
  INDEX: 16,
  VERTEX: 32,
  UNIFORM: 64,
  STORAGE: 128,
  INDIRECT: 256,
};
globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 16, COPY_SRC: 1 };
globalThis.GPUMapMode = { READ: 1 };

function fakeRenderer() {
  const calls = [],
    pass = {
      setPipeline() {},
      setBindGroup() {},
      setIndexBuffer() {},
      setViewport() {},
      setScissorRect() {},
      end() {},
      setVertexBuffer: (slot, buffer) => calls.push(['vertex', slot, buffer]),
      drawIndexed: (indices, count) => calls.push(['draw', indices, count]),
      drawIndexedIndirect: (buffer) => calls.push(['indirect', buffer]),
    },
    pipeline = { getBindGroupLayout: () => ({}) },
    device = {
      createShaderModule: () => ({}),
      createRenderPipeline: () => pipeline,
      createBindGroup: () => ({}),
      createTexture: () => ({ createView: () => ({}), destroy() {} }),
      createBuffer: (d) => ({
        ...d,
        destroy() {},
        async mapAsync() {},
        getMappedRange: () => new Uint32Array([7]).buffer,
        unmap() {},
      }),
      lost: new Promise(() => {}),
      addEventListener() {},
      destroy() {},
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
  return { calls, renderer };
}

test('a claimed batch is neither bound nor drawn by core draws, while pick passes still draw it', async () => {
  const { calls, renderer } = fakeRenderer(),
    claimed = box(),
    drawn = box(2),
    batches = [claimed, drawn].map((g) => ({ geometry: g, instances: new Float32Array(48), count: 2, mask: 1 }));
  for (const b of batches) renderer.add(b.geometry, 2);
  batches[0].claimed = true;
  const light = { direction: new Float32Array([0, 1, 0, 1]), radiance: new Float32Array(4) },
    graph = new FrameGraph();
  graph.add({ name: 'second-draw', order: 1, execute: (c) => c.draw({ clear: false }) });
  renderer.render(new Camera(), light, batches, graph, 0);
  assert.deepEqual(
    calls.filter((c) => c[0] === 'draw'),
    [
      ['draw', drawn.indices.length, 2],
      ['draw', drawn.indices.length, 2],
    ],
    'main and second draw encode only the unclaimed batch',
  );
  assert.equal(calls.filter((c) => c[0] === 'vertex').length, 4, 'the claimed batch binds no buffers');
  calls.length = 0;
  assert.equal(await renderer.pick(new Camera(), light, batches, new FrameGraph(), 1, 1), 7);
  assert.deepEqual(
    calls.filter((c) => c[0] === 'draw'),
    [
      ['draw', claimed.indices.length, 2],
      ['draw', drawn.indices.length, 2],
    ],
    'the pick pass draws the claimed batch as well',
  );
  calls.length = 0;
  batches[0].claimed = false;
  renderer.render(new Camera(), light, batches, new FrameGraph(), 0);
  assert.equal(calls.filter((c) => c[0] === 'draw').length, 2, 'clearing claimed draws the batch again');
  renderer.dispose(false);
});

test('engine.stats.drawCalls leaves claimed batches out on the frame after a claim, without a new collection', async () => {
  let live = [];
  const engine = new Engine(
    { width: 8, height: 8, clientWidth: 8, clientHeight: 8 },
    await TransformStore.create(8),
    {
      backend: 'webgl2',
      add() {},
      remove() {},
      dispose() {},
      render(_camera, _lighting, batches) {
        live = [...batches];
      },
    },
    undefined,
    null,
  );
  try {
    const a = engine.createMesh().setGeometry(box()),
      b = engine.createMesh().setGeometry(box(2));
    assert.ok(a && b);
    engine.render();
    assert.equal(engine.stats.drawCalls, 2);
    live[0].claimed = true;
    engine.render();
    assert.equal(engine.stats.drawCalls, 1, 'a claim made during the previous frame is not counted');
    live[0].claimed = false;
    engine.render();
    assert.equal(engine.stats.drawCalls, 2, 'a released batch is counted again');
  } finally {
    engine.dispose();
  }
});
