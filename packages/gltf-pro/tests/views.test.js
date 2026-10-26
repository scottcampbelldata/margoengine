// Multi-view drawing: one model drawn several times in one frame (two views, a probe face, a nested draw) keeps each
// draw's own uniforms, resources released mid-frame stay valid until submit, and a view draws only its layers.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { parseGLTF } from '../dist/index.js';
import { strictGPU } from '../../../tests/support/owned-command-recorder.js';
import { setRenderLayers } from '../../cameras/dist/layers.js';

const positions = new Float32Array([-0.4, -0.4, 0, 0.4, -0.4, 0, 0, 0.4, 0]);
const doc = {
  asset: { version: '2.0' },
  buffers: [{ byteLength: positions.byteLength }],
  bufferViews: [{ buffer: 0, byteLength: positions.byteLength }],
  accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
  materials: [{}, { pbrMetallicRoughness: { baseColorFactor: [0.5, 1, 1, 1] } }],
  meshes: [
    { primitives: [{ attributes: { POSITION: 0 }, material: 0 }] },
    { primitives: [{ attributes: { POSITION: 0 }, material: 1 }] },
  ],
  nodes: [
    { mesh: 0, translation: [-0.8, 0, 0] },
    { mesh: 1, translation: [0.8, 0, 0] },
  ],
};
const camera = (x) => ({
  matrix: Float32Array.from({ length: 16 }, (_, i) => (i % 5 === 0 ? 1 : 0) + (i === 12 ? x : 0)),
  position: [x, 0, 4],
  target: [x, 0, 0],
});

async function scene(t, { batch = false } = {}) {
  const gpu = strictGPU(),
    engine = new Engine(
      { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
      await TransformStore.create(64),
      { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    );
  t.after(() => engine.dispose());
  const model = parseGLTF(
      engine,
      batch ? { ...doc, materials: [{}, {}], meshes: [doc.meshes[0], doc.meshes[0]] } : doc,
      [positions],
    ),
    texture = (format) => gpu.device.createTexture({ size: [64, 64], format }).createView(),
    c = {
      backend: 'webgpu',
      device: gpu.device,
      encoder: gpu.device.createCommandEncoder(),
      color: texture('rgba16float'),
      depth: texture('depth32float'),
      format: 'rgba16float',
      width: 64,
      height: 64,
      camera: camera(0),
      descriptor: { depthStencil: { format: 'depth32float' }, multisample: { count: 1 } },
    };
  engine.store.tick(false);
  const draw = () => {
      model.draw(c, 'beauty', c.color, c.depth);
      gpu.settle(); // the uniforms uploaded when draw() returned
    },
    submit = () => gpu.device.queue.submit([c.encoder.finish()]);
  return { gpu, model, c, draw, submit };
}

test('two views of one model in one frame keep their own camera at submit', async (t) => {
  const { gpu, c, draw, submit } = await scene(t);
  c.view = { id: 'left', viewport: [0, 0, 32, 64], index: 0 };
  draw();
  c.view = { id: 'right', viewport: [32, 0, 32, 64], index: 1 };
  c.camera = camera(3);
  draw();
  submit();
  assert.equal(gpu.rows.length, 4);
  for (const row of gpu.rows) assert.deepEqual(row.submitted, row.encoded);
  assert.deepEqual(
    gpu.rows.map((row) => row.submitted[12]),
    [0, 0, 3, 3],
  );
});

test('a callback that moves the camera mid-draw does not change later primitives of that draw', async (t) => {
  const { gpu, model, c, draw, submit } = await scene(t);
  let moved = false;
  model.addLighting({
    shader(code) {
      if (!moved) c.camera.matrix[12] = 5;
      moved = true;
      return code;
    },
    bindings: () => [],
  });
  draw();
  submit();
  assert.ok(moved);
  assert.deepEqual(
    gpu.rows.map((row) => row.submitted[12]),
    [0, 0],
  );
});

test('a callback that disposes its model mid-draw keeps the encoded buffers until the frame closes', async (t) => {
  const { gpu, model, draw, submit } = await scene(t);
  let calls = 0;
  model.addLighting({
    shader(code) {
      if (++calls === 2) model.dispose();
      return code;
    },
    bindings: () => [],
  });
  draw();
  submit();
  assert.equal(gpu.rows.length, 1, 'the second primitive is not drawn from a disposed model');
  const arena = gpu.rows[0].uniform.buffer;
  assert.equal(arena.destroyed, false);
  await null;
  assert.equal(arena.destroyed, true, 'the arena goes back to the device with its last slot');
});

test('a view draws only the nodes in its layers; a static batch falls back to its matching parts', async (t) => {
  const { gpu, model, c, draw } = await scene(t, { batch: true });
  const batch = model['resources'].find((r) => r.batch);
  assert.ok(batch, 'same-material static nodes form one batch');
  draw();
  assert.deepEqual(
    gpu.rows.map((row) => row.count),
    [6],
    'one batched draw without a view',
  );
  setRenderLayers(model.nodes[1], 2);
  c.view = { id: 'side', viewport: [0, 0, 64, 64], index: 0, layers: 2 };
  gpu.rows.length = 0;
  draw();
  assert.deepEqual(
    gpu.rows.map((row) => row.count),
    [3],
    'only the layer-2 part, drawn alone',
  );
  c.view.layers = 4;
  gpu.rows.length = 0;
  draw();
  assert.equal(gpu.rows.length, 0);
});

test('a dispose from a later pass of a multi-view frame keeps the encoded buffers until the frame closes', async (t) => {
  const { gpu, model, c, draw, submit } = await scene(t);
  c.view = { id: 'left', viewport: [0, 0, 32, 64], index: 0 };
  draw();
  c.view = { id: 'right', viewport: [32, 0, 32, 64], index: 1 };
  draw();
  model.dispose();
  submit();
  const arena = gpu.rows[0].uniform.buffer;
  assert.equal(arena.destroyed, false);
  await null;
  assert.equal(arena.destroyed, true, 'the arena goes back to the device with its last slot');
});
