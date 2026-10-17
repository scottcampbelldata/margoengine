import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { Material, createMesh, createInstancedMesh } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const triangle = {
  positions: [-1, -1, 0, 1, -1, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
};
const grouped = {
  positions: [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
  groups: [
    { start: 0, count: 3, materialIndex: 1 },
    { start: 3, count: 3, materialIndex: 0 },
  ],
};

async function scene() {
  const h = optionalGPU(),
    engine = new Engine(
      { width: 64, height: 64 },
      await TransformStore.create(32),
      { backend: 'webgpu', gpu: h.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    );
  return {
    engine,
    close() {
      engine.dispose();
      h.cleanup();
    },
  };
}

test('Material wireframe defaults off and snapshots the constructor option', () => {
  assert.equal(new Material().wireframe, false);
  assert.equal(new Material({ wireframe: undefined }).wireframe, false);
  assert.equal(new Material({ wireframe: false }).wireframe, false);
  const options = { wireframe: true },
    material = new Material(options);
  options.wireframe = false;
  assert.equal(material.wireframe, true);
});

test('Material wireframe rejects nonboolean values with the subject and fix', () => {
  for (const wireframe of [null, 'true', '', 0, 1, {}, []])
    assert.throws(() => new Material({ wireframe }), {
      name: 'TypeError',
      message: /Material wireframe.*; set true or false/,
    });
});

test('wireframe forwards topology without opting opaque or transmissive materials into custom render state', async () => {
  const s = await scene();
  try {
    for (const options of [{}, { wireframe: false }, { wireframe: true }, { wireframe: true, transmission: 1 }]) {
      const material = new Material(options),
        mesh = createMesh(s.engine, triangle, material),
        primitive = mesh.primitives[0];
      assert.equal(primitive.material.wireframe, options.wireframe ?? false);
      assert.equal(material.customState, false);
      assert.equal(primitive.material.renderState, undefined);
      assert.deepEqual([...primitive.indices], [0, 1, 2]);
      mesh.dispose();
    }
  } finally {
    s.close();
  }
});

test('group and instanced meshes forward each selected material while retaining their triangle geometry', async () => {
  const s = await scene();
  try {
    const materials = [new Material(), new Material({ wireframe: true })];
    for (const mesh of [
      createMesh(s.engine, grouped, materials),
      createInstancedMesh(s.engine, grouped, materials, 2),
    ]) {
      assert.deepEqual(
        mesh.primitives.map((primitive) => primitive.material.wireframe),
        [true, false],
      );
      assert.deepEqual(
        mesh.primitives.map((primitive) => [...primitive.indices]),
        [
          [0, 1, 2],
          [0, 2, 3],
        ],
      );
      assert.ok(mesh.primitives.every((primitive) => primitive.material.renderState === undefined));
      if (mesh.instances) assert.ok(mesh.primitives.every((primitive) => primitive.instances === mesh.instances));
      mesh.dispose();
    }
    assert.deepEqual(grouped.indices, [0, 1, 2, 0, 2, 3]);
  } finally {
    s.close();
  }
});
