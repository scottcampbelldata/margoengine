import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

async function internal(name) {
  const built = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      target: 'es2022',
      lib: { entry: fileURLToPath(new URL(`../src/${name}.ts`, import.meta.url)), formats: ['es'] },
    },
  });
  const code = (Array.isArray(built) ? built[0] : built).output.find((entry) => entry.type === 'chunk').code;
  return import(
    `data:text/javascript;base64,${Buffer.from(`${code}\n//# sourceURL=fbx-${name}-budget-test.js`).toString('base64')}`
  );
}
const [{ context, buildScene, SceneBudget }, { attachSkin }, { attachMorphs }] = await Promise.all(
  ['scene', 'skin', 'morph'].map(internal),
);
const node = (name, properties = [], children = []) => ({ name, properties, children });
const array = (name, data) => node(name, [data]);
const identity = () => new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const model = (key, offset = 0) =>
  node('Model', [BigInt(key), `Model::Node${key}`, 'Mesh'], [node('GeometricTranslation', [offset, 0, 0])]);
const connect = (child, parent) => ({ kind: 'OO', child: BigInt(child), parent: BigInt(parent) });
function geometry(positions = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices = new Int32Array([0, 1, -3])) {
  return node(
    'Geometry',
    [1n, 'Geometry::Source', 'Mesh'],
    [array('Vertices', positions), array('PolygonVertexIndex', indices)],
  );
}
const document = (objects, connections) => ({
  roots: [],
  objects: new Map(objects.map((source) => [source.properties[0], source])),
  connections,
  version: 7400,
});
function binding(source, parent) {
  return {
    source,
    model: parent,
    node: { name: 'Primitive' },
    geometry: {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    },
    controlPoints: new Uint32Array([0, 1, 2]),
    geometric: identity(),
    geometricInverse: identity(),
    materialIndex: 0,
  };
}
function rig(cpCount = 3) {
  const positions = new Float64Array(cpCount * 3);
  positions[3] = 1;
  positions[7] = 1;
  const source = geometry(positions),
    parent = model(2),
    joint = node('Model', [12n, 'Model::Joint', 'LimbNode']);
  const skin = node('Deformer', [10n, 'Deformer::Skin', 'Skin']);
  const cluster = node(
    'Deformer',
    [11n, 'SubDeformer::Cluster', 'Cluster'],
    [
      array('Transform', identity()),
      array('TransformLink', identity()),
      array('Indexes', new Int32Array([0, 1, 2])),
      array('Weights', new Float64Array([1, 1, 1])),
    ],
  );
  const blend = node('Deformer', [20n, 'Deformer::Blend', 'BlendShape']),
    channel = node('Deformer', [21n, 'SubDeformer::Smile', 'BlendShapeChannel']);
  const shape = node(
    'Geometry',
    [22n, 'Geometry::Shape', 'Shape'],
    [array('Indexes', new Int32Array([1])), array('Vertices', new Float64Array([0.1, 0, 0]))],
  );
  const ctx = context(
    document(
      [source, parent, joint, skin, cluster, blend, channel, shape],
      [
        connect(1, 2),
        connect(10, 1),
        connect(11, 10),
        connect(12, 11),
        connect(20, 1),
        connect(21, 20),
        connect(22, 21),
      ],
    ),
  );
  ctx.nodes.set(12n, { name: 'Joint' });
  return { ctx, source, parent, mesh: binding(source, parent) };
}

test('scene allocation, work and global morph thresholds reject before the next reservation', () => {
  const allocation = new SceneBudget();
  allocation.reserve(128 * 1024 * 1024);
  assert.throws(() => allocation.reserve(1), /scene allocation budget/);
  const work = new SceneBudget();
  work.work(128_000_000);
  assert.throws(() => work.work(1), /scene work budget/);
  const morph = new SceneBudget();
  morph.morph(64 * 1024 * 1024);
  assert.throws(() => morph.morph(1), /morph byte budget/);
  for (const value of [-1, Infinity, NaN, 1.5])
    assert.throws(() => new SceneBudget().reserve(value), /scene allocation budget/);
});

