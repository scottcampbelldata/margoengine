import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { GLTFAsset, PBRModel } from '@margoengine/gltf-pro';
import { readMaterialLODs, MSFTMaterialLOD } from '@margoengine/lod/msft';

const doc = () => ({
  asset: { version: '2.0' },
  buffers: [{ byteLength: 36 }],
  bufferViews: [{ buffer: 0, byteLength: 36 }],
  accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 3 }],
  materials: [
    {
      pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] },
      extensions: { MSFT_lod: { ids: [1, 2] } },
      extras: { MSFT_screencoverage: [0.5, 0.2] },
    },
    { pbrMetallicRoughness: { baseColorFactor: [0, 1, 0, 1] } },
    { pbrMetallicRoughness: { baseColorFactor: [0, 0, 1, 1] } },
  ],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
  nodes: [{ mesh: 0 }, { mesh: 0, translation: [0, 0, -100] }],
  scenes: [{ nodes: [0, 1] }],
  scene: 0,
});
const fixture = async (edit = () => []) => {
  const e = new Engine(
    { width: 64, height: 64 },
    await TransformStore.create(64),
    { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
  );
  const definition = doc(),
    extra = edit(definition),
    data = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0, ...extra]);
  definition.buffers[0].byteLength = data.byteLength;
  const model = new PBRModel(e, new GLTFAsset(definition, [data]));
  return { e, model };
};
test('MSFT material ids and hints preserve file order and reject malformed chains atomically', () => {
  assert.deepEqual(readMaterialLODs(doc()), [{ material: 0, levels: [0, 1, 2], screenCoverage: [0.5, 0.2] }]);
  for (const ids of [[0], [1, 1], [8], [], [-1], [0.5]]) {
    const d = doc();
    d.materials[0].extensions.MSFT_lod.ids = ids;
    assert.throws(() => readMaterialLODs(d), TypeError);
  }
  const cycle = doc();
  cycle.materials[1].extensions = { MSFT_lod: { ids: [0] } };
  assert.throws(() => readMaterialLODs(cycle), /cycle/);
  const long = {
    materials: Array.from({ length: 20000 }, (_, i) =>
      i === 19999 ? {} : { extensions: { MSFT_lod: { ids: [i + 1] } } },
    ),
  };
  assert.equal(readMaterialLODs(long).length, 19999);
  for (const coverage of [[0.1, 0.5], [0], [2], ['0.5'], [0.9, 0.7, 0.5, 0.1]]) {
    const d = doc();
    d.materials[0].extras.MSFT_screencoverage = coverage;
    assert.throws(() => readMaterialLODs(d), TypeError);
  }
});

test('hysteresis holds a coarse material until the coverage leaves its band; orthographic zoom is depth independent', async () => {
  const { e, model } = await fixture();
  try {
    const controller = MSFTMaterialLOD.attach(e, model);
    controller.bias = 1.25;
    controller.update();
    assert.equal(controller.levels[0], 1);
    controller.bias = 1.2;
    controller.update();
    assert.equal(controller.levels[0], 1);
    controller.bias = 1.1;
    controller.update();
    assert.equal(controller.levels[0], 0);
    e.camera.matrix.fill(0);
    e.camera.matrix[0] = e.camera.matrix[5] = e.camera.matrix[10] = e.camera.matrix[15] = 1;
    controller.bias = 4;
    controller.update();
    assert.deepEqual(controller.levels, [1, 1]);
    e.camera.position = [0, 0, 10000];
    controller.update();
    assert.deepEqual(controller.levels, [1, 1]);
    assert.throws(() => new MSFTMaterialLOD(model, { bias: '1' }), RangeError);
    controller.dispose();
  } finally {
    e.dispose();
  }
});

test('lower material levels retain later UV sets and arbitrary material edits can prepare them lazily', async () => {
  for (const referenced of [true, false]) {
    const { e, model } = await fixture((d) => {
      d.bufferViews.push({ buffer: 0, byteOffset: 36, byteLength: 24 });
      d.accessors.push({ bufferView: 1, count: 3, type: 'VEC2', componentType: 5126 });
      d.meshes[0].primitives[0].attributes.TEXCOORD_2 = 1;
      d.textures = [{ source: 0 }];
      d.images = [{ uri: 'uv-test.png' }];
      const material = { pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 2 } } };
      if (referenced) d.materials[2] = material;
      else d.materials.push(material);
      return [0, 0, 1, 0, 0.5, 1];
    });
    try {
      const p = model.primitives[0],
        vertices = p.vertices;
      assert.equal(!!p.uvs, referenced);
      model.setPrimitiveMaterials([{ primitive: p, material: referenced ? 2 : 3 }]);
      assert.ok(p.uvs);
      assert.equal(p.uvs.length, 12);
      assert.equal(p.uvs[4], 1);
      assert.equal(p.uvs[8], 0.5);
      assert.equal(p.vertices, vertices);
      model.dispose();
      assert.throws(
        () => model.setPrimitiveMaterials([]),
        (e) => e.code === 'disposed',
      );
    } finally {
      e.dispose();
    }
  }
});
test('material quality is selected per primitive, reuses geometry and restores on dispose', async () => {
  const { e, model } = await fixture();
  try {
    const geometry = model.primitives.map((p) => p.vertices),
      originals = model.primitives.map((p) => p.material);
    const controller = MSFTMaterialLOD.attach(e, model, { hysteresis: 0 });
    controller.update();
    assert.deepEqual(controller.levels, [0, 2]);
    assert.deepEqual(Array.from(model.primitives[0].material.base), [1, 0, 0, 1]);
    assert.deepEqual(Array.from(model.primitives[1].material.base), [0, 0, 1, 1]);
    controller.bias = 2;
    controller.update();
    assert.deepEqual(controller.levels, [1, 2]);
    controller.bias = 100;
    controller.update();
    assert.deepEqual(controller.levels, [2, 2]);
    model.primitives.forEach((p, i) => assert.equal(p.vertices, geometry[i]));
    controller.dispose();
    assert.deepEqual(
      model.primitives.map((p) => p.material),
      originals,
    );
    assert.doesNotThrow(() => controller.onPreUpdate());
    assert.throws(
      () => controller.update(),
      (e) => e.code === 'disposed',
    );
  } finally {
    e.dispose();
  }
});
test('material edits validate ownership and all indices before changing any primitive', async () => {
  const { e, model } = await fixture();
  try {
    const [a, b] = model.primitives,
      old = a.material;
    assert.throws(
      () =>
        model.setPrimitiveMaterials([
          { primitive: a, material: 1 },
          { primitive: b, material: 9 },
        ]),
      RangeError,
    );
    assert.equal(a.material, old);
    assert.throws(
      () =>
        model.setPrimitiveMaterials([
          { primitive: a, material: 1 },
          { primitive: a, material: 2 },
        ]),
      RangeError,
    );
    assert.throws(() => model.setPrimitiveMaterials([{ primitive: { ...a }, material: 1 }]), RangeError);
    model.setPrimitiveMaterials([{ primitive: a, material: 1 }]);
    assert.deepEqual(Array.from(a.material.base), [0, 1, 0, 1]);
    model.setPrimitiveMaterials([{ primitive: a, material: undefined }]);
    assert.equal(a.material, old);
  } finally {
    e.dispose();
  }
});
