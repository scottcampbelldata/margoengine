import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../packages/core/dist/engine.js';
import { TransformStore } from '../packages/core/dist/kernel.js';
import { box } from '../packages/core/dist/geometry.js';

// setQuaternion runs for every moving physics body and animated node each frame, so it must not build arrays:
// no spread (array iteration), no map, no destructuring of a fresh array.
test('setQuaternion normalizes and writes the rotation without building arrays', async (t) => {
  const renderer = { backend: 'webgpu', add() {}, remove() {}, dispose() {}, render() {}, pick: async () => -1 };
  const engine = new Engine(
    { width: 8, height: 8, clientWidth: 8, clientHeight: 8 },
    await TransformStore.create(4),
    renderer,
    undefined,
    null,
  );
  t.after(() => engine.dispose());
  const mesh = engine.createMesh().setGeometry(box()),
    q = [0, 0, 2 * Math.SQRT1_2, 2 * Math.SQRT1_2],
    counts = { iterate: 0, map: 0 },
    iterate = Array.prototype[Symbol.iterator],
    map = Array.prototype.map;
  mesh.setQuaternion(q); // warm up outside the count
  Array.prototype[Symbol.iterator] = function (...args) {
    counts.iterate++;
    return iterate.apply(this, args);
  };
  Array.prototype.map = function (...args) {
    counts.map++;
    return map.apply(this, args);
  };
  try {
    for (let i = 0; i < 1000; i++) mesh.setQuaternion(q);
  } finally {
    Array.prototype[Symbol.iterator] = iterate;
    Array.prototype.map = map;
  }
  assert.deepEqual(counts, { iterate: 0, map: 0 });
  // Normalized: a 90-degree turn about Z.
  assert.ok(Math.abs(mesh.rotation.z - Math.PI / 2) < 1e-6, String(mesh.rotation.z));
  assert.throws(
    () => mesh.setQuaternion([0, 0, 0, 0]),
    /Quaternion nonzero; see https:\/\/margoengine\.com\/errors#transform/,
  );
});
