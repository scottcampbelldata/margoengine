import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine, TransformStore, box } from '../../core/dist/extension.js';
import { setRenderLayers } from '../../cameras/dist/layers.js';
import { Raycaster } from '../dist/index.js';
import { SceneBVH } from '../dist/scene.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { setMeshSource } from '../../shared/mesh-source.js';
import { rng } from './reference.js';

async function world(capacity = 4096) {
  const h = optionalGPU(),
    engine = new Engine(
      { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
      await TransformStore.create(capacity),
      { backend: 'webgpu', gpu: h.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    );
  return engine;
}

function city(engine, side = 20) {
  const geometry = box(1, 1, 1),
    meshes = [];
  for (let x = 0; x < side; x++)
    for (let z = 0; z < side; z++) meshes.push(engine.createMesh().setGeometry(geometry).setPosition([x * 3, 0, z * 3]));
  return meshes;
}

function strip(hit) {
  return [hit.mesh.id, hit.distance, hit.faceIndex, hit.instanceId, hit.approximate, hit.primitiveIndex];
}

function agree(engine, scene, count, seed = 1, setup = () => {}) {
  const random = rng(seed),
    ray = new Raycaster();
  setup(ray);
  let hits = 0;
  for (let i = 0; i < count; i++) {
    ray.set(
      [random() * 70 - 5, random() - 0.5, random() * 70 - 5],
      [random() * 2 - 1, random() * 0.1 - 0.05, random() * 2 - 1],
    );
    const expected = ray.intersectEngine(engine),
      found = scene.intersect(ray, { refresh: false });
    hits += expected.length;
    assert.deepEqual(found.map(strip), expected.map(strip), `ray ${i}`);
  }
  return hits;
}

test('a scene answers what intersectEngine answers over a city, in the same order', async () => {
  const engine = await world(),
    meshes = city(engine),
    scene = new SceneBVH(engine);
  assert.equal(scene.update(), 'rebuilt');
  assert.equal(scene.size, meshes.length);
  assert.ok(agree(engine, scene, 400) > 200);
  assert.ok(agree(engine, scene, 200, 2, (ray) => (ray.firstHitOnly = true)) > 50);
  assert.ok(agree(engine, scene, 100, 3, (ray) => ((ray.near = 2), (ray.far = 20), (ray.side = 'double'))) > 10);
});

test('a ray visits a few objects of the city, not all of them', async () => {
  const engine = await world(),
    meshes = city(engine, 30),
    scene = new SceneBVH(engine),
    ray = new Raycaster([1.5 * 30, 50, 1.5 * 30], [0, -1, 0]);
  let visited = 0;
  ray.filter = () => (visited++, true);
  scene.intersect(ray);
  assert.ok(visited <= 4, `${visited} of ${meshes.length} objects`);
});

test('moved objects refit, and a tree refit out of shape rebuilds', async () => {
  const engine = await world(),
    meshes = city(engine, 10),
    scene = new SceneBVH(engine);
  scene.update();
  assert.equal(scene.update(), 'unchanged');
  meshes[3].setPosition([1, 0, 1.5]);
  assert.equal(scene.update(), 'refit');
  agree(engine, scene, 200, 4);
  // Swap the two halves of the city: every box of the tree now spans it.
  const random = rng(5);
  for (const mesh of meshes) mesh.setPosition([random() * 30, 0, random() * 30]);
  assert.equal(scene.update(), 'rebuilt');
  agree(engine, scene, 200, 6);
  assert.equal(scene.update(), 'unchanged');
});

test('by default intersect sees a move made just before it', async () => {
  const engine = await world(),
    [mesh] = city(engine, 1),
    scene = new SceneBVH(engine),
    ray = new Raycaster([0, 50, 0], [0, -1, 0]);
  assert.equal(scene.intersect(ray)[0].mesh, mesh);
  mesh.setPosition([100, 0, 0]);
  assert.deepEqual(scene.intersect(ray), []);
  ray.set([100, 50, 0], [0, -1, 0]);
  assert.equal(scene.intersect(ray)[0].mesh, mesh);
});

test('objects added and removed rebuild the tree', async () => {
  const engine = await world(),
    meshes = city(engine, 4),
    scene = new SceneBVH(engine);
  scene.update();
  engine.createMesh().setGeometry(box(1, 1, 1)).setPosition([40, 0, 40]);
  assert.equal(scene.update(), 'rebuilt');
  assert.equal(scene.size, meshes.length + 1);
  agree(engine, scene, 100, 7);
  meshes[0].dispose();
  assert.equal(scene.update(), 'rebuilt');
  assert.equal(scene.size, meshes.length);
  agree(engine, scene, 100, 8);
});

test('hidden, filtered and layered meshes follow the raycaster, without an update', async () => {
  const engine = await world(),
    meshes = city(engine, 6),
    scene = new SceneBVH(engine);
  scene.update();
  meshes[2].visible = false;
  setRenderLayers(meshes[5], 2);
  agree(engine, scene, 200, 9);
  agree(engine, scene, 200, 10, (ray) => (ray.layers = 2));
  agree(engine, scene, 200, 11, (ray) => (ray.filter = (mesh) => mesh.id % 2 === 0));
});

test('a mesh disposed after the last update answers no hit, even with a stale tree', async () => {
  const engine = await world(),
    [mesh] = city(engine, 1),
    scene = new SceneBVH(engine),
    ray = new Raycaster([0, 50, 0], [0, -1, 0]);
  scene.update();
  mesh.dispose();
  assert.deepEqual(scene.intersect(ray, { refresh: false }), []);
});

test('instances are objects of their own and follow their rows', async () => {
  const engine = await world(),
    node = engine.createMesh(),
    vertices = new Float32Array(60),
    data = new Float32Array(48);
  [
    [-1, -1, 0],
    [1, -1, 0],
    [0, 1, 0],
  ].forEach((p, i) => vertices.set(p, i * 20));
  for (let k = 0; k < 2; k++) {
    data.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, k * 10, 0, 0, 1], k * 24);
  }
  const primitive = {
      node,
      vertices,
      indices: new Uint32Array([0, 1, 2]),
      material: { settings: [0, 0, 1] },
      instances: { count: 2, data },
    },
    model = { root: node, primitives: [primitive] },
    scene = new SceneBVH(engine, { objects: [model] }),
    ray = new Raycaster([10, 0, 5], [0, 0, -1]);
  assert.equal(scene.update(), 'rebuilt');
  assert.equal(scene.size, 2);
  assert.equal(scene.intersect(ray)[0].instanceId, 1);
  data[24 + 12] = 20;
  assert.equal(scene.update(), 'refit');
  assert.deepEqual(scene.intersect(ray, { refresh: false }), []);
  ray.set([20, 0, 5], [0, 0, -1]);
  assert.equal(scene.intersect(ray, { refresh: false })[0].instanceId, 1);
  primitive.instances = { count: 1, data };
  assert.equal(scene.update(), 'rebuilt');
  assert.equal(scene.size, 1);
});