test('geometry preflight checks source scratch allocation and polygon work before reading positions', () => {
  let reads = 0;
  const positions = {
    length: 3_000_000,
    get 0() {
      reads++;
      throw new Error('position must not be scanned');
    },
  };
  const source = geometry(positions),
    parent = model(2),
    ctx = context(document([source, parent], [connect(1, 2)]));
  ctx.budget.reserve(128 * 1024 * 1024 - 20_000);
  assert.throws(() => buildScene(ctx), /scene allocation budget/);
  assert.equal(reads, 0);
  const indices = new Int32Array(4096 * 8);
  for (let i = 4095; i < indices.length; i += 4096) indices[i] = -1;
  const costly = geometry(
      {
        length: 9,
        get 0() {
          reads++;
          throw new Error('position must not be scanned');
        },
      },
      indices,
    ),
    work = context(document([costly, parent], [connect(1, 2)]));
  assert.throws(() => buildScene(work), /scene work budget/);
  assert.equal(reads, 0);
});

test('geometry instances scan a large source once and transform independent output buffers', () => {
  const values = new Float64Array(15_000);
  values[3] = 1;
  values[7] = 1;
  let reads = 0;
  const positions = new Proxy(values, {
    get(target, key) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, target);
    },
  });
  const source = geometry(positions),
    models = Array.from({ length: 5 }, (_, index) => model(index + 2, index));
  const ctx = context(
    document(
      [source, ...models],
      models.map((parent) => connect(1, parent.properties[0])),
    ),
  );
  buildScene(ctx);
  assert.ok(reads < values.length + 100, `source positions were scanned ${reads} times`);
  assert.deepEqual(
    ctx.meshes.map((mesh) => mesh.geometry.positions[0]),
    [0, 1, 2, 3, 4],
  );
  assert.notEqual(ctx.meshes[0].geometry.positions, ctx.meshes[1].geometry.positions);
});

test('skin and morph scratch reservations happen before oversized control-point allocations', () => {
  const skin = rig(1_000_000);
  skin.ctx.budget.reserve(110 * 1024 * 1024);
  assert.throws(() => attachSkin(skin.ctx, skin.mesh), /scene allocation budget/);
  const morph = rig(1_000_000);
  morph.ctx.budget.reserve(127 * 1024 * 1024);
  assert.throws(() => attachMorphs(morph.ctx, morph.mesh), /scene allocation budget/);
  assert.equal(skin.mesh.geometry.joints, undefined);
  assert.equal(morph.mesh.geometry.morphs, undefined);
});

test('material primitives share source skin reduction and morph lookups while reserving each output', () => {
  const { ctx, source, parent, mesh } = rig(5000),
    other = binding(source, parent),
    reserve = ctx.budget.reserve.bind(ctx.budget);
  let skinScratch = 0,
    morphScratch = 0;
  ctx.budget.reserve = (bytes) => {
    if (bytes === 5000 * 44 + 144) skinScratch++;
    if (bytes === 5000 * 4 + 128) morphScratch++;
    reserve(bytes);
  };
  attachSkin(ctx, mesh);
  attachSkin(ctx, other);
  attachMorphs(ctx, mesh);
  attachMorphs(ctx, other);
  assert.equal(skinScratch, 1);
  assert.equal(morphScratch, 1);
  assert.equal(mesh.node.skin.inverseBindMatrices, other.node.skin.inverseBindMatrices);
  assert.notEqual(mesh.geometry.joints, other.geometry.joints);
  assert.notEqual(mesh.geometry.morphs[0].positions, other.geometry.morphs[0].positions);
  const blocked = rig();
  blocked.ctx.budget.morph(64 * 1024 * 1024 - 8);
  assert.throws(() => attachMorphs(blocked.ctx, blocked.mesh), /morph byte budget/);
  assert.equal(blocked.mesh.geometry.morphs, undefined);
});
