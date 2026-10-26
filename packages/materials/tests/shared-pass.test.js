// Meshes made with @margoengine/materials draw in one render pass, not one pass per mesh. A pass per mesh stored and
// reloaded the multisampled colour and depth 10,000 times a frame (168 ms of CPU for 10,000 unlit meshes; the numbers
// are in docs/whitepaper/perf-history.md entry 21). CPU recording only: the fake encoder counts passes and draws.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { PBRDrawRun, PBRModel, parseGLTF } from '../../gltf-pro/dist/index.js';
import { Material, createMesh } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { materialQuad } from '../../../tests/support/materials-fixture.js';

async function world() {
  const harness = optionalGPU(),
    store = await TransformStore.create(64),
    device = harness.engine.gpu;
  device.limits.maxTextureDimension2D = 8192;
  device.limits.maxUniformBufferBindingSize = 65536;
  device.queue.writeTexture = () => {};
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    store,
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  engine.camera.update(128 / 96, true);
  const log = [];
  const context = {
    ...harness.context,
    camera: engine.camera,
    draw() {},
    encoder: {
      beginRenderPass() {
        const id = log.filter((e) => e === 'begin').length;
        log.push('begin');
        return {
          setPipeline() {},
          setBindGroup() {},
          setVertexBuffer() {},
          setIndexBuffer() {},
          // One entry per mesh drawn: an instanced draw (draw-batch.ts) draws several meshes.
          drawIndexed(count, instances = 1) {
            for (let k = 0; k < instances; k++) log.push('draw' + id);
            log.push('call');
          },
          end() {
            log.push('end');
          },
        };
      },
    },
  };
  return { engine, store, context, log, destroy: () => engine.dispose() };
}
const triangle = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1] };

test('ten opaque materials meshes draw in one render pass', async () => {
  const w = await world();
  try {
    const material = new Material({ color: [1, 0, 0] });
    for (let i = 0; i < 10; i++) createMesh(w.engine, triangle, material).root.setPosition([i, 0, 0]);
    w.store.tick(false);
    w.engine.frameGraph.execute(w.context);
    assert.equal(w.log.filter((e) => e === 'begin').length, 1, 'one pass for all meshes');
    assert.equal(w.log.filter((e) => e.startsWith('draw')).length, 10);
    assert.equal(w.log.filter((e) => e === 'call').length, 1, 'one material and geometry: one instanced draw');
    assert.deepEqual(w.log.slice(-1), ['end'], 'the pass is ended before the frame is submitted');
    assert.equal(w.log.filter((e) => e === 'end').length, 1);
    // A second frame begins a new pass: nothing is carried across frames.
    w.engine.frameGraph.execute(w.context);
    assert.equal(w.log.filter((e) => e === 'begin').length, 2);
    assert.equal(w.log.filter((e) => e === 'end').length, 2);
  } finally {
    w.destroy();
  }
});

test('a blended mesh keeps its own pass between opaque meshes, in render order', async () => {
  const w = await world();
  try {
    const opaque = new Material({ color: [1, 0, 0] }),
      glass = new Material({ color: [0, 0, 1], transparent: true, opacity: 0.5 });
    createMesh(w.engine, triangle, opaque);
    createMesh(w.engine, triangle, glass);
    createMesh(w.engine, triangle, opaque);
    w.store.tick(false);
    w.engine.frameGraph.execute(w.context);
    // Both opaque meshes share the first pass (one instanced draw); the blended mesh follows in a pass of its own.
    assert.deepEqual(w.log, ['begin', 'draw0', 'draw0', 'call', 'end', 'begin', 'draw1', 'call', 'end']);
  } finally {
    w.destroy();
  }
});

test('a PBRDrawRun shares one pass across models and a draw without one keeps its own pass', async () => {
  const w = await world(),
    models = [];
  try {
    for (let i = 0; i < 3; i++) {
      const asset = materialQuad();
      models.push(parseGLTF(w.engine, asset.doc, asset.buffers));
    }
    w.store.tick(false);
    const run = new PBRDrawRun();
    for (const model of models)
      model.draw(w.context, 'beauty', w.context.color, w.context.depth, 'all', undefined, run);
    // The run's opaque draws wait for its end (they may join instanced batches); the pass stays open until then.
    assert.deepEqual(w.log, ['begin'], 'the run began its pass');
    run.end();
    run.end();
    assert.deepEqual(w.log, ['begin', 'draw0', 'call', 'draw0', 'call', 'draw0', 'call', 'end']);
    assert.equal(w.log.filter((e) => e === 'end').length, 1, 'ending a run twice ends the pass once');
    w.log.length = 0;
    for (const model of models) model.draw(w.context, 'beauty', w.context.color, w.context.depth);
    assert.equal(w.log.filter((e) => e === 'begin').length, 3, 'without a run each draw has its own pass');
    PBRModel.cancelOpaquePass(w.context);
  } finally {
    w.destroy();
  }
});

test('a reused run keeps its batch records for the next frame instead of allocating new ones', async () => {
  const w = await world();
  try {
    const material = new Material({ color: [1, 0, 0] }),
      meshes = Array.from({ length: 4 }, (_, i) => createMesh(w.engine, triangle, material));
    meshes.forEach((mesh, i) => mesh.root.setPosition([i, 0, 0]));
    w.store.tick(false);
    const run = new PBRDrawRun(),
      frame = () => {
        for (const mesh of meshes)
          mesh.draw(w.context, 'beauty', w.context.color, w.context.depth, 'all', undefined, run);
        const pending = [...run.pending];
        run.end();
        return pending;
      };
    frame();
    const [first] = frame();
    await null; // the next frame
    const [second] = frame();
    assert.ok(first, 'the meshes drew as one batch');
    assert.equal(second, first, 'the same batch record, emptied and reused');
    assert.equal(second.members.length, 0, 'emptied after the run drew it');
  } finally {
    w.destroy();
  }
});