test('pick proxies answer as they do from intersectEngine', async () => {
  const engine = await world(),
    anchor = engine.createMesh().setPosition([5, 0, 0]);
  engine.use({ name: 'proxies', setup() {}, pickProxies: () => [{ anchor, sphere: [0, 0, 0, 2] }] });
  const scene = new SceneBVH(engine),
    ray = new Raycaster([5, 0, 10], [0, 0, -1]),
    [hit] = scene.intersect(ray),
    [expected] = ray.intersectEngine(engine);
  assert.ok(hit.approximate);
  assert.deepEqual(strip(hit), strip(expected));
});

test('a scene of chosen objects holds only them, and add and remove change it', async () => {
  const engine = await world(),
    [a, b] = city(engine, 2),
    scene = new SceneBVH(engine, { objects: [a] }),
    ray = new Raycaster([0, 50, 3], [0, -1, 0]);
  assert.deepEqual(scene.intersect(ray), []);
  scene.add(b);
  assert.equal(scene.intersect(ray)[0].mesh, b);
  assert.equal(scene.remove(b), true);
  assert.deepEqual(scene.intersect(ray), []);
  const whole = new SceneBVH(engine);
  assert.throws(() => whole.add(a), { code: 'state' });
});

test('an actively deformed mesh refuses rather than answering its bind pose', async () => {
  const engine = await world(),
    node = engine.createMesh(),
    vertices = new Float32Array(60),
    primitive = { node, vertices, indices: new Uint32Array([0, 1, 2]), material: { settings: [0, 0, 1] } },
    model = { root: node, primitives: [primitive] };
  vertices.set([1, 0, 0], 20);
  vertices.set([0, 1, 0], 40);
  setMeshSource(node, { model, primitives: [primitive] });
  primitive.deformed = {};
  const scene = new SceneBVH(engine, { objects: [model] }),
    ray = new Raycaster([0.2, 0.2, 5], [0, 0, -1]);
  assert.throws(() => scene.intersect(ray), { code: 'unsupported' });
  node.visible = false;
  assert.deepEqual(scene.intersect(ray), []);
});

test('a mesh whose matrix is not finite answers nothing and does not spoil the tree', async () => {
  const engine = await world(),
    meshes = city(engine, 3);
  engine.store.tick(false);
  engine.store.matrices[meshes[0].id * 16 + 12] = Number.NaN;
  const scene = new SceneBVH(engine);
  assert.equal(scene.update({ refresh: false }), 'rebuilt');
  assert.ok(agree(engine, scene, 100, 12) > 0);
});

test('an empty scene answers nothing, and a bad threshold or disposed scene say so', async () => {
  const engine = await world(),
    scene = new SceneBVH(engine),
    ray = new Raycaster([0, 0, 5], [0, 0, -1]);
  assert.deepEqual(scene.intersect(ray), []);
  assert.equal(scene.size, 0);
  assert.throws(() => new SceneBVH(engine, { rebuildThreshold: 0.5 }), RangeError);
  scene[Symbol.dispose]();
  assert.ok(scene.disposed);
  assert.throws(() => scene.intersect(ray), { code: 'disposed' });
  assert.throws(() => scene.update(), { code: 'disposed' });
  const other = new SceneBVH(engine);
  engine.dispose();
  assert.throws(() => other.update(), { code: 'disposed' });
});
