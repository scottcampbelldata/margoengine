import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshBVH, buildAsync, buildBVH } from '../dist/index.js';
import { buildParallel } from '@margoengine/bvh/parallel';
import { BrowserWorker } from './worker-adapter.js';

test('all builders already preserve caller face order, indexed and nonindexed, through queries/refit/serialization', {
  timeout: 30000,
}, async () => {
  // Deliberately spatially scramble faces so the private leaf order differs from editor face order.
  const xs = [6, 0, 8, 2, 10, 4],
    positions = Float32Array.from(xs.flatMap((x) => [x, 0, 0, x + 1, 0, 0, x, 1, 0]));
  for (const indices of [
    undefined,
    Uint32Array.from({ length: 18 }, (_, i) => i),
    Uint16Array.from({ length: 18 }, (_, i) => i),
  ]) {
    const source = { positions, indices },
      before = indices?.slice(),
      vertices = positions.slice();
    const data = buildBVH(positions, 3, indices ?? null, { maxLeafTriangles: 1 });
    const trees = [
      new MeshBVH(data, source),
      MeshBVH.build(source, { maxLeafTriangles: 1 }),
      await buildAsync(source, { maxLeafTriangles: 1 }),
    ];
    globalThis.Worker = BrowserWorker;
    try {
      trees.push(await buildParallel(source, { maxLeafTriangles: 1, workers: 2 }));
    } finally {
      delete globalThis.Worker;
    }
    for (const tree of trees) {
      assert.notDeepEqual(
        [...tree.triangles],
        xs.map((_, i) => i),
      );
      assert.notEqual(tree.index, indices);
      const roundtrip = MeshBVH.fromArrayBuffer(tree.toArrayBuffer(), source);
      for (const value of [tree, roundtrip]) {
        value.refit();
        for (let face = 0; face < xs.length; face++) {
          const point = [xs[face] + 0.2, 0.2, 0];
          assert.equal(value.raycastFirst({ origin: [point[0], point[1], 1], direction: [0, 0, -1] }).faceIndex, face);
          assert.equal(value.closestPointToPoint(point).faceIndex, face);
        }
        const faces = [];
        value.shapecast({
          intersectsBounds: () => true,
          intersectsTriangle: (_, face) => {
            faces.push(face);
          },
        });
        assert.deepEqual(
          faces.sort((a, b) => a - b),
          xs.map((_, i) => i),
        );
      }
    }
    assert.equal(source.indices, indices);
    assert.deepEqual(indices, before);
    assert.deepEqual(positions, vertices);
    assert.equal('indices' in source && source.indices !== undefined, indices !== undefined);
  }
});
