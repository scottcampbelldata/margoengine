// engine.stats.visible counts a model's nodes once a frame, however many frames have run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { PBRDrawRun, parseGLTF } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices = new Uint16Array([0, 1, 2, 0]);

function twoNodes(meshOfSecond) {
  const data = new Uint8Array(44);
  data.set(new Uint8Array(positions.buffer), 0);
  data.set(new Uint8Array(indices.buffer), 36);
  const primitive = (material) => ({ attributes: { POSITION: 0 }, indices: 1, material });
  return {
    doc: {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0, 1] }],
      nodes: [
        { mesh: 0, translation: [-1, 0, 0] },
        { mesh: meshOfSecond, translation: [1, 0, 0] },
      ],
      meshes: [{ primitives: [primitive(0)] }, { primitives: [primitive(1)] }],
      materials: [{}, { pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 6 },
      ],
      buffers: [{ byteLength: 44 }],
    },
    buffers: [data],
  };
}

async function setup(meshOfSecond) {
  const h = optionalGPU(),
    store = await TransformStore.create(16),
    engine = new Engine(
      { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
      store,
      { backend: 'webgpu', gpu: h.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 5], target: [0, 0, 0] },
      null,
    ),
    fixture = twoNodes(meshOfSecond),
    model = parseGLTF(engine, fixture.doc, fixture.buffers);
  engine.camera.update(1, true);
  store.tick(false);
  // Each frame has its own encoder, as the renderer gives it.
  const context = (batches = []) => ({
    ...h.context,
    camera: engine.camera,
    batches,
    encoder: Object.create(h.context.encoder),
  });
  return { engine, model, context };
}

for (const [name, mesh] of [
  ['two meshes', 1],
  ['one mesh shared by both', 0],
]) {
  test(`a two node model with ${name} reads 2 on every frame`, async () => {
    const { engine, model, context } = await setup(mesh);
    for (let frame = 1; frame <= 4; frame++) {
      const c = context();
      model.draw(c, 'beauty', c.color, c.depth);
      assert.equal(engine.stats.visible, 2, `frame ${frame}`);
    }
  });

  test(`a two node model with ${name} reads 2 on every frame of a draw run`, async () => {
    const { engine, model, context } = await setup(mesh),
      run = new PBRDrawRun();
    for (let frame = 1; frame <= 4; frame++) {
      const c = context();
      model.draw(c, 'beauty', c.color, c.depth, 'all', undefined, run);
      run.end();
      assert.equal(engine.stats.visible, 2, `frame ${frame}`);
    }
  });
}

test('the meshes core collected stay in the count, and two draws of one frame add up', async () => {
  const { engine, model, context } = await setup(1),
    c = context([{ count: 3 }, { count: 2 }]);
  model.draw(c, 'beauty', c.color, c.depth);
  assert.equal(engine.stats.visible, 7);
  model.draw(c, 'beauty', c.color, c.depth);
  assert.equal(engine.stats.visible, 9, 'the same frame');
  const next = context([{ count: 3 }, { count: 2 }]);
  model.draw(next, 'beauty', next.color, next.depth);
  assert.equal(engine.stats.visible, 7, 'the next frame starts again');
});
