import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore, Camera } from '../dist/extension.js';
import { snapshotMeshes, restoreSnapshot } from '../../inspector/dist/snapshot.js';

test('test-page 36: retained transform refs reject replacement and keep snapshots restorable', async () => {
  using engine = new Engine(
    { width: 32, height: 32 },
    await TransformStore.create(4),
    { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
  );
  const mesh = engine.createMesh();
  mesh.setPosition([1, 2, 3]).setRotation([0.25, 0.5, 0.75]).setScale([2, 3, 4]);
  const refs = [mesh.position, mesh.rotation, mesh.scale];
  const before = snapshotMeshes(engine, [mesh]);
  for (const [i, key] of ['position', 'rotation', 'scale'].entries()) {
    for (const value of [[0, -2.5, 0], { x: 1, y: 2, z: 3 }, refs[i], null, 0]) {
      assert.throws(
        () => { mesh[key] = value; },
        (error) => error instanceof TypeError && error.code === 'transform' &&
          error.message === 'Retained vector: use a transform setter; see https://margoengine.com/errors#transform',
      );
      assert.equal(mesh[key], refs[i]);
      assert.deepEqual(snapshotMeshes(engine, [mesh]), before);
    }
    // Reflect.set also rejects assignment from non-module callers.
    assert.throws(() => Reflect.set(mesh, key, [4, 5, 6]), TypeError);
  }
  for (let i = 0; i < 8; i++) engine.createMesh();
  assert.deepEqual([mesh.position, mesh.rotation, mesh.scale], refs);
  refs[0].set(7, 8, 9);
  refs[1].setAll(0);
  refs[2].x = 5;
  const changed = snapshotMeshes(engine, [mesh]);
  assert.deepEqual(changed.meshes[0].position, [7, 8, 9]);
  assert.deepEqual(changed.meshes[0].rotation, [0, 0, 0]);
  assert.deepEqual(changed.meshes[0].scale, [5, 3, 4]);
  assert.equal(restoreSnapshot(engine, before).applied, 1);
  assert.deepEqual(snapshotMeshes(engine, [mesh]), before);
  assert.deepEqual([mesh.position, mesh.rotation, mesh.scale], refs);
  const camera = new Camera();
  camera.position = [4, 5, 6];
  camera.target = [1, 2, 3];
  assert.deepEqual(camera.position, [4, 5, 6]);
});
