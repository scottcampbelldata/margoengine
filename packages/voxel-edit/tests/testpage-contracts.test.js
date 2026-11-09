import test from 'node:test';
import assert from 'node:assert/strict';
import { Geometry } from '@margoengine/core';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { meshGrid } from '../dist/mesh.js';
import { VoxelHistory } from '../dist/history.js';

test('empty voxel mesh clears and restores an existing core mesh with an empty Geometry', async () => {
  using engine = new Engine({ width: 10, height: 10 }, await TransformStore.create(8), {
    backend: 'webgl2',
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });
  const grid = { size: [1, 1, 1], voxels: new Uint8Array([1]) },
    node = engine.createMesh();
  const update = () => {
    const { mesh } = meshGrid(grid);
    node.setGeometry(new Geometry(mesh.positions, mesh.normals, mesh.indices));
  };
  update();
  assert.ok(node.geometry);
  const id = node.id;
  grid.voxels.fill(0);
  update();
  assert.equal(node.geometry.indices.length, 0);
  assert.equal(node.id, id);
  node.check();
  grid.voxels[0] = 1;
  update();
  assert.ok(node.geometry);
  assert.equal(node.id, id);
});

