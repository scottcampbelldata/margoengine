// Synchronous queries against a primitive a GPU deformer writes: they test the pose the deformer evaluates on the CPU
// (packages/shared/pose-source.js), never the bind pose, and refit one tree as the pose changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { Raycaster, RaycastSnapshot, getPrimitiveBVH, hasPrimitiveBVH } from '../dist/index.js';
import { SceneBVH } from '../dist/scene.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { setMeshSource } from '../../shared/mesh-source.js';
import { clearPoseSource, setPoseSource } from '../../shared/pose-source.js';
import { bruteRay, bumpySphere, rng } from './reference.js';

async function world() {
  const h = optionalGPU();
  return new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    await TransformStore.create(64),
    { backend: 'webgpu', gpu: h.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
}

// A bumpy sphere as a gltf/pbr primitive, and a deformer stand-in: it bends and moves the sphere on the CPU the way a
// skin would, into one array, and counts its evaluations.
function character(engine, node) {
  const shape = bumpySphere(rng(5)),
    count = shape.positions.length / 3,
    vertices = new Float32Array(count * 20);
  for (let i = 0; i < count; i++) {
    vertices.set(shape.positions.subarray(i * 3, i * 3 + 3), i * 20);
    vertices.set(shape.normals.subarray(i * 3, i * 3 + 3), i * 20 + 4);
    vertices.set([i / count, 1 - i / count], i * 20 + 12);
  }
  const primitive = {
      node,
      vertices,
      indices: shape.indices,
      nodeIndex: 3,
      material: { settings: new Float32Array([0, 0, 1]) },
      deformed: {},
    },
    model = { root: node, primitives: [primitive], disposed: false },
    posed = vertices.slice(),
    deformer = { shift: [0, 0, 0], bend: 0, revision: 0, key: '', evaluations: 0 };
  const source = () => {
    const key = deformer.shift + ':' + deformer.bend;
    if (key !== deformer.key) {
      deformer.key = key;
      deformer.revision++;
      deformer.evaluations++;
      for (let i = 0; i < count; i++) {
        const [x, y, z] = vertices.subarray(i * 20, i * 20 + 3),
          angle = deformer.bend * y,
          c = Math.cos(angle),
          s = Math.sin(angle);
        posed[i * 20] = x * c - z * s + deformer.shift[0];
        posed[i * 20 + 1] = y * (1 + deformer.bend) + deformer.shift[1];
        posed[i * 20 + 2] = x * s + z * c + deformer.shift[2];
      }
    }
    return { vertices: posed, revision: deformer.revision };
  };
  setMeshSource(node, { model, primitives: [primitive] });
  setPoseSource(primitive, source);
  return { primitive, model, posed, deformer, source, count };
}

/** The posed triangles in world space (float64), for a brute-force scan. */
function worldMesh(engine, f) {
  engine.store.tick(false);
  const m = engine.store.matrices.subarray(f.primitive.node.id * 16, f.primitive.node.id * 16 + 16),
    positions = new Float64Array(f.count * 3);
  for (let i = 0; i < f.count; i++) {
    const [x, y, z] = f.posed.subarray(i * 20, i * 20 + 3);
    for (let r = 0; r < 3; r++) positions[i * 3 + r] = m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r];
  }
  return { positions, indices: f.primitive.indices, centre: [m[12], m[13], m[14]] };
}

function rays(random, mesh, shift, n) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const around = () => (random() * 2 - 1) * 4,
      origin = [shift[0] + around(), shift[1] + around(), shift[2] + around()],
      target = shift.map((v) => v + (random() * 2 - 1) * 0.9);
    out.push({ origin, direction: target.map((v, i) => v - origin[i]) });
  }
  return out;
}

const strip = (hits) => hits.map((h) => [h.mesh.id, h.distance, h.faceIndex, h.primitiveIndex, h.nodeIndex, h.uv]);

test('synchronous raycasts hit a GPU-deformed primitive at its current pose, against a brute-force scan', async () => {
  const engine = await world(),
    node = engine.createMesh().setPosition([3, -2, 1]).setRotation([0.3, -0.5, 0.2]).setScale([1.5, 0.8, 1.2]),
    f = character(engine, node),
    random = rng(11),
    ray = new Raycaster();
  ray.side = 'double';
  let hits = 0;
  // Each pose is far outside the bind-pose bounds (a sphere of radius about 1 at the node).
  for (const [shift, bend] of [
    [[6, 0, 0], 0.4],
    [[-5, 7, 2], -0.9],
    [[0, -9, -4], 1.3],
  ]) {
    f.deformer.shift = shift;
    f.deformer.bend = bend;
    f.source();
    const mesh = worldMesh(engine, f),
      centre = (() => {
        const sum = [0, 0, 0];
        for (let i = 0; i < mesh.positions.length; i++) sum[i % 3] += mesh.positions[i] / f.count;
        return sum;
      })();
    for (const { origin, direction } of rays(random, mesh, centre, 150)) {
      ray.set(origin, direction);
      const unit = Array.from(ray.direction),
        expected = bruteRay(mesh, { origin, direction: unit }, { side: 'double' });
      for (const objects of [[f.model], [node]]) {
        ray.firstHitOnly = false;
        const actual = ray.intersectObjects(engine, objects);
        assert.equal(actual.length, expected.length);
        actual.forEach((hit, i) => {
          assert.ok(Math.abs(hit.distance - expected[i].distance) < 1e-4, `${hit.distance} ${expected[i].distance}`);
          assert.equal(hit.model, f.model);
          assert.equal(hit.primitive, f.primitive);
          assert.equal(hit.primitiveIndex, 0);
          assert.equal(hit.nodeIndex, 3);
          assert.equal(hit.mesh, node);
          assert.equal(hit.uv.length, 2);
        });
        ray.firstHitOnly = true;
        const first = ray.intersectObjects(engine, objects);
        assert.equal(first.length, Math.min(1, expected.length));
        if (first.length) assert.ok(Math.abs(first[0].distance - expected[0].distance) < 1e-4);
        hits += actual.length;
      }
    }
    // The bind pose answers nothing: a ray through the node's origin, where the undeformed sphere sits.
    ray.firstHitOnly = false;
    ray.set([mesh.centre[0], mesh.centre[1], mesh.centre[2] + 3], [0, 0, -1]);
    ray.far = 6;
    assert.deepEqual(ray.intersectObjects(engine, [f.model]), []);
    ray.far = Infinity;
  }
  assert.ok(hits > 600, `${hits} hits`);
});

