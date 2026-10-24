import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore, box } from '../../core/dist/extension.js';
import { CameraProjection } from '../../cameras/dist/index.js';
import { Raycaster, RaycastSnapshot } from '../dist/index.js';
import { setMeshSource } from '../../shared/mesh-source.js';
import { setRenderLayers } from '../../cameras/dist/layers.js';

async function world(backend = 'webgl2') {
  return new Engine(
    { width: 600, height: 480, clientWidth: 600, clientHeight: 480 },
    await TransformStore.create(512),
    { backend, gpu: null, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
}
function geometry() {
  return box(1, 1, 1);
}
const query = () => {
  const r = new Raycaster([0.123, 0.187, 4], [0, 0, -1]);
  r.side = 'double';
  return r;
};
const same = (a, b) => assert.deepEqual(a, b);
function modelFixture(engine) {
  const root = engine.createMesh(),
    node = engine.createMesh(root),
    vertices = new Float32Array(4 * 20);
  [
    [-1, -1, 0],
    [1, -1, 0],
    [1, 1, 0],
    [-1, 1, 0],
  ].forEach((p, i) => {
    vertices.set(p, i * 20);
    vertices[i * 20 + 3] = 1;
    vertices.set([0, 0, 1], i * 20 + 4);
    vertices.set(
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ][i],
      i * 20 + 12,
    );
  });
  const primitive = {
    node,
    vertices,
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    nodeIndex: 7,
    material: { settings: new Float32Array([0, 0, 1]) },
    deformed: false,
  };
  const model = { root, primitives: [primitive], disposed: false };
  setMeshSource(node, { model, primitives: [primitive] });
  return { root, node, primitive, model };
}

test('captured core hits preserve complete live numeric/identity results through affine hierarchy and query settings', async () => {
  const engine = await world(),
    parent = engine.createMesh().setScale([2, 1, 0.5]).setRotation([0.1, 0.2, 0.3]);
  const front = engine.createMesh(parent).setGeometry(geometry()).setRotation([0.2, 0.4, 0]),
    rear = engine.createMesh().setGeometry(geometry()).setPosition([0, 0, -2]).setScale([-1, 2, 1]);
  const ray = query(),
    snapshot = RaycastSnapshot.capture(engine, [front, rear]);
  try {
    for (const side of ['double', 'front', 'back', 'material'])
      for (const first of [false, true])
        for (const range of [
          [0, Infinity],
          [3, 6],
        ]) {
          ray.side = side;
          ray.firstHitOnly = first;
          [ray.near, ray.far] = range;
          same(snapshot.intersect(ray), ray.intersectObjects(engine, [front, rear], { refresh: false }));
        }
  } finally {
    snapshot.dispose();
    engine.dispose();
  }
});

test('camera mapping owns the captured CSS/backing dimensions, matrix, projection and eye position', async () => {
  const engine = await world(),
    mesh = engine.createMesh().setGeometry(geometry()),
    snapshot = RaycastSnapshot.capture(engine, [mesh]);
  const a = query(),
    b = query();
  try {
    for (const [x, y] of [
      [300, 240],
      [0, 0],
      [-0.25, 100],
      [601, 480],
    ]) {
      snapshot.setFromCanvas(a, x, y);
      b.setFromEngine(engine, x, y);
      same(a.origin, b.origin);
      same(a.direction, b.direction);
    }
    snapshot.setFromCanvas(a, 300, 240);
    const old = [a.origin.slice(), a.direction.slice()];
    engine.camera.position[0] = 4;
    engine.canvas.width = 1000;
    engine.canvas.clientWidth = 1000;
    snapshot.setFromCanvas(a, 300, 240);
    same([a.origin, a.direction], old);
    b.setFromEngine(engine, 300, 240);
    assert.notDeepEqual(b.direction, a.direction);
  } finally {
    snapshot.dispose();
    engine.dispose();
  }
});

test('captured geometry, indices, transforms, material masks and returned hits do not alias later source edits', async () => {
  const engine = await world(),
    source = geometry(),
    mesh = engine.createMesh().setGeometry(source),
    ray = query();
  const snapshot = RaycastSnapshot.capture(engine, [mesh]),
    original = snapshot.intersect(ray);
  try {
    assert(original.length > 0);
    source.vertices.fill(50);
    source.indices.fill(0);
    mesh.setPosition([30, 0, 0]);
    mesh.visible = false;
    setRenderLayers(mesh, 8);
    engine.store.tick(false);
    same(snapshot.intersect(ray), original);
    const damaged = snapshot.intersect(ray);
    damaged[0].point[0] = 999;
    damaged[0].barycoord[0] = 999;
    same(snapshot.intersect(ray), original);
  } finally {
    snapshot.dispose();
    engine.dispose();
  }
});

test('captured layer masks and visibility are refreshed by recapture, never by hidden source mutations', async () => {
  const engine = await world(),
    mesh = engine.createMesh().setGeometry(geometry()),
    ray = query();
  setRenderLayers(mesh, 2);
  const snapshot = RaycastSnapshot.capture(engine, [mesh]);
  try {
    ray.layers = 1;
    assert.equal(snapshot.intersect(ray).length, 0);
    ray.layers = 2;
    assert(snapshot.intersect(ray).length > 0);
    mesh.visible = false;
    const next = RaycastSnapshot.capture(engine, [mesh]);
    try {
      assert.equal(next.intersect(ray).length, 0);
      assert(snapshot.intersect(ray).length > 0);
    } finally {
      next.dispose();
    }
  } finally {
    snapshot.dispose();
    engine.dispose();
  }
});

test('disposed handles and reused numeric IDs cannot receive captured hits', async () => {
  const engine = await world(),
    mesh = engine.createMesh().setGeometry(geometry()),
    id = mesh.id,
    ray = query();
  const snapshot = RaycastSnapshot.capture(engine, [mesh]);
  try {
    mesh.dispose();
    const replacement = engine.createMesh().setGeometry(geometry());
    assert.equal(replacement.id, id);
    assert.deepEqual(snapshot.intersect(ray), []);
  } finally {
    snapshot.dispose();
    engine.dispose();
  }
});

test('filter callbacks can issue nested queries while disposal and query-setting mutation cannot corrupt the outer query', async () => {
  const engine = await world(),
    a = engine.createMesh().setGeometry(geometry()),
    b = engine.createMesh().setGeometry(geometry()).setPosition([0, 0, -2]);
  const snapshot = RaycastSnapshot.capture(engine, [a, b]),
    ray = query(),
    expected = snapshot.intersect(ray);
  let calls = 0;
  try {
    ray.filter = () => {
      calls++;
      const nested = query();
      same(snapshot.intersect(nested), expected);
      ray.near = 99;
      return true;
    };
    same(snapshot.intersect(ray), expected);
    assert.equal(calls, 2);
    ray.near = 0;
    ray.filter = (mesh) => {
      if (mesh === a) b.dispose();
      return true;
    };
    assert(snapshot.intersect(ray).every((h) => h.mesh === a));
  } finally {
    snapshot.dispose();
    engine.dispose();
  }
});

test('snapshot disposal is idempotent and snapshot/engine disposal fail with actionable stable codes', async () => {
  const engine = await world(),
    mesh = engine.createMesh().setGeometry(geometry()),
    ray = query(),
    snapshot = RaycastSnapshot.capture(engine, [mesh]);
  snapshot[Symbol.dispose]();
  snapshot.dispose();
  assert(snapshot.disposed);
  assert.throws(
    () => snapshot.intersect(ray),
    (e) => e.code === 'disposed' && /capture/i.test(e.message),
  );
  const next = RaycastSnapshot.capture(engine, [mesh]);
  engine.dispose();
  assert.throws(
    () => next.intersect(ray),
    (e) => e.code === 'disposed',
  );
  // Live queries on a disposed engine use the same code.
  assert.throws(
    () => ray.intersectMeshes(engine, [mesh]),
    (e) => e.code === 'disposed',
  );
  next.dispose();
});

test('PBR UVs, normal/side/winding fields and root-mask inheritance match live queries for models and registered mesh handles', async () => {
  const engine = await world(),
    f = modelFixture(engine),
    ray = query();
  f.root.setScale([-2, 1.5, 0.75]);
  f.node.setRotation([0.1, 0.2, 0.3]);
  setRenderLayers(f.root, 8);
  ray.layers = 8;
  try {
    for (const given of [[f.model], [f.node], [f.node, f.model]])
      for (const side of ['double', 'front', 'back']) {
        f.primitive.material.side = side;
        const snapshot = RaycastSnapshot.capture(engine, given);
        try {
          for (const force of ['material', 'double', 'front', 'back']) {
            ray.side = force;
            same(snapshot.intersect(ray), ray.intersectObjects(engine, given, { refresh: false }));
          }
        } finally {
          snapshot.dispose();
        }
      }
  } finally {
    engine.dispose();
  }
});

test('captured PBR UV/material/geometry data remains exact after source edits and returned-UV mutations', async () => {
  const engine = await world(),
    f = modelFixture(engine),
    ray = query(),
    snapshot = RaycastSnapshot.capture(engine, [f.model]);
  const expected = snapshot.intersect(ray);
  assert(expected.length);
  assert(expected[0].uv);
  try {
    f.primitive.vertices.fill(99);
    f.primitive.indices.fill(0);
    f.primitive.material.side = 'back';
    f.node.setPosition([90, 0, 0]);
    same(snapshot.intersect(ray), expected);
    const hit = snapshot.intersect(ray)[0];
    hit.uv.fill(999);
    hit.normal.fill(999);
    hit.localPoint.fill(999);
    same(snapshot.intersect(ray), expected);
  } finally {
    snapshot.dispose();
    engine.dispose();
  }
});

test('captured instances preserve IDs, affine transforms, UVs and results under later instance-buffer mutation', async () => {
  const engine = await world(),
    f = modelFixture(engine),
    data = new Float32Array(24 * 3),
    ray = query();
  for (let i = 0; i < 3; i++) {
    data.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -i, 1], i * 24);
  }
  f.primitive.instances = { count: 3, data };
  f.root.setScale([-1, 2, 0.75]);
  const snapshot = RaycastSnapshot.capture(engine, [f.model]);
  try {
    const expected = ray.intersectObjects(engine, [f.model], { refresh: false });
    same(snapshot.intersect(ray), expected);
    assert.deepEqual([...new Set(expected.map((h) => h.instanceId))], [0, 1, 2]);
    data.fill(0);
    f.primitive.instances.count = 0;
    same(snapshot.intersect(ray), expected);
  } finally {
    snapshot.dispose();
    engine.dispose();
  }
});

