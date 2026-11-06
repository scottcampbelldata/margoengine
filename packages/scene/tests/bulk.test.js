// TransformWriter against the setters it stands in for, on a real engine and kernel.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { TransformWriter } from '../dist/bulk.js';

const renderer = () => ({ backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} });
const engine = async (capacity = 64) =>
  new Engine(
    { width: 16, height: 16, clientWidth: 16, clientHeight: 16 },
    await TransformStore.create(capacity),
    renderer(),
  );
const list = (e, count) => Array.from({ length: count }, () => e.createMesh());
/** Everything a mesh's transform shows: the local values, the Euler lanes and, after a tick, the world matrix. */
const state = (e, mesh) => {
  const t = e.store.transforms,
    id = mesh.id;
  return {
    position: [t.x[id], t.y[id], t.z[id]],
    quaternion: [t.qx[id], t.qy[id], t.qz[id], t.qw[id]],
    scale: [t.sx[id], t.sy[id], t.sz[id]],
    rotation: [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z],
    matrix: [...mesh.matrix],
  };
};
const rowsOf = (count, width, make) => {
  const out = new Float32Array(count * width);
  for (let i = 0; i < out.length; i++) out[i] = make(i);
  return out;
};

test('rows give bit for bit what the setters give, matrices included', async () => {
  const a = await engine(),
    b = await engine(),
    count = 40,
    fast = list(a, count),
    slow = list(b, count),
    positions = rowsOf(count, 3, (i) => Math.sin(i) * 9),
    quaternions = rowsOf(count, 4, (i) => Math.cos(i * 1.7) + 0.01),
    scales = rowsOf(count, 3, (i) => 0.5 + (i % 5));
  new TransformWriter(fast).write({ positions, quaternions, scales });
  slow.forEach((mesh, i) => {
    mesh.position.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    mesh.scale.set(scales[i * 3], scales[i * 3 + 1], scales[i * 3 + 2]);
    mesh.setQuaternion([...quaternions.subarray(i * 4, i * 4 + 4)]);
  });
  a.render();
  b.render();
  fast.forEach((mesh, i) => assert.deepEqual(state(a, mesh), state(b, slow[i]), `mesh ${i}`));
});

test('quaternions too small or too large to square by hand match setQuaternion', async () => {
  const a = await engine(),
    b = await engine(),
    rows = [
      [1e-200, 0, 0, 1e-200],
      [3e38, 1e38, 0, 2e38],
      [0.1, 0.2, 0.3, 0.4],
    ],
    fast = list(a, rows.length),
    slow = list(b, rows.length);
  new TransformWriter(fast).write({ quaternions: rows.flat() });
  slow.forEach((mesh, i) => mesh.setQuaternion(rows[i]));
  a.render();
  b.render();
  fast.forEach((mesh, i) => assert.deepEqual(state(a, mesh), state(b, slow[i]), `mesh ${i}`));
});

test('Euler rows match mesh.rotation.set', async () => {
  const a = await engine(),
    b = await engine(),
    count = 20,
    fast = list(a, count),
    slow = list(b, count),
    rotations = rowsOf(count, 3, (i) => Math.sin(i * 0.9) * 3);
  new TransformWriter(fast).write({ rotations });
  slow.forEach((mesh, i) => mesh.rotation.set(rotations[i * 3], rotations[i * 3 + 1], rotations[i * 3 + 2]));
  a.render();
  b.render();
  fast.forEach((mesh, i) => assert.deepEqual(state(a, mesh), state(b, slow[i]), `mesh ${i}`));
});

test('a written mesh moves in the next frame and the others stay', async () => {
  const e = await engine(),
    meshes = list(e, 3),
    still = e.createMesh().setPosition([9, 9, 9]);
  e.render();
  e.store.changed.fill(0);
  new TransformWriter(meshes).write({ positions: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]) });
  e.render();
  assert.deepEqual([...meshes[1].matrix.subarray(12, 15)], [4, 5, 6]);
  assert.deepEqual([...still.matrix.subarray(12, 15)], [9, 9, 9]);
});

test('the list may hold slots in any order, plain arrays work, and float64 rounds as the setter does', async () => {
  const e = await engine(),
    [a, b, c] = list(e, 3);
  new TransformWriter([c, a]).write({ positions: [0.1, 0, 0, 0.2, 0, 0] });
  assert.equal(c.position.x, Math.fround(0.1));
  assert.equal(a.position.x, Math.fround(0.2));
  assert.equal(b.position.x, 0);
});