test('a new pose refits the one tree and costs one evaluation; an unchanged pose costs neither', async () => {
  const engine = await world(),
    f = character(engine, engine.createMesh()),
    ray = new Raycaster([0.13, 0.21, 5], [0, 0, -1]);
  assert.equal(hasPrimitiveBVH(f.primitive), false);
  assert.equal(ray.intersectObjects(engine, [f.model]).length, 2);
  const tree = getPrimitiveBVH(f.primitive);
  assert.equal(hasPrimitiveBVH(f.primitive), true);
  assert.deepEqual([tree.revision, f.deformer.evaluations], [0, 1]);
  for (let k = 0; k < 20; k++) ray.intersectObjects(engine, [f.model]);
  assert.deepEqual([tree.revision, f.deformer.evaluations], [0, 1]);
  f.deformer.shift = [20, 0, 0];
  assert.deepEqual(ray.intersectObjects(engine, [f.model]), []);
  ray.set([20.13, 0.21, 5], [0, 0, -1]);
  assert.equal(ray.intersectObjects(engine, [f.model]).length, 2);
  assert.equal(getPrimitiveBVH(f.primitive), tree, 'the same tree, refitted');
  assert.deepEqual([tree.revision, f.deformer.evaluations], [1, 2]);
  // The tree reads the posed array, not the primitive's bind vertices.
  assert.equal(tree.positions, f.posed);
  // No longer deformed: the bind pose is the mesh again, with its own tree.
  f.primitive.deformed = undefined;
  ray.set([0.13, 0.21, 5], [0, 0, -1]);
  assert.equal(ray.intersectObjects(engine, [f.model]).length, 2);
  assert.notEqual(getPrimitiveBVH(f.primitive), tree);
});

test('SceneBVH and RaycastSnapshot follow the same pose, and a deformer with no CPU pose still refuses', async () => {
  const engine = await world(),
    node = engine.createMesh().setPosition([1, 2, 3]),
    f = character(engine, node),
    ray = new Raycaster([1.13, 2.21, 9], [0, 0, -1]),
    scene = new SceneBVH(engine, { objects: [f.model] });
  ray.side = 'double';
  const live = () => strip(ray.intersectObjects(engine, [f.model]));
  assert.equal(live().length, 2);
  assert.deepEqual(strip(scene.intersect(ray)), live());
  const snapshot = RaycastSnapshot.capture(engine, [f.model]);
  assert.deepEqual(strip(snapshot.intersect(ray)), live());
  const captured = live();

  f.deformer.shift = [0, 30, 0];
  assert.deepEqual(live(), []);
  assert.equal(scene.update(), 'refit');
  assert.deepEqual(scene.intersect(ray), []);
  ray.set([1.13, 32.21, 9], [0, 0, -1]);
  assert.equal(live().length, 2);
  assert.deepEqual(strip(scene.intersect(ray)), live());
  // The snapshot keeps the pose it captured.
  assert.deepEqual(snapshot.intersect(ray), []);
  ray.set([1.13, 2.21, 9], [0, 0, -1]);
  assert.deepEqual(strip(snapshot.intersect(ray)), captured);
  snapshot.dispose();

  clearPoseSource(f.primitive, f.source);
  const unsupported = (e) => e.code === 'unsupported' && /intersectModel/.test(e.message);
  assert.throws(() => ray.intersectObjects(engine, [f.model]), unsupported);
  assert.throws(() => ray.intersectObjects(engine, [node]), unsupported);
  assert.throws(() => scene.intersect(ray), unsupported);
  assert.throws(() => RaycastSnapshot.capture(engine, [f.model]), unsupported);
  node.visible = false;
  assert.deepEqual(ray.intersectObjects(engine, [f.model]), []);
  assert.deepEqual(scene.intersect(ray), []);
});

test('a posed array of the wrong size is refused, not read past its end', async () => {
  const engine = await world(),
    f = character(engine, engine.createMesh());
  setPoseSource(f.primitive, () => ({ vertices: new Float32Array(20), revision: 1 }));
  assert.throws(() => new Raycaster([0.13, 0.21, 5], [0, 0, -1]).intersectObjects(engine, [f.model]), TypeError);
});