test('captured proxy ellipsoids preserve approximate hits, normals and zero-radius sources without aliasing', async () => {
  const engine = await world(),
    anchor = engine.createMesh().setPosition([0, 0, -1]).setScale([2, 1, 1]),
    sphere = [0, 0, 0, 1];
  const point = engine.createMesh().setPosition([0, 0, -4]),
    list = [
      { anchor, sphere },
      { anchor: point, sphere: [0, 0, 0, 0] },
    ];
  engine.use({ name: 'snapshot-proxies', setup() {}, pickProxies: () => list });
  const ray = new Raycaster([0, 0, 4], [0, 0, -1]),
    snapshot = RaycastSnapshot.capture(engine, [anchor, point]);
  try {
    const expected = ray.intersectObjects(engine, [anchor, point], { refresh: false });
    same(snapshot.intersect(ray), expected);
    assert.equal(expected.length, 2);
    sphere.fill(99);
    list.length = 0;
    same(snapshot.intersect(ray), expected);
  } finally {
    snapshot.dispose();
    engine.dispose();
  }
});

test('orthographic, exactly vertical and reversed-Z camera rays match live Margo mapping', async () => {
  for (const backend of ['webgpu', 'webgl2']) {
    const engine = await world(backend),
      mesh = engine.createMesh().setGeometry(geometry()),
      projection = CameraProjection.attach(engine, { mode: 'orthographic', height: 3 });
    try {
      for (const top of [false, true]) {
        projection.up = [0, 0, -1];
        engine.camera.position = top ? [0, 4, 0] : [0, 0, 4];
        const snapshot = RaycastSnapshot.capture(engine, [mesh]),
          a = query(),
          b = query();
        try {
          for (const p of [
            [300, 240],
            [1, 1],
            [599, 479],
            [-0.25, 100],
          ]) {
            snapshot.setFromCanvas(a, ...p);
            b.setFromEngine(engine, ...p);
            same(a.origin, b.origin);
            same(a.direction, b.direction);
          }
        } finally {
          snapshot.dispose();
        }
      }
    } finally {
      engine.dispose();
    }
  }
});

