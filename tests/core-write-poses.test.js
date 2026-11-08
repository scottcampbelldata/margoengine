import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../packages/core/dist/engine.js';
import { TransformStore } from '../packages/core/dist/kernel.js';
import { box } from '../packages/core/dist/geometry.js';

const renderer = () => ({ backend: 'webgpu', add() {}, remove() {}, dispose() {}, render() {}, pick: async () => -1 });
const engineOf = async (capacity) =>
  new Engine(
    { width: 8, height: 8, clientWidth: 8, clientHeight: 8 },
    await TransformStore.create(capacity),
    renderer(),
    undefined,
    null,
  );
/** Every column writePoses and the setters write, for one entity, as bit patterns. */
function pose(engine, id) {
  const t = engine.store.transforms,
    lanes = engine.store.rotations;
  return Array.from(
    new Uint32Array(
      new Float32Array([
        t.x[id],
        t.y[id],
        t.z[id],
        t.qx[id],
        t.qy[id],
        t.qz[id],
        t.qw[id],
        lanes[id * 3],
        lanes[id * 3 + 1],
        lanes[id * 3 + 2],
      ]).buffer,
    ),
  );
}
// A fixed sequence from a small linear congruential generator: the test is the same on every run.
const generator = (seed) => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5;

test('writePoses writes the bits setPosition and setQuaternion write, Euler lanes and world matrices included', async (t) => {
  const bulk = await engineOf(64),
    single = await engineOf(64);
  t.after(() => {
    bulk.dispose();
    single.dispose();
  });
  const random = generator(11),
    count = 50,
    make = (engine) => {
      const meshes = Array.from({ length: count }, () => engine.createMesh().setGeometry(box()));
      // Parents too: rows are local to the parent, as setPosition is.
      for (let i = 10; i < count; i += 10) meshes[i].setParent(meshes[i - 1]);
      return meshes;
    },
    bulkMeshes = make(bulk),
    singleMeshes = make(single);
  for (let round = 0; round < 20; round++) {
    // Float64 values, as physics interpolates them, with odd scales so normalising is real work.
    const poses = new Float64Array(count * 7),
      ids = new Int32Array(count);
    for (let k = 0; k < count; k++) {
      ids[k] = bulkMeshes[k].id;
      for (let i = 0; i < 7; i++) poses[k * 7 + i] = random() * (i < 3 ? 2000 : 3);
      if (k === 3) poses.fill(0, k * 7 + 3, k * 7 + 6); // a quaternion of w alone
    }
    bulk.writePoses(ids, poses);
    for (let k = 0; k < count; k++)
      singleMeshes[k]
        .setPosition([poses[k * 7], poses[k * 7 + 1], poses[k * 7 + 2]])
        .setQuaternion([poses[k * 7 + 3], poses[k * 7 + 4], poses[k * 7 + 5], poses[k * 7 + 6]]);
    for (let k = 0; k < count; k++)
      assert.deepEqual(pose(bulk, bulkMeshes[k].id), pose(single, singleMeshes[k].id), `round ${round} row ${k}`);
    bulk.render();
    single.render();
    for (let k = 0; k < count; k++) assert.deepEqual(bulkMeshes[k].matrix, singleMeshes[k].matrix, `round ${round} matrix ${k}`);
  }
  // A Float32Array source and a count below its length.
  const floats = new Float32Array([1, 2, 3, 0, 0, 1, 1, 9, 9, 9, 0, 0, 0, 1]);
  bulk.writePoses([bulkMeshes[0].id, bulkMeshes[1].id], floats, 1);
  singleMeshes[0].setPosition([1, 2, 3]).setQuaternion([0, 0, 1, 1]);
  assert.deepEqual(pose(bulk, bulkMeshes[0].id), pose(single, singleMeshes[0].id));
  assert.notEqual(bulkMeshes[1].position.x, 9, 'rows past count are not written');
});

test('a bad row writes nothing, and the error names it', async (t) => {
  const engine = await engineOf(8);
  t.after(() => engine.dispose());
  const [a, b] = [engine.createMesh(), engine.createMesh()],
    gone = engine.createMesh(),
    before = () => [pose(engine, a.id), pose(engine, b.id)],
    start = before(),
    good = [5, 6, 7, 0, 0, 0, 1];
  gone.dispose();
  const cases = [
    [[a.id, b.id], [...good, 1, 2, Number.NaN, 0, 0, 0, 1], RangeError, /Invalid transform: 1/],
    [[a.id, b.id], [...good, 1, 2, 3e39, 0, 0, 0, 1], RangeError, /Invalid transform: 1/],
    [[a.id, b.id], [...good, 1, 2, 3, 0, 0, 0, 0], RangeError, /Quaternion nonzero: 1/],
    [[a.id, b.id], [...good, 1, 2, 3, '0', 0, 0, 1], RangeError, /Invalid transform: 1/],
    [[a.id, gone.id], [...good, ...good], Error, /Mesh disposed/],
    [[a.id, 99], [...good, ...good], Error, /Mesh disposed/],
    [[a.id, -1], [...good, ...good], Error, /Mesh disposed/],
    [[a.id, b.id], good, RangeError, /Invalid poses/],
  ];
  for (const [ids, poses, type, message] of cases) {
    assert.throws(() => engine.writePoses(ids, poses), (error) => error instanceof type && message.test(error.message));
    assert.deepEqual(before(), start, `nothing written for ${message}`);
  }
  engine.writePoses([a.id], good);
  assert.deepEqual([a.position.x, a.position.y, a.position.z], [5, 6, 7]);
  engine.dispose();
  assert.throws(() => engine.writePoses([a.id], good), /Engine disposed/);
});

test('writePoses looks up no mesh: one call for 1,000 meshes reads the active column only', async (t) => {
  const engine = await engineOf(1024);
  t.after(() => engine.dispose());
  const meshes = Array.from({ length: 1000 }, () => engine.createMesh()),
    ids = Int32Array.from(meshes, (mesh) => mesh.id),
    poses = new Float64Array(7000);
  for (let k = 0; k < 1000; k++) poses.set([k, 0, 0, 0, 0, 0, 1], k * 7);
  let lookups = 0;
  engine.meshes.get = (key) => {
    lookups++;
    return Map.prototype.get.call(engine.meshes, key);
  };
  engine.writePoses(ids, poses);
  assert.equal(lookups, 0);
  delete engine.meshes.get;
  assert.equal(meshes[999].position.x, 999);
});
