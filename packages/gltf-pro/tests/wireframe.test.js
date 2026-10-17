import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { parseGLTF } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { meshTriangles } from '../../shared/mesh-source.js';

async function fixture(t, { mode = 4, parts = false } = {}) {
  const gpu = optionalGPU(),
    device = gpu.engine.gpu,
    store = await TransformStore.create(32),
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
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0, mode }] }],
      materials: [{ doubleSided: true }],
      nodes: parts ? [{ mesh: 0 }, { mesh: 0, translation: [3, 0, 0], scale: [-1, 1, 1] }] : [{ mesh: 0 }],
    },
    model = parseGLTF(engine, doc, buffers),
    context = { ...gpu.context, camera: engine.camera },
    draws = [];
  const pass = () => {
    let pipeline, index, vertex;
    return {
      setPipeline(value) {
        pipeline = value;
      },
      setBindGroup() {},
      setVertexBuffer(slot, value) {
        if (slot === 0) vertex = value;
      },
      setIndexBuffer(value) {
        index = value;
      },
      drawIndexed(count, instances) {
        draws.push({ pipeline, index, vertex, count, instances });
      },
      end() {},
    };
  };
  context.encoder.beginRenderPass = pass;
  let renderer;
  t.after(() => {
    renderer?.dispose();
    engine.dispose();
    gpu.cleanup();
  });
  store.tick(false);
  engine.camera.update(128 / 96, true);
  return {
    ...gpu,
    model,
    device,
    engine,
    context,
    primitive: [...model.primitives, ...model.pointsAndLines][0],
    frame(mode = 'beauty') {
      draws.length = 0;
      model.draw(context, mode, context.color, context.depth);
      return draws;
    },
    forward() {
      renderer ??= model.createRenderer(device);
      draws.length = 0;
      renderer.prepare(context);
      renderer.draw(context, pass(), engine.camera.matrix);
      return draws;
    },
  };
}

const edges = [0, 1, 1, 2, 2, 0, 0, 2, 2, 3, 3, 0];

test('live wireframe preserves triangle query data and reuses edge buffers and pipelines across toggles', async (t) => {
  const f = await fixture(t),
    p = f.primitive,
    original = f.frame()[0];
  const buffers = f.counts.buffers;
  p.material.wireframe = true;
  const line = f.frame()[0];
  assert.equal(line.pipeline.primitive.topology, 'line-list');
  assert.equal(line.count, 12);
  assert.deepEqual([...new Uint32Array(line.index.data)], edges);
  assert.equal(f.counts.buffers, buffers + 1);
  assert.deepEqual([...p.indices], [0, 1, 2, 0, 2, 3]);
  assert.equal(p.buffers.index, original.index);
  assert.equal(f.model.pickingPrimitives[0].index, original.index);
  assert.equal(f.model.pickingPrimitives[0].count, 6);
  assert.deepEqual([...(await f.model.readPickingGeometry())[0].indices], [0, 1, 2, 0, 2, 3]);
  p.material.wireframe = false;
  assert.equal(f.frame()[0].pipeline, original.pipeline);
  assert.equal(f.frame()[0].index, original.index);
  p.material.wireframe = true;
  assert.equal(f.frame()[0].pipeline, line.pipeline);
  assert.equal(f.frame()[0].index, line.index);
  assert.equal(f.counts.buffers, buffers + 1);
});

test('wireframe auxiliary passes and forward device views use lines without polygon bias or face rejection', async (t) => {
  const f = await fixture(t),
    p = f.primitive;
  p.material.wireframe = true;
  p.material.side = 'back';
  p.material.renderState = { depthBias: 2, depthBiasSlopeScale: 3 };
  for (const mode of ['beauty', 'gbuffer', 'ambient', 'occlusion']) {
    const draw = f.frame(mode)[0];
    assert.equal(draw.pipeline.primitive.topology, 'line-list', mode);
    assert.equal(draw.pipeline.depthStencil.depthBias ?? 0, 0, mode);
    assert.equal(draw.pipeline.depthStencil.depthBiasSlopeScale ?? 0, 0, mode);
    assert.equal(draw.pipeline.fragment.constants?.margoFaceTest ?? 0, 0, mode);
    assert.equal(draw.count, 12, mode);
  }
  assert.equal(f.forward()[0].pipeline.primitive.topology, 'line-list');
  assert.equal(f.forward()[0].count, 12);
});

test('shadow records can request wireframe before beauty, keep deformed vertices, and delete optional topology on reset', async (t) => {
  const f = await fixture(t),
    p = f.primitive,
    original = p.buffers.index;
  p.material.wireframe = true;
  const deformed = f.device.createBuffer({ size: p.vertices.byteLength, usage: GPUBufferUsage.VERTEX });
  p.deformed = deformed;
  const shadow = f.model.shadowPrimitives[0];
  assert.equal(shadow.topology, 'line-list');
  assert.deepEqual([...new Uint32Array(shadow.index.data)], edges);
  assert.equal(shadow.count, 12);
  assert.equal(shadow.vertex, deformed);
  assert.equal(f.frame()[0].index, shadow.index);
  assert.equal(f.frame()[0].vertex, deformed);
  assert.equal(meshTriangles(p.node).source.shadowPrimitives[0].index, shadow.index);
  p.material.wireframe = false;
  assert.equal(Object.hasOwn(f.model.shadowPrimitives[0], 'topology'), false);
  assert.equal(f.model.shadowPrimitives[0].index, original);
  deformed.destroy();
});

test('wireframe static batches retain duplicate triangle edges including mirrored parts', async (t) => {
  const f = await fixture(t, { parts: true });
  f.primitive.material.wireframe = true;
  const draws = f.frame();
  assert.equal(draws.length, 1);
  assert.equal(draws[0].count, 24);
  assert.equal(f.model.shadowPrimitives[0].count, 24);
  assert.equal(meshTriangles(f.primitive.node).source.shadowPrimitives[0].count, 12);
  assert.equal(f.model.pickingPrimitives.length, 2);
});

test('wireframe buffers are released on device restoration and disposal', async (t) => {
  const f = await fixture(t);
  f.primitive.material.wireframe = true;
  const first = f.frame()[0].index;
  f.model.onDeviceRestored(f.engine);
  assert.equal(first.destroyed, true);
  const next = f.frame()[0].index;
  assert.notEqual(next, first);
  assert.deepEqual([...new Uint32Array(next.data)], edges);
  f.model.dispose();
  assert.equal(next.destroyed, true);
});

test('native points and lines retain their indices when wireframe is enabled', async (t) => {
  for (const mode of [0, 1]) {
    const f = await fixture(t, { mode }),
      original = f.frame()[0];
    f.primitive.material.wireframe = true;
    const next = f.frame()[0];
    assert.equal(next.pipeline, original.pipeline);
    assert.equal(next.index, original.index);
    assert.equal(next.count, original.count);
  }
});

test('invalid live wireframe flags report the boolean fix', async (t) => {
  const f = await fixture(t);
  for (const value of [null, 1, 'true', {}]) {
    f.primitive.material.wireframe = value;
    assert.throws(() => f.frame(), { name: 'TypeError', message: /wireframe.*boolean/i });
  }
});