test('a visible deformed registered source rejects capture and live model-list picking rather than using bind pose', async () => {
  const engine = await world(),
    f = modelFixture(engine);
  f.primitive.deformed = true;
  try {
    assert.throws(
      () => RaycastSnapshot.capture(engine, [f.model]),
      (e) => e.code === 'unsupported' && /intersectModel/.test(e.message),
    );
    assert.throws(() => query().intersectObjects(engine, [f.model]), /intersectModel/);
    // The registered-mesh path rejects with the same stable code as the model path.
    for (const objects of [[f.model], [f.node]])
      assert.throws(
        () => query().intersectObjects(engine, objects),
        (e) => e.code === 'unsupported' && /intersectModel/.test(e.message),
      );
    f.root.visible = false;
    const hidden = RaycastSnapshot.capture(engine, [f.model]);
    try {
      assert.deepEqual(hidden.intersect(query()), []);
    } finally {
      hidden.dispose();
    }
    assert.deepEqual(query().intersectObjects(engine, [f.model]), []);
  } finally {
    engine.dispose();
  }
});

test('an independent unit-quad plane oracle checks1681 hit/miss,point and UV results without reusing BVH predicates', async () => {
  const engine = await world(),
    f = modelFixture(engine),
    snapshot = RaycastSnapshot.capture(engine, [f.model]),
    ray = query();
  try {
    for (let y = 0; y < 41; y++)
      for (let x = 0; x < 41; x++) {
        const px = -1.2 + x * 0.06 + 0.013,
          py = -1.2 + y * 0.06 + 0.023;
        ray.set([px, py, 4], [0, 0, -1]);
        const hits = snapshot.intersect(ray);
        const inside = Math.abs(px) < 1 && Math.abs(py) < 1;
        assert.equal(hits.length, inside ? 1 : 0);
        if (inside) {
          assert.equal(hits[0].distance, 4);
          assert(Math.abs(hits[0].point[0] - px) < 1e-13);
          assert(Math.abs(hits[0].point[1] - py) < 1e-13);
          assert(Math.abs(hits[0].uv[0] - (px + 1) / 2) < 1e-13);
          assert(Math.abs(hits[0].uv[1] - (py + 1) / 2) < 1e-13);
        }
      }
  } finally {
    snapshot.dispose();
    engine.dispose();
  }
});

