import test from 'node:test';
import assert from 'node:assert/strict';
import { Geometry, PbrMaterial } from '@margoengine/core';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { generateCabinMesh, generateTreeMesh } from '../dist/index.js';
import { createTree } from '../dist/tree.js';

test('cabin elevation is metadata and every iterable part constructs a Geometry', () => {
  const cabin = generateCabinMesh(() => 2);
  assert.ok(Math.abs(cabin.floorElevation - 2.28) < 1e-9);
  assert.equal('floor' in cabin, false);
  assert.deepEqual(Object.keys(cabin.parts), ['siding', 'roof', 'foundation', 'glass']);
  for (const data of Object.values(cabin.parts)) {
    assert.ok(new Geometry(data.positions, data.normals, data.indices).indices.length > 0);
  }
});

test('single-call tree places both parts under one movable root and removes them together', async () => {
  using engine = new Engine({ width: 10, height: 10 }, await TransformStore.create(64), {
    backend: 'webgl2',
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });
  const material = new PbrMaterial();
  for (const kind of ['broadleaf', 'conifer'])
    for (const detail of [0, 1, 2]) {
      const generated = generateTreeMesh(kind, { detail });
      const tree = createTree(engine, kind, { position: [4, 2, -7], detail, trunkMaterial: material });
      assert.equal(engine.meshes.size, 3);
      assert.equal(tree.root.geometry, null);
      assert.equal(tree.trunk.material, material);
      for (const name of ['trunk', 'canopy']) {
        assert.equal(engine.store.parents[tree[name].id], tree.root.id);
        assert.equal(tree[name].geometry.indices.length, generated[name].indices.length);
      }
      engine.store.tick();
      for (const name of ['root', 'trunk', 'canopy']) {
        const matrix = engine.store.matrices.subarray(tree[name].id * 16, tree[name].id * 16 + 16);
        assert.deepEqual([...matrix.slice(12, 15)], [4, 2, -7]);
      }
      tree.root.position.x = 8;
      engine.store.tick();
      assert.equal(engine.store.matrices[tree.canopy.id * 16 + 12], 8);
      tree.dispose();
      tree[Symbol.dispose]();
      assert.equal(engine.meshes.size, 0);
    }
  assert.throws(() => createTree(engine, 'broadleaf', { position: [NaN, 0, 0] }), { code: 'failed' });
  assert.throws(() => createTree(engine, 'broadleaf', { canopyMaterial: {} }), { code: 'failed' });
  assert.equal(engine.meshes.size, 0);
});
