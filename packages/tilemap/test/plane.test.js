import assert from 'node:assert/strict';
import test from 'node:test';
import { PlaneTileMap } from '../dist/plane.js';
const map = { width: 1, height: 1, tileWidth: 16, tileHeight: 16, tilesets: [], layers: [] };
test('plane defaults use metres, downward map y, depth testing/writes and no screen snap', () => {
  const plane = new PlaneTileMap({ map, atlases: {} });
  assert.equal(plane.transform[0], 1 / 16);
  assert.equal(plane.transform[5], -1 / 16);
  assert.equal(plane.snap, false);
  assert.equal(plane.parallax, false);
  assert.equal(plane.depthTest, true);
  assert.equal(plane.depthWrite, true);
  plane.dispose();
});
test('plane transform ownership and validation are independent of the caller buffer', () => {
  const transform = [1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 3, 2, 1, 1];
  const plane = new PlaneTileMap({ map, atlases: {}, transform });
  transform[12] = 10;
  assert.equal(plane.transform[12], 3);
  for (const bad of [
    [],
    Array(16).fill(0),
    [...plane.transform].map((v, i) => (i === 3 ? 1 : v)),
    [...plane.transform].map((v, i) => (i === 0 ? Infinity : v)),
  ])
    assert.throws(() => new PlaneTileMap({ map, atlases: {}, transform: bad }), RangeError);
  plane.dispose();
});
test('plane projection composes the active core camera and full affine basis in column order', () => {
  const transform = [1, 2, 3, 0, 4, 5, 7, 0, 0, 0, 1, 0, 8, 9, 10, 1];
  const camera = Float32Array.from([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, -1, 1, 2, 3, 1]);
  const plane = new PlaneTileMap({ map, atlases: {}, transform });
  const p = plane.projection({ camera: { matrix: camera } }, 10, 10);
  assert.deepEqual([...p], [2, 6, 12, -3, 8, 15, 28, -7, 0, 0, 4, -1, 17, 29, 43, -9]);
  plane.transform[0] = Number.NaN;
  assert.throws(() => plane.projection({ camera: { matrix: camera } }, 10, 10), RangeError);
  plane.dispose();
});
test('plane depth shares the active view, keeps existing pixels and permits coplanar layer order', () => {
  const plane = new PlaneTileMap({ map, atlases: {} }),
    view = {};
  const d = plane.depth({ depth: view, descriptor: { depthStencil: { format: 'depth24plus-stencil8' } } });
  assert.equal(d.attachment.view, view);
  assert.equal(d.attachment.depthLoadOp, 'load');
  assert.equal(d.state.depthCompare, 'greater-equal');
  plane.depthTest = false;
  plane.depthWrite = false;
  assert.equal(
    plane.depth({ depth: view, descriptor: { depthStencil: { format: 'depth32float' } } }).state.depthCompare,
    'always',
  );
  assert.equal(
    plane.depth({ depth: view, descriptor: { depthStencil: { format: 'depth32float' } } }).state.depthWriteEnabled,
    false,
  );
  assert.throws(() => plane.depth({ descriptor: {} }), RangeError);
  plane.dispose();
});
