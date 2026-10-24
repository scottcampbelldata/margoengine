import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { createPBRMeshes } from '../dist/render.js';
import { parseUSDA } from '../dist/index.js';

const triangle = () => ({
  kind: 'mesh',
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 9, 9, 9]),
  indices: new Uint32Array([2, 0, 1]),
  colors: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 0.5, 1, 1, 1]),
  attributes: { opacity: new Float32Array([0.25, 0.5, 0.75, 1]) },
});
async function fixture(t) {
  const gpu = optionalGPU(),
    store = await TransformStore.create(64);
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    store,
    { backend: 'webgpu', gpu: gpu.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  t.after(() => {
    engine.dispose();
    gpu.cleanup();
  });
  return { ...gpu, engine };
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
test('optional renderer preserves remapped per-vertex linear RGB and independent opacity without mutating input', async (t) => {
  const { engine } = await fixture(t),
    source = triangle(),
    before = structuredClone(source);
  source.groups = [{ start: 0, count: 3, color: [0.2, 0.3, 0.4, 0.1] }];
  const model = createPBRMeshes(engine, source, { baseColorFactor: [0.8, 0.7, 0.6, 0.5], unlit: true });
  const p = model.primitives[0],
    v = p.vertices;
  assert.equal(v.length, 60);
  near(v[18], 0.21404114);
  near(v[19], 0.75);
  assert.deepEqual(Array.from(v.slice(36, 40)), [1, 0, 0, 0.25]);
  assert.deepEqual(Array.from(v.slice(56, 60)), [0, 1, 0, 0.5]);
  assert.deepEqual(p.material.base, [0.8, 0.7, 0.6, 0.5]);
  assert.equal(p.material.alphaMode, 'BLEND');
  for (const name of ['positions', 'indices', 'colors', 'attributes']) assert.deepEqual(source[name], before[name]);
  model.dispose();
  model.dispose();
  assert.equal(model.disposed, true);
  assert.equal(engine.meshes.size, 0);
});
test('USDA indexed vertex primvars reach the optional renderer in linear RGBA', async (t) => {
  const { engine } = await fixture(t);
  const source = parseUSDA(`#usda 1.0
def Mesh "Color" {
 point3f[] points = [(0,0,0),(1,0,0),(0,1,0)]
 int[] faceVertexCounts = [3]
 int[] faceVertexIndices = [0,1,2]
 uniform token subdivisionScheme = "none"
 color3f[] primvars:displayColor = [(0.25,0.5,1),(1,0,0.5)] (interpolation = "vertex")
 int[] primvars:displayColor:indices = [1,0,1]
 float[] primvars:displayOpacity = [0.25,0.75] (interpolation = "vertex")
 int[] primvars:displayOpacity:indices = [0,1,0]
}`);
  const model = createPBRMeshes(engine, source),
    vertices = model.primitives[0].vertices;
  for (const [i, expected] of [
    [1, 0, 0.5, 0.25],
    [0.25, 0.5, 1, 0.75],
    [1, 0, 0.5, 0.25],
  ].entries())
    expected.forEach((value, k) => near(vertices[i * 20 + 16 + k], value));
});
test('parent ownership remains external and a failed attachment rolls back the new model', async (t) => {
  const { engine } = await fixture(t),
    parent = engine.createMesh();
  const model = createPBRMeshes(engine, triangle(), { parent });
  parent.setScale([-1, 1, 1]);
  model.dispose();
  assert.equal(engine.meshes.size, 1);
  parent.check();
  parent.dispose();
  assert.throws(() => createPBRMeshes(engine, triangle(), { parent }));
  assert.equal(engine.meshes.size, 0);
});
test('group RGB and alpha fall back independently, gaps survive, flat normals retain corner colors', async (t) => {
  const { engine } = await fixture(t),
    source = triangle();
  source.indices = new Uint32Array([0, 1, 2, 2, 0, 1]);
  source.groups = [{ start: 3, count: 3, name: 'tinted', color: [0.5, 0.25, 1, 0.4] }];
  delete source.colors;
  const model = createPBRMeshes(engine, source, { normals: 'flat' });
  assert.equal(model.primitives.length, 2);
  assert.deepEqual(Array.from(model.primitives[0].vertices.slice(16, 20)), [1, 1, 1, 0.25]);
  near(model.primitives[1].vertices[16], 0.21404114);
  near(model.primitives[1].vertices[19], 0.75);
  delete source.attributes;
  const fallback = createPBRMeshes(engine, source);
  near(fallback.primitives[1].vertices[19], 0.4);
  assert.equal(fallback.primitives[0].material.alphaMode, 'OPAQUE');
  assert.equal(fallback.primitives[1].material.alphaMode, 'BLEND');
});
test('unsupported, malformed and budget-limited inputs refuse before creating engine meshes or GPU buffers', async (t) => {
  const { engine, resources } = await fixture(t),
    source = triangle();
  const initial = resources.length;
  for (const [input, options, code] of [
    [{ ...source, kind: 'points' }, {}, 'unsupported'],
    [source, { maxBytes: 251 }, 'limit'],
    [source, { maxBytes: 11 }, 'limit'],
    [{ ...source, colors: new Float32Array([1]) }, {}, 'range'],
    [{ ...source, attributes: { opacity: new Float32Array([0, 0, 2, 1]) } }, {}, 'range'],
    [
      {
        ...source,
        groups: [
          { start: 0, count: 3 },
          { start: 0, count: 3 },
        ],
      },
      {},
      'range',
    ],
    [source, { baseColorFactor: [1, 1, 1, 2] }, 'range'],
  ])
    assert.throws(
      () => createPBRMeshes(engine, input, options),
      (error) => error.code === code,
    );
  assert.equal(resources.length, initial);
  assert.equal(engine.meshes.size, 0);
});

test('reordered shared vertices and gapped groups match a complete independent layout reference in every normal mode', async (t) => {
  const { engine } = await fixture(t);
  const source = {
    kind: 'mesh',
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, -1, 0, 0, 0, 2, 0]),
    indices: new Uint32Array([4, 0, 2, 2, 0, 1, 2, 1, 3, 5, 2, 3]),
    normals: new Float32Array(Array.from({ length: 6 }, () => [0, 0, 7]).flat()),
    colors: new Float32Array(Array.from({ length: 18 }, (_, i) => (i + 1) / 20)),
    uvs: new Float32Array(Array.from({ length: 12 }, (_, i) => i / 12)),
    attributes: { opacity: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]) },
    groups: [{ start: 3, count: 6, color: [0.1, 0.2, 0.3, 0.4] }],
  };
  const before = structuredClone(source),
    ranges = [
      [0, 3],
      [3, 9],
      [9, 12],
    ];
  const linear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  for (const normals of ['auto', 'smooth', 'flat']) {
    const model = createPBRMeshes(engine, source, { normals });
    assert.equal(model.primitives.length, 3);
    for (const [part, [start, end]] of ranges.entries()) {
      const triangles = Array.from(source.indices.slice(start, end));
      const order = normals === 'flat' ? triangles : triangles.filter((v, i) => triangles.indexOf(v) === i);
      const expected = new Float32Array(
        order.flatMap((v) => [
          ...source.positions.slice(v * 3, v * 3 + 3),
          1,
          0,
          0,
          1,
          0,
          0,
          0,
          0,
          0,
          ...source.uvs.slice(v * 2, v * 2 + 2),
          0,
          0,
          ...Array.from(source.colors.slice(v * 3, v * 3 + 3), linear),
          source.attributes.opacity[v],
        ]),
      );
      assert.equal(model.primitives[part].vertices.length, expected.length);
      expected.forEach((value, i) => near(model.primitives[part].vertices[i], value));
      assert.deepEqual(
        Array.from(model.primitives[part].indices),
        normals === 'flat' ? triangles.map((_, i) => i) : triangles.map((v) => order.indexOf(v)),
      );
    }
    model.dispose();
  }
  assert.deepEqual(source, before);
  assert.equal(engine.meshes.size, 0);
});