test('a range writes those rows only, row 0 of the arrays being its first', async () => {
  const e = await engine(),
    meshes = list(e, 4),
    writer = new TransformWriter(meshes);
  assert.equal(writer.length, 4);
  assert.equal(writer.write({ positions: new Float32Array([1, 0, 0, 2, 0, 0]) }, { from: 1, count: 2 }), writer);
  assert.deepEqual(
    meshes.map((mesh) => mesh.position.x),
    [0, 1, 2, 0],
  );
  writer.write({ positions: new Float32Array([5, 0, 0]) }, { from: 3 });
  assert.equal(meshes[3].position.x, 5);
  writer.write({}, { from: 4 });
  assert.throws(() => writer.write({}, { from: 5 }), RangeError);
  assert.throws(() => writer.write({}, { from: 3, count: 2 }), RangeError);
  assert.throws(() => writer.write({}, { from: 0.5 }), RangeError);
  assert.throws(() => writer.write({}, { from: -1 }), RangeError);
});

test('a bad value anywhere changes nothing', async () => {
  const e = await engine(),
    meshes = list(e, 2),
    writer = new TransformWriter(meshes),
    good = new Float32Array([1, 1, 1, 2, 2, 2]),
    unit = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]);
  for (const rows of [
    { positions: new Float32Array([1, 1, 1, 2, Number.NaN, 2]) },
    { positions: [1, 1, 1, 2, 2, 1e39] },
    { positions: good, rotations: new Float32Array([0, 0, 0, Number.POSITIVE_INFINITY, 0, 0]) },
    { positions: good, scales: new Float32Array([1, 1, 1, 1, 0, 1]) },
    { positions: good, scales: [1, 1, 1, 1, 1e-46, 1] },
    { positions: good, scales: new Float32Array([1, 1, 1, 1, Number.NaN, 1]) },
    { positions: good, quaternions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0]) },
    { positions: good, quaternions: new Float32Array([0, 0, 0, 1, Number.NaN, 0, 0, 1]) },
    { positions: good, quaternions: unit, rotations: good },
    { positions: new Float32Array(5) },
    { positions: ['1', 1, 1, 2, 2, 2] },
  ])
    assert.throws(
      () => writer.write(rows),
      (error) => error instanceof (rows.quaternions && rows.rotations ? TypeError : RangeError),
    );
  assert.deepEqual(
    meshes.map((mesh) => mesh.position.x),
    [0, 0],
  );
  assert.equal(meshes[1].scale.y, 1);
});

test('a mesh that went is named, even when its slot now holds another mesh', async () => {
  const e = await engine(),
    meshes = list(e, 3),
    writer = new TransformWriter(meshes),
    positions = new Float32Array(9);
  meshes[1].dispose();
  const reused = e.createMesh();
  assert.equal(reused.id, meshes[1].id, 'the slot was reused');
  reused.setPosition([7, 7, 7]);
  assert.throws(
    () => writer.write({ positions }),
    (error) => error.code === 'disposed' && /row 1/.test(error.message),
  );
  assert.equal(reused.position.x, 7);
  writer.write({ positions: new Float32Array(3) }, { count: 1 });
  e.dispose();
  assert.throws(() => writer.write({ positions }), (error) => error.code === 'disposed');
});

test('a store that grew keeps working', async () => {
  const e = await engine(2),
    meshes = list(e, 2),
    writer = new TransformWriter(meshes);
  list(e, 40);
  writer.write({ positions: new Float32Array([1, 2, 3, 4, 5, 6]) });
  assert.equal(meshes[1].position.z, 6);
  assert.equal(e.store.transforms.y[meshes[0].id], 2);
});

test('a list must be meshes of one engine', async () => {
  const a = await engine(),
    b = await engine();
  assert.throws(() => new TransformWriter([]), TypeError);
  assert.throws(() => new TransformWriter('meshes'), TypeError);
  assert.throws(() => new TransformWriter([a.createMesh(), b.createMesh()]), TypeError);
  const gone = a.createMesh();
  gone.dispose();
  assert.throws(() => new TransformWriter([gone]), /Mesh disposed/);
});

test('later changes to the given list change nothing', async () => {
  const e = await engine(),
    meshes = list(e, 2),
    writer = new TransformWriter(meshes);
  meshes.reverse();
  writer.write({ positions: new Float32Array([1, 0, 0, 2, 0, 0]) });
  assert.equal(meshes[1].position.x, 1);
});
