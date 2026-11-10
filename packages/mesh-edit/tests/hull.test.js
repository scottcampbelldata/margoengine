import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrimitiveMesh, compilePolygonMesh } from '@margoengine/mesh-edit';
import { convexMeshHull, minkowskiSumMeshes } from '@margoengine/mesh-edit/hull';
import { batchBooleanMeshes } from '@margoengine/mesh-edit/boolean-batch';
import { booleanMeshesExact } from '@margoengine/mesh-edit/boolean-exact';
import { assertClosed, assertNoDegenerate, ids, volume } from './topology-helpers.js';

const cube = (scale = 1, shift = [0, 0, 0]) => {
  const mesh = createPrimitiveMesh('cube', 'box');
  mesh.vertices = mesh.vertices.map((p) => p.map((x, k) => x * scale + shift[k]));
  return mesh;
};
const approx = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const lShape = () => batchBooleanMeshes([cube(), cube(1, [1, 0, 0]), cube(1, [0, 1, 0])], 'union', ids('L')).mesh;

test('mesh hull envelops a collection, ignores interior points and owns double positions', () => {
  const a = cube(1, [1e9, 0, 0]),
    b = cube(1, [1e9 + 1, 0, 0]);
  a.vertices.push([1e9, 0, 0]);
  const before = structuredClone([a, b]),
    result = convexMeshHull([a, b], ids());
  assertClosed(result);
  assertNoDegenerate(result);
  compilePolygonMesh(result);
  approx(volume({ ...result, vertices: result.vertices.map(([x, y, z]) => [x - 1e9, y, z]) }), 2);
  assert.equal(result.vertices.length, 8);
  assert.ok(result.vertices.every((p) => before.some((m) => m.vertices.some((q) => q.every((x, k) => x === p[k])))));
  result.vertices[0][0] = 0;
  assert.deepEqual([a, b], before);
});

test('empty and flat mesh hulls are empty solids', () => {
  assert.deepEqual(convexMeshHull([]), { vertices: [], faces: [] });
  const plane = createPrimitiveMesh('plane', 'sheet');
  assert.equal(convexMeshHull(plane).faces.length, 0);
});

test('convex Minkowski sum equals vertex-pair hull, without decomposition triples', () => {
  const a = cube(),
    b = cube(2),
    before = structuredClone([a, b]),
    result = minkowskiSumMeshes(a, b, ids());
  assertClosed(result.mesh);
  assertNoDegenerate(result.mesh);
  approx(volume(result.mesh), 27);
  assert.deepEqual(result.cells, [1, 1]);
  assert.equal(result.convexPairs, 1);
  assert.equal(result.planeTriples, 0);
  assert.deepEqual([a, b], before);
  assert.equal(new Set(result.mesh.faces.map((f) => f.id)).size, result.mesh.faces.length);
});

test('nonconvex plus convex retains the concave region, instead of taking a convex envelope', () => {
  const a = lShape(),
    result = minkowskiSumMeshes(a, cube(), ids('sum'));
  assertClosed(result.mesh);
  compilePolygonMesh(result.mesh);
  approx(volume(result.mesh), 16);
  assert.ok(result.cells[0] > 1);
  assert.equal(result.cells[1], 1);
  assert.ok(result.planeTriples > 0);
  assert.ok(volume(convexMeshHull(result.mesh)) > volume(result.mesh));
  const reverse = minkowskiSumMeshes(cube(), a, ids('reverse'));
  approx(volume(reverse.mesh), volume(result.mesh));
  assertClosed(reverse.mesh);
});

test('two nonconvex operands preserve the stair-step complement', () => {
  const a = lShape(),
    result = minkowskiSumMeshes(a, a, ids('sum'));
  assertClosed(result.mesh);
  approx(volume(result.mesh), 26);
  assert.ok(result.cells.every((n) => n > 1));
  assert.equal(result.convexPairs, result.cells[0] * result.cells[1]);
});

test('cavities shrink while the exterior expands, and disconnected solids stay disconnected', () => {
  const hollow = booleanMeshesExact(cube(3), cube(), 'difference', ids('hole')).mesh,
    result = minkowskiSumMeshes(hollow, cube(0.2), ids('sum'));
  assertClosed(result.mesh);
  approx(volume(result.mesh), 3.2 ** 3 - 0.8 ** 3);
  assert.ok(result.cells[0] > 1);
  const separate = batchBooleanMeshes([cube(), cube(1, [4, 0, 0])], 'union', ids('separate')).mesh,
    sum = minkowskiSumMeshes(separate, cube(), ids('out'));
  assertClosed(sum.mesh);
  approx(volume(sum.mesh), 16);
});

test('rotated convex operands and translation covariance retain their source geometry', () => {
  const a = cube(),
    b = createPrimitiveMesh('wedge', 'w');
  b.vertices = b.vertices.map(([x, y, z]) => [(x - y) / Math.sqrt(2), (x + y) / Math.sqrt(2), z]);
  const pairPoints = a.vertices.flatMap((p) => b.vertices.map((q) => p.map((x, k) => x + q[k]))),
    expected = convexMeshHull({ vertices: pairPoints, faces: [] }, ids('expected')),
    sum = minkowskiSumMeshes(a, b, ids('sum'));
  assertClosed(sum.mesh);
  approx(volume(sum.mesh), volume(expected));
  a.vertices = a.vertices.map((p) => p.map((x, k) => x + [3, 2, -4][k]));
  const translated = minkowskiSumMeshes(a, b, ids('translated'));
  approx(volume(translated.mesh), volume(sum.mesh));
  for (let k = 0; k < 3; k++)
    approx(
      Math.min(...translated.mesh.vertices.map((p) => p[k])) - Math.min(...sum.mesh.vertices.map((p) => p[k])),
      [3, 2, -4][k],
    );
});

test('work bounds, invalid inputs/IDs and cancellation reject without partial output', () => {
  const a = lShape(),
    before = structuredClone(a);
  assert.throws(() => minkowskiSumMeshes(a, cube(), { maxCells: 1 }), /cell budget/);
  assert.throws(() => minkowskiSumMeshes(a, a, { maxPairs: 1 }), /pair budget/);
  assert.throws(() => minkowskiSumMeshes(a, cube(), { maxPlaneTriples: 1 }), /triple budget/);
  assert.throws(() => minkowskiSumMeshes(a, cube(), { maxCells: 0 }), /positive/);
  assert.throws(() => convexMeshHull(cube(), { createId: () => 'duplicate' }), /unique/);
  assert.throws(() => minkowskiSumMeshes(cube(), cube(), { createId: () => 'duplicate' }), /unique/);
  const open = cube();
  open.faces.pop();
  assert.throws(() => minkowskiSumMeshes(open, cube()), /closed/);
  assert.throws(() => convexMeshHull(cube(), { signal: {} }), /AbortSignal/);
  const controller = new AbortController();
  controller.abort(new Error('cancel'));
  assert.throws(() => minkowskiSumMeshes(a, cube(), { signal: controller.signal }), /cancel/);
  assert.deepEqual(a, before);
  assert.equal(minkowskiSumMeshes(a, { vertices: [], faces: [] }).mesh.faces.length, 0);
});
