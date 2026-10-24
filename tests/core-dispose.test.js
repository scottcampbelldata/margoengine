import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../packages/core/dist/engine.js';
import { TransformStore } from '../packages/core/dist/kernel.js';
import { box } from '../packages/core/dist/geometry.js';

// `using` (explicit resource management): Symbol.dispose is dispose() on Engine, Mesh and Scene.
const create = async () =>
  new Engine(
    { width: 8, height: 8, clientWidth: 8, clientHeight: 8 },
    await TransformStore.create(4),
    { backend: 'webgpu', add() {}, remove() {}, dispose() {}, render() {}, pick: async () => -1 },
    undefined,
    null,
  );

test('using disposes meshes, scenes and the engine at the end of the block', async () => {
  let engine, mesh, scene;
  {
    using e = await create();
    engine = e;
    {
      using m = engine.createMesh().setGeometry(box());
      using s = engine.createScene('hud');
      mesh = m;
      scene = s;
      assert.equal(engine.meshes.has(m.id), true);
    }
    assert.equal(engine.meshes.has(mesh.id), false, 'the mesh is disposed when its block ends');
    assert.equal(engine.scenes.has(scene), false, 'the scene is disposed when its block ends');
    assert.equal(engine.disposed, false);
  }
  assert.equal(engine.disposed, true, 'the engine is disposed when its block ends');
});

test('Symbol.dispose is dispose(), and disposing twice is harmless', async () => {
  const engine = await create(),
    mesh = engine.createMesh();
  assert.equal(engine[Symbol.dispose], engine.dispose);
  assert.equal(mesh[Symbol.dispose], mesh.dispose);
  mesh[Symbol.dispose]();
  mesh.dispose();
  engine[Symbol.dispose]();
  engine.dispose();
  assert.equal(engine.disposed, true);
});