test('local BVHs preserve representable small geometry at large world translations without a Float32 world rebake', async () => {
  const engine = await world(),
    f = modelFixture(engine);
  f.root.setPosition([1e15, 0, 0]);
  const snapshot = RaycastSnapshot.capture(engine, [f.model]),
    translation = f.root.matrix[12],
    ray = new Raycaster([translation + 0.125, 0.187, 4], [0, 0, -1]);
  ray.side = 'double';
  try {
    const hits = snapshot.intersect(ray);
    assert.equal(hits.length, 1);
    same(hits, ray.intersectObjects(engine, [f.model], { refresh: false }));
    assert.equal(hits[0].point[0], translation + 0.125);
    assert(Math.abs(hits[0].uv[0] - 0.5625) < 1e-13);
  } finally {
    snapshot.dispose();
    engine.dispose();
  }
});

test('invalid buffers, instance rows and camera/query options reject atomically with actionable argument errors', async () => {
  const engine = await world(),
    f = modelFixture(engine),
    ray = query();
  try {
    assert.throws(() => RaycastSnapshot.capture(engine, [f.model], null), TypeError);
    assert.throws(() => RaycastSnapshot.capture(engine, [f.model], { refresh: 1 }), TypeError);
    assert.throws(() => RaycastSnapshot.capture(engine, [null]), TypeError);
    const original = f.primitive.indices;
    f.primitive.indices = new Uint32Array([99, 1, 2]);
    assert.throws(() => RaycastSnapshot.capture(engine, [f.model]), RangeError);
    f.primitive.indices = original;
    f.primitive.instances = { count: 2, data: new Float32Array(24) };
    assert.throws(() => RaycastSnapshot.capture(engine, [f.model]), RangeError);
    delete f.primitive.instances;
    const snapshot = RaycastSnapshot.capture(engine, [f.model]);
    try {
      for (const [key, value] of [
        ['near', Infinity],
        ['near', -1],
        ['far', NaN],
        ['layers', -1],
        ['layers', 1.5],
      ]) {
        const saved = ray[key];
        ray[key] = value;
        assert.throws(() => snapshot.intersect(ray), RangeError);
        ray[key] = saved;
      }
      ray.direction.fill(0);
      assert.throws(() => snapshot.intersect(ray), RangeError);
      assert.throws(() => snapshot.setFromCanvas(ray, NaN, 0), RangeError);
    } finally {
      snapshot.dispose();
    }
  } finally {
    engine.dispose();
  }
});

test('root handle reuse, snapshot/engine disposal inside callbacks and capture-time disposal cannot publish stale hits', async () => {
  const engine = await world(),
    f = modelFixture(engine),
    snapshot = RaycastSnapshot.capture(engine, [f.model]),
    ray = query();
  try {
    f.root.dispose();
    assert.deepEqual(snapshot.intersect(ray), []);
    const mesh = engine.createMesh().setGeometry(geometry()),
      next = RaycastSnapshot.capture(engine, [mesh]);
    ray.filter = () => {
      next.dispose();
      return true;
    };
    assert.throws(
      () => next.intersect(ray),
      (e) => e.code === 'disposed',
    );
    const iterator = {
      *[Symbol.iterator]() {
        engine.dispose();
        yield mesh;
      },
    };
    assert.throws(
      () => RaycastSnapshot.capture(engine, iterator),
      (e) => e.code === 'disposed',
    );
  } finally {
    snapshot.dispose();
    engine.dispose();
  }
});
