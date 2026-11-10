// Meshes made with @margoengine/materials draw in one render pass, not one pass per mesh. A pass per mesh stored and
// reloaded the multisampled colour and depth 10,000 times a frame (168 ms of CPU for 10,000 unlit meshes; the numbers
// are in docs/whitepaper/perf-history.md entry 21). CPU recording only: the fake encoder counts passes and draws.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { PBRDrawRun, PBRModel, parseGLTF } from '../../gltf-pro/dist/index.js';
import { Material, createMesh, install } from '../dist/index.js';
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

test('transmission maps capture and dispose in their model Scene even when installed outside its setup', async () => {
  const w = await world();
  try {
    const first = createMesh(w.engine, triangle, new Material());
    const scene = w.engine.createScene('transmission');
    let second;
    scene.use({ name: 'setup-transmission', setup() { second = createMesh(w.engine, triangle, new Material()); } });
    for (const model of [first, second]) model.primitives[0].material.transmission = { factor: 0.5, volume: { thicknessFactor: 0.2 } };
    const a = install(first), b = install(second);
    assert.equal(w.engine.sceneOf(a), w.engine.scene);
    assert.equal(w.engine.sceneOf(b), scene);
    assert.notEqual(scene.plugins.get('materials:opaque-color'), w.engine.scene.plugins.get('materials:opaque-color'));
    second.dispose();
    assert.equal(scene.plugins.has(b.name), false);
    assert.equal(scene.plugins.has('materials:opaque-color'), false);
    assert.equal(w.engine.scene.plugins.has(a.name), true);
    assert.equal(w.engine.scene.plugins.has('materials:opaque-color'), true);
    first.dispose();
    assert.equal(w.engine.scene.plugins.has(a.name), false);
    assert.equal(w.engine.scene.plugins.has('materials:opaque-color'), false);
  } finally { w.destroy(); }
});

test('material queues belong to their Scene and disposal removes only that Scene model', async () => {
  const w = await world();
  try {
    const material = new Material({ color: '#ffffff' });
    const main = createMesh(w.engine, triangle, material);
    const scene = w.engine.createScene('maps');
    let other;
    scene.use({ name: 'setup-maps', setup() { other = createMesh(w.engine, triangle, material); } });
    w.store.tick(false);
    w.engine.frameGraph.execute(w.context);
    assert.equal(w.log.filter((entry) => entry.startsWith('draw')).length, 1, 'default Scene contains only its own mesh');
    w.log.length = 0;
    scene.frameGraph.execute(w.context);
    assert.equal(w.log.filter((entry) => entry.startsWith('draw')).length, 1, 'named Scene has its own material queue');
    other.dispose();
    assert.equal(scene.plugins.has(other.name), false, 'named Scene model plugin removed outside Scene scope');
    assert.equal(w.engine.scene.plugins.has(main.name), true);
    w.log.length = 0;
    scene.frameGraph.execute(w.context);
    assert.equal(w.log.filter((entry) => entry.startsWith('draw')).length, 0);
    w.engine.frameGraph.execute(w.context);
    assert.equal(w.log.filter((entry) => entry.startsWith('draw')).length, 1);
  } finally { w.destroy(); }
});

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

test('a blended mesh draws after the opaque meshes, in the same pass', async () => {
  const w = await world();
  try {
    const opaque = new Material({ color: [1, 0, 0] }),
      glass = new Material({ color: [0, 0, 1], transparent: true, opacity: 0.5 });
    createMesh(w.engine, triangle, opaque);
    createMesh(w.engine, triangle, glass);
    createMesh(w.engine, triangle, opaque);
    w.store.tick(false);
    w.engine.frameGraph.execute(w.context);
    // Both opaque meshes draw first (one instanced draw), then the blended mesh, all in one pass: a pass per blended
    // mesh stored and reloaded the multisampled colour and depth each time (2,000 blended meshes, 2,000 passes).
    assert.deepEqual(w.log, ['begin', 'draw0', 'draw0', 'call', 'draw0', 'call', 'end']);
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

test('a mesh that changes phase between frames, or during a frame, draws once and in its new phase', async () => {
  const w = await world();
  try {
    const order = [],
      materials = {},
      meshes = {};
    for (const name of ['a', 'b', 'c', 'd']) {
      materials[name] = new Material({ color: [1, 0, 0], opacity: 0.5 });
      const mesh = (meshes[name] = createMesh(w.engine, triangle, materials[name]));
      mesh.root.setPosition([0, 0, -'abcd'.indexOf(name)]);
      mesh.draw = function (...args) {
        order.push(name);
        return PBRModel.prototype.draw.apply(this, args);
      };
    }
    w.store.tick(false);
    const frame = () => {
      order.length = 0;
      w.engine.frameGraph.execute(w.context);
      return order.join('');
    };
    assert.equal(frame(), 'abcd');
    // Opaque to blended: it leaves the opaque phase and draws after it.
    materials.b.transparent = true;
    assert.equal(frame(), 'acdb');
    // Blended to opaque, and another to blended, in one frame: the opaque phase is in mesh order again.
    materials.b.transparent = false;
    materials.c.transparent = true;
    assert.equal(frame(), 'abdc');
    // The first and the last mesh of the opaque phase.
    materials.c.transparent = false;
    materials.a.transparent = true;
    materials.d.transparent = true;
    assert.equal(frame(), 'bcda');
    materials.a.transparent = false;
    materials.d.transparent = false;
    assert.equal(frame(), 'abcd');
    // Changed by a draw during the frame: the later mesh is not drawn as opaque, and still draws once.
    const draw = meshes.a.draw;
    meshes.a.draw = function (...args) {
      materials.c.transparent = true;
      return draw.apply(this, args);
    };
    assert.equal(frame(), 'abdc');
    meshes.a.draw = draw;
    assert.equal(frame(), 'abdc');
  } finally {
    w.destroy();
  }
});
