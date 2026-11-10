import test from 'node:test';
import assert from 'node:assert/strict';
import { coveragePolygons } from '../src/planar-coverage.ts';
import { SoftwareDepthBuffer } from '../dist/webgl2.js';
const vertices = () =>
  new Float32Array([-1, -1, 0.8, 0, 0, 1, 1, -1, 0.8, 0, 0, 1, 1, 1, 0.8, 0, 0, 1, -1, 1, 0.8, 0, 0, 1]);
const indices = new Uint32Array([0, 1, 2, 0, 2, 3]),
  I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
test('exactly coplanar convex neighbours lose their shared diagonal', () => {
  assert.equal(coveragePolygons({ vertices: vertices(), indices }).length, 1);
});
test('folds, concavities and inconsistent winding are never filled by a convex patch', () => {
  const folded = vertices();
  folded[20] = Math.fround(0.8) + 1e-6;
  assert.equal(coveragePolygons({ vertices: folded, indices }).length, 2);
  const concave = vertices();
  concave[12] = -0.5;
  concave[13] = -0.5;
  assert.equal(coveragePolygons({ vertices: concave, indices }).length, 2);
  assert.equal(coveragePolygons({ vertices: vertices(), indices: new Uint32Array([0, 1, 2, 0, 3, 2]) }).length, 2);
});
test('cached coverage refreshes after positions or indices change in place', () => {
  const geometry = { vertices: vertices(), indices: indices.slice() },
    depth = new SoftwareDepthBuffer(32, 32);
  depth.clear(I);
  depth.rasterize(geometry, I, true);
  assert.equal(depth.visible([-0.01, -0.01, 0.2, 0.01, 0.01, 0.3], I), false);
  geometry.vertices[12] = -0.5;
  geometry.vertices[13] = -0.5;
  depth.clear(I);
  depth.rasterize(geometry, I, true);
  assert.equal(depth.visible([-0.01, -0.01, 0.2, 0.01, 0.01, 0.3], I), true, 'a concave gap stays open');
  geometry.indices = new Uint32Array([0, 1, 2]);
  depth.clear(I);
  depth.rasterize(geometry, I, true);
  assert.equal(depth.visible([-0.9, 0.8, 0.2, -0.8, 0.9, 0.3], I), true);
});
