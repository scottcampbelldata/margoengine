import test from 'node:test';
import assert from 'node:assert/strict';
import { Geometry, PbrMaterial, box } from '@margoengine/core';
import { traceSceneFromEngine } from '../dist/from-engine.js';

// Stand-ins for core meshes: the bridge reads only id, geometry, material, visible and matrix.
const translate = (x, y, z) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
const fakeEngine = (meshes) => ({ scene: { meshes: new Map(meshes.map((m) => [m.id, m])) } });

test('one trace mesh per geometry and material, one placement per visible mesh at its world matrix', () => {
  const cube = box(1, 2, 3),
    red = new PbrMaterial({ color: [1, 0, 0], roughness: 0.3, metalness: 0.7, doubleSided: false }),
    blue = new PbrMaterial({ color: '#0000ff' });
  const engine = fakeEngine([
    { id: 1, geometry: cube, material: red, visible: true, matrix: translate(1, 0, 0) },
    { id: 2, geometry: cube, material: red, visible: true, matrix: translate(2, 0, 0) },
    { id: 3, geometry: cube, material: blue, visible: true, matrix: translate(3, 0, 0) },
    { id: 4, geometry: cube, material: blue, visible: false, matrix: translate(4, 0, 0) },
    { id: 5, geometry: null, material: blue, visible: true, matrix: translate(5, 0, 0) },
    { id: 6, geometry: new Geometry([], [], []), material: blue, visible: true, matrix: translate(6, 0, 0) },
  ]);
  const scene = traceSceneFromEngine(engine);
  assert.deepEqual([scene.revision, scene.models, scene.instances, scene.materials], [1, [], [], []]);
  assert.equal(scene.meshes.length, 2, 'cube x red and cube x blue');
  assert.deepEqual(
    scene.meshInstances.map((i) => [i.id, i.mesh, i.transform[12]]),
    [
      ['engine-mesh-1', scene.meshes[0].id, 1],
      ['engine-mesh-2', scene.meshes[0].id, 2],
      ['engine-mesh-3', scene.meshes[1].id, 3],
    ],
  );
  const [r, b] = scene.pbrMaterials;
  assert.deepEqual(r, {
    id: 1,
    baseColorFactor: [1, 0, 0, 1],
    roughnessFactor: Math.fround(0.3),
    metallicFactor: Math.fround(0.7),
    doubleSided: false,
  });
  assert.deepEqual(b.baseColorFactor, [0, 0, 1, 1], 'sRGB #0000ff is linear blue');
  assert.equal(b.doubleSided, true, 'core materials default to double-sided');
  // The geometry: positions and normals split from the interleaved vertices, indices copied.
  const m = scene.meshes[0],
    v = cube.vertices;
  assert.equal(m.positions.length, (v.length / 6) * 3);
  for (let i = 0; i < v.length / 6; i++)
    for (let a = 0; a < 3; a++) {
      assert.equal(m.positions[i * 3 + a], v[i * 6 + a]);
      assert.equal(m.normals[i * 3 + a], v[i * 6 + 3 + a]);
    }
  assert.deepEqual(Array.from(m.indices), Array.from(cube.indices));
  assert.notEqual(m.indices, cube.indices, 'the engine geometry is not shared');
  // Geometry is immutable: a second call hands the tracer the same arrays, so its BLAS is reused.
  assert.equal(traceSceneFromEngine(engine).meshes[0].positions, m.positions);
});

test('a base scene keeps its content; base meshes without placements keep their world placement', () => {
  const engine = fakeEngine([
    { id: 9, geometry: box(), material: new PbrMaterial(), visible: true, matrix: translate(0, 0, 0) },
  ]);
  const panel = {
    id: 'panel',
    material: 4,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
  };
  const base = {
    revision: 7,
    models: [],
    instances: [],
    materials: [{ id: 1, type: 'diffuse', color: [1, 1, 1] }],
    environment: { skyIntensity: 0.5 },
    meshes: [panel],
    pbrMaterials: [{ id: 4 }],
  };
  const scene = traceSceneFromEngine(engine, { base });
  assert.equal(scene.revision, 7);
  assert.deepEqual(scene.environment, { skyIntensity: 0.5 });
  assert.deepEqual(scene.materials, base.materials);
  assert.deepEqual(
    scene.pbrMaterials.map((p) => p.id),
    [4, 5],
    'new material ids follow the base ones',
  );
  assert.deepEqual(
    scene.meshInstances.map((i) => [i.id, i.mesh]),
    [
      ['base-panel', 'panel'],
      ['engine-mesh-9', scene.meshes[1].id],
    ],
  );
  assert.equal(base.meshes.length, 1, 'the base is not changed');
  // With explicit base placements they are kept as given.
  const placed = traceSceneFromEngine(engine, { base: { ...base, meshInstances: [{ id: 'p', mesh: 'panel' }] } });
  assert.deepEqual(
    placed.meshInstances.map((i) => i.id),
    ['p', 'engine-mesh-9'],
  );
});

