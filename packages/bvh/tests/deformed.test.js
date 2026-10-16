import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshBVH, Raycaster, setMeshLayers } from '../dist/index.js';

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const close = (actual, expected, epsilon = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
function vertices(
  points = [
    [-1, -1, 0],
    [1, -1, 0],
    [0, 1, 0],
  ],
  normal = [0, 0, 1],
) {
  const result = new Float32Array(points.length * 20);
  points.forEach((point, i) => {
    result.set(point, i * 20);
    result[i * 20 + 3] = 1;
    result.set(normal, i * 20 + 4);
    result.fill(1, i * 20 + 16, i * 20 + 20);
  });
  return result;
}
function fixture() {
  const store = {
    matrices: new Float32Array(16 * 16),
    parents: new Float32Array(16).fill(-1),
    hidden: new Uint8Array(16),
    ticks: 0,
    tick() {
      this.ticks++;
    },
  };
  const engine = { store, meshes: new Map(), disposed: false };
  let id = 0;
  const make = (parent = -1, matrix = identity()) => {
    const mesh = { engine, id: id++, geometry: null, material: { data: new Float32Array(8) } };
    engine.meshes.set(mesh.id, mesh);
    store.parents[mesh.id] = parent;
    store.matrices.set(matrix, mesh.id * 16);
    return mesh;
  };
  const root = make(),
    node = make(root.id);
  const snapshot = {
    node,
    vertices: vertices(),
    indices: new Uint32Array([0, 1, 2]),
    matrix: identity(),
    doubleSided: false,
  };
  const source = {
    root,
    disposed: false,
    reads: 0,
    async readPickingGeometry() {
      this.reads++;
      return [snapshot];
    },
  };
  return { engine, store, root, node, snapshot, source, make };
}

test('intersectModel picks morph and bounded eight-weight skin poses outside bind bounds without assigning core geometry', async () => {
  const f = fixture(),
    bind = f.snapshot.vertices.slice(),
    ray = new Raycaster([12, 0, 4], [0, 0, -1]);
  assert.deepEqual(await ray.intersectModel(f.source), []);
  // An independent CPU pose generator stands in for the GPU readback provider. Morph first, then exactly eight joints.
  const translations = [3, 6, 9, 12, 15, 18, 21, 24],
    weights = [0.1, 0.05, 0.2, 0.15, 0.1, 0.05, 0.2, 0.15];
  const total = weights.reduce((sum, value) => sum + value, 0);
  const jointShift = translations.reduce((sum, value, i) => sum + (value * weights[i]) / total, 0);
  for (const morph of [0, 0.5, 1]) {
    f.snapshot.vertices = bind.slice();
    for (let v = 0; v < 3; v++) {
      f.snapshot.vertices[v * 20] += jointShift + morph * 5;
      f.snapshot.vertices[v * 20 + 2] += morph * 2;
    }
    ray.set([jointShift + morph * 5, 0, 4], [0, 0, -1]);
    const hits = await ray.intersectModel(f.source);
    assert.equal(hits.length, 1);
    const hit = hits[0];
    assert.equal(hit.mesh, f.node);
    assert.equal(hit.faceIndex, 0);
    assert.equal(hit.frontFace, true);
    close(hit.distance, 4 - morph * 2);
    close(hit.point[0], jointShift + morph * 5);
    close(hit.localPoint[2], morph * 2);
    close(hit.barycoord[0], 0.25);
    close(hit.barycoord[1], 0.25);
    close(hit.barycoord[2], 0.5);
    assert.deepEqual(hit.normal, [0, 0, 1]);
    assert.deepEqual(hit.faceNormal, [0, 0, 1]);
    assert.equal(f.node.geometry, null);
    assert.equal(f.root.geometry, null);
  }
  assert.deepEqual(bind, vertices(), 'bind-pose vertices remain untouched');
  assert.equal(
    ray.intersectEngine(f.engine).length,
    0,
    'ordinary mesh raycasts retain their existing synchronous behavior',
  );
  assert.ok(f.store.ticks >= 4);
});

test('intersectModel refits unchanged topology and rebuilds changed topology, including several primitives on one node', async () => {
  const f = fixture(),
    ray = new Raycaster([0, 0, 2], [0, 0, -1]);
  const originalBuild = MeshBVH.fromGeometry,
    originalRefit = MeshBVH.prototype.refit;
  let builds = 0,
    refits = 0;
  MeshBVH.fromGeometry = function (...args) {
    builds++;
    return originalBuild.apply(this, args);
  };
  MeshBVH.prototype.refit = function (...args) {
    refits++;
    return originalRefit.apply(this, args);
  };
  try {
    assert.equal((await ray.intersectModel(f.source)).length, 1);
    assert.equal(builds, 1);
    f.snapshot.indices = f.snapshot.indices.slice();
    f.snapshot.vertices = f.snapshot.vertices.slice();
    for (let v = 0; v < 3; v++) f.snapshot.vertices[v * 20 + 2] = 1;
    close((await ray.intersectModel(f.source))[0].distance, 1);
    assert.equal(builds, 1);
    assert.equal(refits, 1);
    f.snapshot.indices = new Uint32Array([0, 2, 1]);
    assert.equal((await ray.intersectModel(f.source)).length, 0);
    assert.equal(builds, 2);
    const second = { ...f.snapshot, indices: new Uint32Array([0, 1, 2]), vertices: vertices() };
    f.source.readPickingGeometry = async () => [f.snapshot, second];
    ray.side = 'double';
    assert.deepEqual(
      (await ray.intersectModel(f.source)).map((hit) => hit.distance),
      [1, 2],
    );
    ray.firstHitOnly = true;
    close((await ray.intersectModel(f.source))[0].distance, 1);
    f.source.readPickingGeometry = async () => [second];
    close((await ray.intersectModel(f.source))[0].distance, 2);
  } finally {
    MeshBVH.fromGeometry = originalBuild;
    MeshBVH.prototype.refit = originalRefit;
  }
});

test('intersectModel preserves world distances, inverse-transpose normals, mirrored winding, material sides and near/far', async () => {
  const f = fixture(),
    normal = [1, 1, 1].map((value) => value / Math.sqrt(3));
  f.snapshot.vertices = vertices(undefined, normal);
  f.snapshot.matrix = new Float32Array([-2, 0, 0, 0, 1, 3, 0, 0, 0, 0, 0.5, 0, 5, 6, 7, 1]);
  const ray = new Raycaster([5, 6, 11], [0, 0, -1]);
  let hit = (await ray.intersectModel(f.source))[0];
  close(hit.distance, 4);
  assert.deepEqual(hit.point, [5, 6, 7]);
  assert.equal(hit.frontFace, true);
  const expected = [-0.5, 0.5, 2],
    length = Math.hypot(...expected);
  expected.forEach((value, axis) => close(hit.normal[axis], value / length));
  hit.faceNormal.forEach((value, axis) => close(value, axis === 2 ? 1 : 0));
  ray.near = 4;
  ray.far = 4;
  assert.equal((await ray.intersectModel(f.source)).length, 1);
  ray.near = 4.01;
  ray.far = 8;
  assert.equal((await ray.intersectModel(f.source)).length, 0);
  ray.near = 0;
  ray.far = 3.99;
  assert.equal((await ray.intersectModel(f.source)).length, 0);
  ray.far = Infinity;
  ray.set([5, 6, 3], [0, 0, 1]);
  assert.equal((await ray.intersectModel(f.source)).length, 0, 'single-sided primitive rejects its back face');
  f.snapshot.doubleSided = true;
  hit = (await ray.intersectModel(f.source))[0];
  assert.equal(hit.frontFace, false);
  ray.side = 'front';
  assert.equal((await ray.intersectModel(f.source)).length, 0);
  ray.side = 'back';
  assert.equal((await ray.intersectModel(f.source)).length, 1);
  f.snapshot.matrix[0] = 0;
  f.snapshot.matrix[1] = 0;
  assert.equal((await ray.intersectModel(f.source)).length, 0, 'singular transforms are skipped');
});

test('intersectModel respects current hidden ancestors, layer masks and filters after reparenting owned primitives', async () => {
  const f = fixture(),
    ray = new Raycaster([0, 0, 2], [0, 0, -1]),
    parent = f.make();
  assert.equal((await ray.intersectModel(f.source)).length, 1);
  for (const hidden of [f.node.id, f.root.id, parent.id]) {
    f.store.parents[f.root.id] = parent.id;
    f.store.hidden[hidden] = 1;
    assert.deepEqual(await ray.intersectModel(f.source), []);
    f.store.hidden[hidden] = 0;
  }
  setMeshLayers(f.node, 2);
  ray.layers = 1;
  assert.deepEqual(await ray.intersectModel(f.source), []);
  ray.layers = 3;
  assert.equal((await ray.intersectModel(f.source)).length, 1);
  ray.filter = (mesh) => mesh !== f.node;
  assert.deepEqual(await ray.intersectModel(f.source), []);
  ray.filter = null;
  f.store.parents[f.node.id] = parent.id;
  assert.equal(
    (await ray.intersectModel(f.source)).length,
    1,
    'source still owns and renders its reparented primitive',
  );
  f.store.hidden[f.root.id] = 1;
  assert.equal((await ray.intersectModel(f.source)).length, 1, 'former root is no longer an ancestor of the primitive');
  f.store.hidden[f.root.id] = 0;
  f.store.hidden[parent.id] = 1;
  assert.deepEqual(await ray.intersectModel(f.source), [], 'current hidden ancestor rejects the reparented primitive');
  f.store.hidden[parent.id] = 0;
  f.store.parents[f.node.id] = f.root.id;
  const ticks = f.store.ticks;
  await ray.intersectModel(f.source, { refresh: false });
  assert.equal(f.store.ticks, ticks);
  ray.filter = (mesh) => {
    f.engine.meshes.delete(mesh.id);
    return true;
  };
  assert.deepEqual(await ray.intersectModel(f.source), [], 'predicate removes a mesh synchronously');
});

test('intersectModel captures ray settings and supplied pose matrices across asynchronous readback', async () => {
  const f = fixture(),
    ray = new Raycaster([0, 0, 5], [0, 0, -1]);
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  f.source.readPickingGeometry = async () => {
    const snapshot = { ...f.snapshot, matrix: f.snapshot.matrix.slice() };
    await ready;
    return [snapshot];
  };
  const pending = ray.intersectModel(f.source);
  ray.set([100, 0, 5], [1, 0, 0]);
  ray.near = 10;
  ray.far = 20;
  ray.layers = 0;
  ray.side = 'back';
  ray.filter = () => false;
  f.snapshot.matrix[12] = 100;
  f.store.matrices[f.node.id * 16 + 12] = 100;
  release();
  const hit = (await pending)[0];
  close(hit.distance, 5);
  assert.deepEqual(hit.point, [0, 0, 0]);
});

test('intersectModel drops disposed sources, removed meshes and reused ids after readback', async () => {
  for (const change of ['source', 'engine', 'root', 'node', 'root-reuse', 'node-reuse', 'hidden']) {
    const f = fixture(),
      ray = new Raycaster([0, 0, 2], [0, 0, -1]);
    let release;
    const ready = new Promise((resolve) => {
      release = resolve;
    });
    f.source.readPickingGeometry = async () => {
      await ready;
      return [f.snapshot];
    };
    const pending = ray.intersectModel(f.source);
    if (change === 'source') f.source.disposed = true;
    if (change === 'engine') f.engine.disposed = true;
    if (change === 'root' || change === 'node') f.engine.meshes.delete(f[change].id);
    if (change.endsWith('-reuse')) {
      const mesh = f[change.split('-')[0]];
      f.engine.meshes.set(mesh.id, { ...mesh });
    }
    if (change === 'hidden') f.store.hidden[f.node.id] = 1;
    release();
    assert.deepEqual(await pending, [], change);
  }
});

test('intersectModel validates source ownership, snapshots, finite layouts, topology and ray limits', async () => {
  const f = fixture(),
    ray = new Raycaster([0, 0, 2], [0, 0, -1]);
  for (const source of [null, {}, { root: {}, readPickingGeometry() {} }])
    await assert.rejects(ray.intersectModel(source), /source|engine/);
  for (const edit of [
    (s) => {
      s.vertices = new Float32Array(59);
    },
    (s) => {
      s.vertices = new Float64Array(60);
    },
    (s) => {
      s.vertices[3] = NaN;
    },
    (s) => {
      s.vertices[4] = Infinity;
    },
    (s) => {
      s.indices = new Uint16Array([0, 1, 2]);
    },
    (s) => {
      s.indices = new Uint32Array([0, 1, 3]);
    },
    (s) => {
      s.indices = new Uint32Array([0, 1]);
    },
    (s) => {
      s.matrix = new Float32Array(15);
    },
    (s) => {
      s.matrix[12] = Infinity;
    },
    (s) => {
      s.matrix[3] = 1;
    },
    (s) => {
      s.doubleSided = 1;
    },
    (s) => {
      s.node = { ...f.node, engine: fixture().engine };
    },
  ]) {
    const snapshot = {
      ...f.snapshot,
      vertices: f.snapshot.vertices.slice(),
      indices: f.snapshot.indices.slice(),
      matrix: f.snapshot.matrix.slice(),
    };
    edit(snapshot);
    f.source.readPickingGeometry = async () => [snapshot];
    await assert.rejects(ray.intersectModel(f.source));
  }
  f.source.readPickingGeometry = async () => null;
  await assert.rejects(ray.intersectModel(f.source), /snapshots/);
  f.source.readPickingGeometry = async () => [null];
  await assert.rejects(ray.intersectModel(f.source), /snapshot/);
  f.source.readPickingGeometry = async () => {
    throw new Error('device lost');
  };
  await assert.rejects(ray.intersectModel(f.source), /device lost/);
  ray.near = NaN;
  await assert.rejects(ray.intersectModel(f.source), /near/);
  ray.near = 0;
  ray.far = -1;
  await assert.rejects(ray.intersectModel(f.source), /near/);
  ray.far = Infinity;
  ray.side = 'unknown';
  await assert.rejects(ray.intersectModel(f.source), /side/);
  ray.side = 'material';
  f.source.disposed = true;
  await assert.rejects(ray.intersectModel(f.source), /disposed/);
});
