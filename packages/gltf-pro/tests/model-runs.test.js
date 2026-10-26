// Models of one frame graph draw as one run, and copies of one asset share its packed arrays (speed matrix rows 12.5,
// 12.7: 100 morphed clones drew 100 render passes, and every clone repacked its vertices).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { PBRModel, parseGLTF } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

async function fixture(t) {
  const gpu = optionalGPU(),
    device = gpu.engine.gpu,
    store = await TransformStore.create(64),
    engine = new Engine(
      { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
      store,
      { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    ),
    buffers = [
      new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      new Uint32Array([0, 1, 2, 0, 2, 3]),
    ],
    doc = {
      asset: { version: '2.0' },
      buffers: buffers.map((data) => ({ byteLength: data.byteLength })),
      bufferViews: buffers.map((data, buffer) => ({ buffer, byteLength: data.byteLength })),
      accessors: [
        { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3' },
        { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
        { bufferView: 2, componentType: 5125, count: 6, type: 'SCALAR' },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
      // Blended, so a model drawn on its own would end its pass around the draw: only a shared run keeps one pass.
      materials: [{ alphaMode: 'BLEND' }],
      nodes: [{ mesh: 0 }],
    },
    context = { ...gpu.context, camera: engine.camera },
    passes = [];
  context.encoder.beginRenderPass = () => {
    const pass = { draws: 0 }; // instances drawn: a run may draw both models as one instanced draw
    passes.push(pass);
    return {
      setPipeline() {},
      setBindGroup() {},
      setVertexBuffer() {},
      setIndexBuffer() {},
      setViewport() {},
      setScissorRect() {},
      setStencilReference() {},
      drawIndexed(count, instances = 1) {
        pass.draws += instances;
      },
      end() {},
    };
  };
  t.after(() => {
    engine.dispose();
    gpu.cleanup();
  });
  store.tick(false);
  engine.camera.update(128 / 96, true);
  const frame = () => {
    passes.length = 0;
    engine.frameGraph.execute(context);
    return passes.filter((p) => p.draws).map((p) => p.draws);
  };
  return { engine, doc, buffers, frame };
}

test('consecutive model passes draw as one run; a pass added between them keeps them apart', async (t) => {
  const f = await fixture(t),
    a = parseGLTF(f.engine, f.doc, f.buffers),
    b = new PBRModel(f.engine, a.asset, []),
    c = new PBRModel(f.engine, a.asset, []);
  if (f.engine.plugins.get(a.name) !== a) f.engine.use(a);
  f.engine.use(b);
  assert.deepEqual(f.frame(), [2], 'two models, one render pass');
  f.engine.frameGraph.add({ name: 'between', order: 1, execute() {} });
  f.engine.use(c);
  assert.deepEqual(f.frame(), [2, 1], 'the third draws after the foreign pass, on its own');
  b.dispose();
  assert.deepEqual(f.frame(), [1, 1], 'a lone model left of a run draws itself');
});

test('models of one asset share its packed vertex and index arrays', async (t) => {
  const f = await fixture(t),
    a = parseGLTF(f.engine, f.doc, f.buffers),
    b = new PBRModel(f.engine, a.asset, []);
  assert.equal(b.primitives[0].vertices, a.primitives[0].vertices);
  assert.equal(b.primitives[0].indices, a.primitives[0].indices);
  const other = parseGLTF(f.engine, f.doc, f.buffers);
  assert.notEqual(other.primitives[0].vertices, a.primitives[0].vertices, 'another asset packs its own');
});
