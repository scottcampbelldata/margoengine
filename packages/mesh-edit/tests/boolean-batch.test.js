import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrimitiveMesh, compilePolygonMesh } from '@margoengine/mesh-edit';
import { batchBooleanMeshes } from '@margoengine/mesh-edit/boolean-batch';
import { booleanMeshesExact } from '@margoengine/mesh-edit/boolean-exact';
import { assertClosed, ids, volume } from './topology-helpers.js';

const box = (x = 0, prefix = 'same') => {
  const mesh = createPrimitiveMesh('cube', prefix);
  mesh.vertices = mesh.vertices.map(([a, b, c]) => [a + x, b, c]);
  return mesh;
};
const approx = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const empty = { vertices: [], faces: [] };

test('hundreds of disconnected solids share one exact space and one final rounding', () => {
  const inputs = Array.from({ length: 200 }, (_, i) => box(i * 2)),
    before = structuredClone(inputs);
  const result = batchBooleanMeshes(inputs, 'union', ids());
  assertClosed(result.mesh);
  compilePolygonMesh(result.mesh);
  approx(volume(result.mesh), 200);
  assert.equal(result.work.exactSpaces, 1);
  assert.equal(result.work.materializations, 1);
  assert.equal(result.work.treeBuilds, 0);
  assert.equal(result.faceMap.length, 200);
  for (const [input, map] of result.faceMap.entries())
    for (const [face, names] of Object.entries(map)) {
      assert.equal(names.length, 1);
      assert.deepEqual(result.sources[names[0]], { input, face });
    }
  assert.deepEqual(inputs, before);
  result.mesh.vertices[0][0] = 999;
  assert.deepEqual(inputs, before);
});

test('n-ary overlap, intersection and first-minus-union have analytic volumes', () => {
  for (const [operation, expected] of [
    ['union', 2],
    ['intersection', 0],
    ['difference', 0.5],
  ]) {
    const result = batchBooleanMeshes([box(), box(0.5), box(1)], operation, ids());
    assertClosed(result.mesh);
    approx(volume(result.mesh), expected);
    assert.ok(result.work.materializations <= 1);
  }
  const intersection = batchBooleanMeshes([box(), box(0.25), box(-0.25)], 'intersection', ids());
  approx(volume(intersection.mesh), 0.5);
  assertClosed(intersection.mesh);
});

test('near-coincident oblique and repeated operands agree with binary exact output', () => {
  const a = box(),
    b = box(1e-13, 'b'),
    c = box(0.2, 'c');
  b.vertices = b.vertices.map(([x, y, z]) => [x + y * 1e-15, y, z]);
  for (const op of ['union', 'intersection', 'difference']) {
    const pair = batchBooleanMeshes([a, b], op, ids('p'));
    const exact = booleanMeshesExact(a, b, op, ids('b'));
    approx(volume(pair.mesh), volume(exact.mesh));
    assertClosed(pair.mesh);
  }
  const repeat = batchBooleanMeshes([a, a, a, a], 'union', ids());
  approx(volume(repeat.mesh), 1);
  assertClosed(repeat.mesh);
  const many = batchBooleanMeshes([a, b, c], 'union', ids());
  approx(volume(many.mesh), 1.2);
  assertClosed(many.mesh);
});

test('empty collections, identities, absorption and owned single input', () => {
  for (const op of ['union', 'intersection', 'difference']) assert.deepEqual(batchBooleanMeshes([], op).mesh, empty);
  const mesh = box();
  approx(volume(batchBooleanMeshes([mesh, empty], 'union').mesh), 1);
  approx(volume(batchBooleanMeshes([mesh, empty], 'difference').mesh), 1);
  assert.deepEqual(batchBooleanMeshes([mesh, empty], 'intersection').mesh, empty);
  assert.deepEqual(batchBooleanMeshes([empty, mesh], 'difference').mesh, empty);
  const one = batchBooleanMeshes([mesh]);
  one.mesh.vertices[0][0] = 9;
  assert.equal(mesh.vertices[0][0], -0.5);
});

test('cavities survive batch evaluation and inward cavity shells keep their meaning', () => {
  const outer = box(),
    inner = box(0, 'inner');
  inner.vertices = inner.vertices.map((p) => p.map((x) => x * 0.5));
  const cavity = booleanMeshesExact(outer, inner, 'difference', ids()).mesh;
  const result = batchBooleanMeshes([cavity, box(2)], 'union', ids('batch'));
  approx(volume(result.mesh), 1.875);
  assertClosed(result.mesh);
});

test('overlapping outward shells in a single operand are unioned without intermediate materialization', () => {
  const a = box(),
    b = box(0.5, 'b');
  b.faces.forEach((f) => {
    f.vertices = f.vertices.map((i) => i + a.vertices.length);
  });
  const input = { vertices: [...a.vertices, ...b.vertices], faces: [...a.faces, ...b.faces] };
  const result = batchBooleanMeshes([input], 'union', ids());
  approx(volume(result.mesh), 1.5);
  assertClosed(result.mesh);
  assert.equal(result.work.materializations, 1);
});

test('invalid input, colliding generated IDs and abort reject atomically', () => {
  assert.throws(() => batchBooleanMeshes(null), /array/);
  assert.throws(() => batchBooleanMeshes([box()], 'xor'), /operation/);
  assert.throws(() => batchBooleanMeshes([box()], 'union', { signal: {} }), /AbortSignal/);
  const open = box();
  open.faces.pop();
  assert.throws(() => batchBooleanMeshes([open]), /closed/);
  assert.throws(() => batchBooleanMeshes([box(), box(2)], 'union', { createId: () => 'same-face-0' }), /unique/);
  const controller = new AbortController();
  controller.abort(new Error('cancel'));
  assert.throws(() => batchBooleanMeshes([box()], 'union', { signal: controller.signal }), /cancel/);
});
