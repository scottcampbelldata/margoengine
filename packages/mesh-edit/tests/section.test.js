import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrimitiveMesh, compilePolygonMesh } from '@margoengine/mesh-edit';
import { booleanMeshesExact } from '@margoengine/mesh-edit/boolean-exact';
import { sliceMesh, splitMeshByPlane, trimMeshByPlane } from '@margoengine/mesh-edit/section';
import { assertClosed, assertNoDegenerate, ids, volume } from './topology-helpers.js';

const cube = () => createPrimitiveMesh('cube', 'box');
const plane = { normal: [0, 0, 1], offset: 0 };
const approx = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const signedArea = (ring) =>
  ring.reduce((s, p, i) => {
    const q = ring[(i + 1) % ring.length];
    return s + (p[0] * q[1] - p[1] * q[0]) / 2;
  }, 0);
const sectionArea = (section) =>
  section.polygons.reduce((s, p) => s + signedArea(p.contour) + p.holes.reduce((v, h) => v + signedArea(h), 0), 0);

test('split, trim, and slice preserve volume, closure, winding, source UVs and owned arrays', () => {
  const mesh = cube(),
    before = structuredClone(mesh),
    result = splitMeshByPlane(mesh, plane, ids());
  for (const [name, half] of [
    ['positive', result.positive],
    ['negative', result.negative],
  ]) {
    assertClosed(half);
    assertNoDegenerate(half);
    compilePolygonMesh(half);
    approx(volume(half), volume(mesh) / 2);
    for (const id of result.caps[name]) assert.ok(half.faces.some((f) => f.id === id));
    assert.equal(Object.keys(result.faceMap[name]).length, mesh.faces.length);
  }
  approx(sectionArea(result.section), 1);
  approx(volume(trimMeshByPlane(mesh, plane, ids())), 0.5);
  result.positive.vertices[0][0] = 20;
  assert.deepEqual(mesh, before);
  assert.ok(result.negative.vertices.every((p) => Math.abs(p[0]) <= 0.5));
  const side = result.negative.faces.find((f) => f.id === 'box-face-0');
  if (side) for (const uv of side.uv) assert.ok(uv.every((x) => x >= 0 && x <= 1));
});

test('arbitrary plane, nonunit normals, plane through edges and through vertices', () => {
  for (const normal of [
    [1, 1, 1],
    [1, 1, 0],
    [0, 20, 0],
    [0.12, -0.24, 0.76],
  ]) {
    const mesh = cube(),
      result = splitMeshByPlane(mesh, { normal, offset: 0 }, ids());
    assertClosed(result.positive);
    assertClosed(result.negative);
    approx(volume(result.positive) + volume(result.negative), volume(mesh));
    for (const polygon of result.section.polygons)
      for (const [x, y] of polygon.contour) {
        const p = result.section.origin.map((o, k) => o + result.section.u[k] * x + result.section.v[k] * y);
        approx(
          p.reduce((s, v, k) => s + normal[k] * v, 0),
          0,
        );
      }
  }
});

test('outside planes and exact tangencies produce an owned no-op and empty side', () => {
  for (const offset of [-2, -0.5, 0.5, 2]) {
    const result = splitMeshByPlane(cube(), { normal: [0, 0, 1], offset }, ids());
    const halves = [result.positive, result.negative];
    assert.equal(halves.filter((h) => h.faces.length === 0).length, 1);
    approx(
      halves.reduce((s, h) => s + volume(h), 0),
      1,
    );
    assert.equal(result.section.polygons.length, 0);
  }
  assert.equal(sliceMesh({ vertices: [], faces: [] }, plane).polygons.length, 0);
});

test('oblique exact vertex incidences survive plane normalization without invented slivers', () => {
  for (const normal of [
    [1, 1, 1],
    [1, 2, 3],
  ])
    for (const vertex of cube().vertices) {
      const offset = normal.reduce((sum, x, k) => sum + x * vertex[k], 0);
      const result = splitMeshByPlane(cube(), { normal, offset }, ids());
      assertClosed(result.positive);
      assertClosed(result.negative);
      approx(volume(result.positive) + volume(result.negative), 1);
    }
});

test('annular sections keep holes and caps do not fill the void', () => {
  const outer = cube(),
    inner = cube();
  inner.faces.forEach((f) => {
    f.id = `inner-${f.id}`;
  });
  inner.vertices = inner.vertices.map(([x, y, z]) => [x * 0.5, y * 0.5, z * 2]);
  const tube = booleanMeshesExact(outer, inner, 'difference', ids('b')).mesh;
  const result = splitMeshByPlane(tube, plane, ids());
  assert.equal(result.section.polygons.length, 1);
  assert.equal(result.section.polygons[0].holes.length, 1);
  approx(sectionArea(result.section), 0.75);
  for (const half of [result.positive, result.negative]) {
    assertClosed(half);
    approx(volume(half), 0.375);
  }
});

test('disconnected and concave solids yield separate regions without bridging gaps', () => {
  const a = cube(),
    b = cube();
  b.vertices = b.vertices.map(([x, y, z]) => [x + 2, y, z]);
  b.faces = b.faces.map((f) => ({ ...f, id: `b-${f.id}`, vertices: f.vertices.map((i) => i + a.vertices.length) }));
  const result = splitMeshByPlane(
    { vertices: [...a.vertices, ...b.vertices], faces: [...a.faces, ...b.faces] },
    plane,
    ids(),
  );
  assert.equal(result.section.polygons.length, 2);
  approx(sectionArea(result.section), 2);
  assertClosed(result.positive);
  assertClosed(result.negative);
});

test('invalid geometry, options, IDs and aborts reject without mutation', () => {
  const mesh = cube(),
    before = structuredClone(mesh);
  assert.throws(() => splitMeshByPlane(mesh, { normal: [0, 0, 0], offset: 0 }), /nonzero/);
  assert.throws(() => splitMeshByPlane(mesh, { normal: [NaN, 0, 1], offset: 0 }), /finite/);
  assert.throws(() => splitMeshByPlane(mesh, plane, { signal: {} }), /AbortSignal/);
  assert.throws(() => splitMeshByPlane({ ...mesh, faces: mesh.faces.slice(1) }, plane), /closed/);
  assert.throws(() => splitMeshByPlane(mesh, plane, { createId: () => 'box-face-0' }), /unique/);
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  assert.throws(() => splitMeshByPlane(mesh, plane, { signal: controller.signal }), /cancelled/);
  assert.deepEqual(mesh, before);
});