test('filter and scene choose the meshes; wrong kinds throw TypeError', () => {
  const a = {
      id: 1,
      name: 'keep',
      geometry: box(),
      material: new PbrMaterial(),
      visible: true,
      matrix: translate(0, 0, 0),
    },
    b = { ...a, id: 2, name: 'drop' };
  const engine = fakeEngine([a, b]);
  assert.deepEqual(
    traceSceneFromEngine(engine, { filter: (m) => m.name === 'keep' }).meshInstances.map((i) => i.id),
    ['engine-mesh-1'],
  );
  const other = { meshes: new Map([[2, b]]) };
  assert.deepEqual(
    traceSceneFromEngine(engine, { scene: other }).meshInstances.map((i) => i.id),
    ['engine-mesh-2'],
  );
  assert.throws(() => traceSceneFromEngine(null), TypeError);
  assert.throws(() => traceSceneFromEngine(engine, { filter: 1 }), TypeError);
  assert.throws(() => traceSceneFromEngine(engine, { scene: {} }), TypeError);
  assert.throws(() => traceSceneFromEngine(engine, { base: { revision: 1 } }), TypeError);
});

test('terrain sources become one world-space mesh each, with their material, step and region passed through', () => {
  const calls = [],
    tri = { positions: new Float32Array(9), normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) },
    query = { triangles: (o) => (calls.push(o), tri) },
    empty = {
      triangles: () => ({ positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0) }),
    },
    red = new PbrMaterial({ color: [1, 0, 0] }),
    engine = fakeEngine([{ id: 1, geometry: box(1, 1, 1), material: red, visible: true, matrix: translate(0, 0, 0) }]);
  const region = { min: [0, 0], max: [4, 4] },
    scene = traceSceneFromEngine(engine, {
      terrain: [
        { query, step: 2, region, material: { baseColorFactor: [0.2, 0.4, 0.1, 1], roughnessFactor: 0.8 } },
        { query: empty },
        { query },
      ],
    });
  assert.deepEqual(calls, [
    { step: 2, region },
    { step: undefined, region: undefined },
  ]);
  assert.deepEqual(
    scene.meshes.map((m) => m.id),
    ['engine-0', 'terrain-0', 'terrain-2'],
    'an all-hole terrain adds nothing',
  );
  assert.equal(scene.meshes[1].positions, tri.positions, 'the query arrays, not copies');
  assert.deepEqual(scene.meshInstances.slice(1), [
    { id: 'engine-terrain-0', mesh: 'terrain-0' },
    { id: 'engine-terrain-2', mesh: 'terrain-2' },
  ]);
  assert.deepEqual(scene.pbrMaterials.slice(1), [
    { id: 2, baseColorFactor: [0.2, 0.4, 0.1, 1], roughnessFactor: 0.8, metallicFactor: 0 },
    { id: 3, baseColorFactor: [0.5, 0.5, 0.5, 1], roughnessFactor: 1, metallicFactor: 0 },
  ]);
  assert.equal(scene.meshes[1].material, 2);
  for (const terrain of [{}, [{}], [{ query: {} }], [null]])
    assert.throws(() => traceSceneFromEngine(engine, { terrain }), TypeError);
});

test('scatter readouts become one mesh per non-empty ring, one placement per instance, one material per scatter', () => {
  const near = box(1, 1, 1),
    far = box(2, 2, 2),
    t = new Float32Array(32);
  t.set(translate(1, 2, 3));
  t.set(translate(4, 5, 6), 16);
  const read = {
      rings: [
        { geometry: near, transforms: t },
        { geometry: far, transforms: new Float32Array(0) },
        { geometry: far, transforms: t.slice(16) },
      ],
      color: [0.2, 0.5, 0.1],
      roughness: 0.7,
      metalness: 0,
    },
    scene = traceSceneFromEngine(fakeEngine([]), { scatter: [read] });
  assert.deepEqual(
    scene.meshes.map((m) => [m.id, m.material, m.indices.length]),
    [
      ['scatter-0-0', 1, near.indices.length],
      ['scatter-0-2', 1, far.indices.length],
    ],
  );
  assert.deepEqual(
    scene.meshInstances.map((i) => [i.id, i.mesh, i.transform[12], i.transform[14]]),
    [
      ['engine-scatter-0-0-0', 'scatter-0-0', 1, 3],
      ['engine-scatter-0-0-1', 'scatter-0-0', 4, 6],
      ['engine-scatter-0-2-0', 'scatter-0-2', 4, 6],
    ],
  );
  assert.deepEqual(scene.pbrMaterials, [
    { id: 1, baseColorFactor: [0.2, 0.5, 0.1, 1], roughnessFactor: 0.7, metallicFactor: 0, doubleSided: true },
  ]);
  for (const scatter of [{}, [{}], [null]])
    assert.throws(() => traceSceneFromEngine(fakeEngine([]), { scatter }), TypeError);
});
