// engine.stats.visible counts a model's nodes once a frame, however many frames have run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { box, Engine, TransformStore } from '@margoengine/core/extension';
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
    frame = { draw() {} },
    engine = new Engine(
      { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
      store,
      {
        backend: 'webgpu',
        gpu: h.engine.gpu,
        add() {},
        remove() {},
        render: () => frame.draw(),
        dispose() {},
        geometryBuffers: () => ({
          vertex: h.engine.gpu.createBuffer({ size: 576 }),
          index: h.engine.gpu.createBuffer({ size: 144 }),
        }),
      },
      { position: [0, 0, 5], target: [0, 0, 0] },
      null,
    ),
    fixture = twoNodes(meshOfSecond),
    model = parseGLTF(engine, fixture.doc, fixture.buffers);
  // Each frame has its own encoder, as the renderer gives it.
  const context = () => ({ ...h.context, camera: engine.camera, encoder: Object.create(h.context.encoder) }),
    /** One frame of core's, with `draw` in it: core starts the counts, and the model adds to them. */
    render = (draw) => {
      frame.draw = draw;
      engine.render({ delta: 0 });
    };
  return { engine, model, context, render };
}

for (const [name, mesh] of [
  ['two meshes', 1],
  ['one mesh shared by both', 0],
]) {
  test(`a two node model with ${name} reads 2 on every frame`, async () => {
    const { engine, model, context, render } = await setup(mesh);
    for (let frame = 1; frame <= 4; frame++) {
      render(() => {
        const c = context();
        model.draw(c, 'beauty', c.color, c.depth);
      });
      assert.equal(engine.stats.visible, 2, `frame ${frame}`);
    }
  });

  test(`a two node model with ${name} reads 2 on every frame of a draw run`, async () => {
    const { engine, model, context, render } = await setup(mesh),
      run = new PBRDrawRun();
    for (let frame = 1; frame <= 4; frame++) {
      render(() => {
        const c = context();
        model.draw(c, 'beauty', c.color, c.depth, 'all', undefined, run);
        run.end();
      });
      assert.equal(engine.stats.visible, 2, `frame ${frame}`);
    }
  });
}

test('the meshes core collected stay in the count, and two draws of one frame add up', async () => {
  const { engine, model, context, render } = await setup(1);
  engine.createMesh().setGeometry(box());
  const twice = () => {
    const c = context();
    model.draw(c, 'beauty', c.color, c.depth);
    assert.equal(engine.stats.visible, 3);
    model.draw(c, 'beauty', c.color, c.depth);
    assert.equal(engine.stats.visible, 5, 'the same frame');
  };
  render(twice);
  render(twice);
  assert.equal(engine.stats.visible, 5, 'the next frame starts again');
});

// A probe bake draws models on an encoder of its own inside a frame. The count was keyed on the encoder, so the bake's first
// draw started the frame's number again and lost every mesh and model counted before it.
test('a draw on another encoder inside a frame adds to the count', async () => {
  const { engine, model, context, render } = await setup(1);
  render(() => {
    const frame = context(),
      bake = context();
    model.draw(frame, 'beauty', frame.color, frame.depth);
    model.draw(bake, 'beauty', bake.color, bake.depth);
    assert.equal(engine.stats.visible, 4);
    model.draw(frame, 'beauty', frame.color, frame.depth);
  });
  assert.equal(engine.stats.visible, 6);
});
