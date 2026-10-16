import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';

// One table exercises both existing quaternion writers: immediate JavaScript
// rotation setters and the Rust tick after clamping the same stored XYZ angles.
const rotations = [
  ['identity', [0, 0, 0]],
  ['positive X quarter turn', [Math.PI / 2, 0, 0]],
  ['negative Y quarter turn', [0, -Math.PI / 2, 0]],
  ['positive Z half turn', [0, 0, Math.PI]],
  ['mixed positive angles', [0.2, 0.7, 1.1]],
  ['mixed signed angles', [-0.35, 1.2, -2.1]],
  ['near gimbal lock', [0.75, Math.PI / 2 - 1e-5, -0.4]],
  ['negative half turns', [-Math.PI, -Math.PI, -Math.PI]],
  ['full turns', [2 * Math.PI, -2 * Math.PI, 4 * Math.PI]],
  ['small angles', [1e-7, -2e-6, 3e-5]],
];
const lanes = ['qx', 'qy', 'qz', 'qw'];

async function engineFor(capacity) {
  const store = await TransformStore.create(capacity);
  return new Engine(
    { width: 16, height: 16, clientWidth: 16, clientHeight: 16 },
    store,
    { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
    undefined,
    null,
  );
}

test('the shared XYZ quaternion table matches immediate Mesh.setRotation and a clamped kernel tick', async () => {
  const engine = await engineFor(2),
    store = engine.store,
    immediate = engine.createMesh(),
    clamped = engine.createMesh();
  try {
    for (const [label, angles] of rotations) {
      immediate.setRotation(angles);
      const beforeTick = lanes.map((lane) => store.transforms[lane][immediate.id]);
      for (let axis = 0; axis < 3; axis++) {
        const value = Math.fround(angles[axis]),
          at = clamped.id * 12 + (axis + 3) * 2;
        store.rotations[clamped.id * 3 + axis] = value + 1.25;
        store.limits[at] = value;
        store.limits[at + 1] = value;
      }
      // A valid but unrelated quaternion proves tick recomputes rather than
      // leaving a quaternion previously supplied by the JavaScript writer.
      for (let lane = 0; lane < 4; lane++) store.transforms[lanes[lane]][clamped.id] = lane === 0 ? 1 : 0;
      store.constrained[clamped.id] = 56;
      store.tick(false);
      assert.deepEqual([...clamped.euler], angles.map(Math.fround), label + ' clamps all three Euler lanes');
      for (let lane = 0; lane < 4; lane++)
        assert.ok(
          Math.abs(store.transforms[lanes[lane]][clamped.id] - beforeTick[lane]) <= 1e-7,
          label + ' ' + lanes[lane] + ' differs between the JavaScript and Rust writers',
        );
      assert.deepEqual(
        lanes.map((lane) => store.transforms[lane][immediate.id]),
        beforeTick,
        label + ' unbounded quaternion is not rewritten by tick',
      );
      for (let entry = 0; entry < 16; entry++)
        assert.ok(Math.abs(immediate.matrix[entry] - clamped.matrix[entry]) <= 5e-7, label + ' matrix lane ' + entry);
    }
  } finally {
    engine.dispose();
  }
});

test('fixed kernel layout publishes hierarchy matrices into the existing JavaScript views', async () => {
  const engine = await engineFor(2),
    store = engine.store,
    parent = engine.createMesh().setPosition([2, 3, 4]).setScale([2, 2, 2]),
    child = engine.createMesh(parent).setPosition([1, 0, 0]);
  try {
    const offset = store.transforms.x.byteOffset,
      buffer = store.transforms.x.buffer;
    assert.equal(store.parents.byteOffset, offset + 10 * store.capacity * 4);
    assert.equal(store.matrices.byteOffset, offset + 11 * store.capacity * 4);
    assert.equal(store.bounds.byteOffset, offset + 27 * store.capacity * 4);
    store.bounds.set([0, 0, 0, 1], child.id * 4);
    const published = child.matrix;
    store.tick(false);
    assert.equal(store.parents[child.id], parent.id);
    assert.equal(child.matrix, published);
    assert.equal(published.buffer, buffer);
    assert.deepEqual([...published.subarray(12, 15)], [4, 3, 4]);
    assert.deepEqual([...store.bounds.subarray(child.id * 4, child.id * 4 + 4)], [0, 0, 0, 1]);
    const worldSphere = new Float32Array(buffer, offset + 31 * store.capacity * 4, 4 * store.capacity);
    assert.deepEqual(
      [0, 1, 2, 3].map((field) => worldSphere[field * store.capacity + child.id]),
      [4, 3, 4, 2],
    );
  } finally {
    engine.dispose();
  }
});
