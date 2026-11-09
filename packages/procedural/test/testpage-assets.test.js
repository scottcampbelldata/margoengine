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

