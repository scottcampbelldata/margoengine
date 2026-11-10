import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrimitiveMesh, compilePolygonMesh } from '@margoengine/mesh-edit';
import { repairMesh } from '@margoengine/mesh-edit/repair';
import { booleanMeshesExact } from '@margoengine/mesh-edit/boolean-exact';
import { assertClosed, ids, volume } from './topology-helpers.js';

const cube = () => createPrimitiveMesh('cube', 'box');
const approx = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const add = (a, b) => ({
  vertices: [...a.vertices, ...b.vertices],
  faces: [...a.faces, ...b.faces.map((f) => ({ ...f, vertices: f.vertices.map((i) => i + a.vertices.length) }))],
});

test('dirty disconnected face soup welds, orients and preserves corner UVs without changing inputs', () => {
  const source = cube(),
    soup = { vertices: [], faces: [] };
  source.faces.forEach((face, i) => {
    const start = soup.vertices.length;
    soup.vertices.push(...face.vertices.map((v) => [...source.vertices[v]]));
    const vertices = face.vertices.map((_, j) => start + j),
      uv = face.uv.map((p) => [...p]);
    if (i % 2) {
      vertices.reverse();
      uv.reverse();
    }
    soup.faces.push({ id: face.id, vertices, uv });
  });
  const before = structuredClone(soup),
    result = repairMesh(soup, ids());
  assert.equal(result.readyForBoolean, true);
  assertClosed(result.mesh);
  compilePolygonMesh(result.mesh);
  assert.equal(result.weldedVertices, 16);
  approx(volume(result.mesh), 1);
  assert.ok(result.flippedFaces.length > 0);
  for (const f of result.mesh.faces) {
    const old = source.faces.find((o) => o.id === f.id);
    for (let j = 0; j < f.vertices.length; j++) {
      const p = result.mesh.vertices[f.vertices[j]],
        corner = old.vertices.findIndex((i) => source.vertices[i].every((x, k) => x === p[k]));
      assert.deepEqual(f.uv[j], old.uv[corner]);
    }
  }
  assert.deepEqual(soup, before);
});

test('holes close by default and repaired solids enter exact booleans', () => {
  const mesh = cube();
  mesh.faces.shift();
  const result = repairMesh(mesh, ids('r'));
  assert.equal(result.readyForBoolean, true);
  assert.ok(result.filledFaces.length > 0);
  assertClosed(result.mesh);
  approx(volume(result.mesh), 1);
  const b = cube();
  b.vertices = b.vertices.map(([x, y, z]) => [x + 2, y, z]);
  const union = booleanMeshesExact(result.mesh, b, 'union', ids('b'));
  assertClosed(union.mesh);
  approx(volume(union.mesh), 2);
  assert.equal(repairMesh(mesh, { fillHoles: false }).readyForBoolean, false);
  assert.equal(repairMesh(mesh, { maxHoleEdges: 3 }).readyForBoolean, false);
});

test('degenerate, duplicate, invalid and excess non-manifold faces are explicitly removed', () => {
  const mesh = cube(),
    a = mesh.vertices[0],
    b = mesh.vertices[1];
  mesh.vertices.push(
    a.map((x, k) => (x + b[k]) / 2),
    [NaN, 0, 0],
    [0, -0.49, -0.49],
  );
  mesh.faces.push(
    { ...structuredClone(mesh.faces[0]), id: 'duplicate' },
    { id: 'collapsed', vertices: [0, 0, 1] },
    { id: 'line', vertices: [0, 8, 1] },
    { id: 'invalid', vertices: [0, 1, 9] },
    { id: 'bad-index', vertices: [0, 1, 999] },
    { id: 'stray', vertices: [0, 1, 10] },
  );
  const result = repairMesh(mesh, ids());
  assert.equal(result.readyForBoolean, true);
  assertClosed(result.mesh);
  approx(volume(result.mesh), 1);
  for (const id of ['duplicate', 'collapsed', 'line', 'invalid', 'bad-index', 'stray']) {
    assert.ok(result.removedFaces.includes(id), id);
    assert.deepEqual(result.faceMap[id], []);
    assert.ok(
      result.diagnostics.some((s) => s.startsWith(id + ':')),
      id,
    );
  }
});

test('bow-tie vertex fans separate without dropping closed components', () => {
  const second = createPrimitiveMesh('cube', 'b');
  second.vertices = second.vertices.map((p) => p.map((x) => x + 1));
  const input = add(cube(), second),
    result = repairMesh(input, ids());
  assert.equal(result.splitVertices, 1);
  assert.equal(result.weldedVertices, 1);
  assert.equal(result.readyForBoolean, true);
  assertClosed(result.mesh);
  approx(volume(result.mesh), 2);
  assert.ok(result.vertexMap.some((v) => v.length === 2));
  assert.equal(result.removedFaces.length, 0);
});

test('nested shells orient as a cavity and preserve its empty volume', () => {
  const inner = createPrimitiveMesh('cube', 'inner');
  inner.vertices = inner.vertices.map((p) => p.map((x) => x * 0.5));
  const mesh = add(cube(), inner);
  mesh.faces.forEach((f, i) => {
    if (i % 3) {
      f.vertices.reverse();
      f.uv.reverse();
    }
  });
  const result = repairMesh(mesh, ids());
  assertClosed(result.mesh);
  assert.equal(result.readyForBoolean, true);
  approx(volume(result.mesh), 0.875);
  const cavity = { vertices: result.mesh.vertices, faces: result.mesh.faces.filter((f) => f.id.startsWith('inner')) };
  approx(volume(cavity), -0.125);
});

test('weld radius is non-chaining and missing UVs become valid corner pairs', () => {
  const mesh = cube();
  mesh.vertices.push([2, 0, 0], [2.09, 0, 0], [2.18, 0, 0]);
  for (const f of mesh.faces) delete f.uv;
  const result = repairMesh(mesh, { distance: 0.1 });
  assert.equal(result.weldedVertices, 1);
  assert.equal(result.readyForBoolean, true);
  assert.ok(result.mesh.faces.every((f) => f.uv.every((p) => p[0] === 0 && p[1] === 0)));
});

test('concave imported polygons decompose and zero-volume surfaces report not ready', () => {
  const mesh = {
    vertices: [
      [0, 0, 0],
      [2, 0, 0],
      [2, 1, 0],
      [1, 1, 0],
      [1, 2, 0],
      [0, 2, 0],
    ],
    faces: [{ id: 'L', vertices: [0, 1, 2, 3, 4, 5] }],
  };
  const result = repairMesh(mesh, { fillHoles: false, ...ids() });
  assert.ok(result.faceMap.L.length > 1);
  assert.equal(result.readyForBoolean, false);
  compilePolygonMesh(result.mesh);
  assert.equal(repairMesh({ vertices: [], faces: [] }).readyForBoolean, false);
});

test('nonorientable strips lose a reported conflict face instead of retaining inconsistent winding', () => {
  const vertices = [],
    faces = [],
    count = 5;
  for (let i = 0; i < count; i++)
    for (const sign of [-1, 1]) {
      const t = (i * 2 * Math.PI) / count,
        w = sign * 0.2;
      vertices.push([
        (1 + w * Math.cos(t / 2)) * Math.cos(t),
        (1 + w * Math.cos(t / 2)) * Math.sin(t),
        w * Math.sin(t / 2),
      ]);
    }
  for (let i = 0; i < count; i++) {
    const a = 2 * i,
      b = a + 1,
      c = i + 1 === count ? 1 : a + 2,
      d = i + 1 === count ? 0 : a + 3;
    faces.push({ id: `a${i}`, vertices: [a, b, c] }, { id: `b${i}`, vertices: [b, d, c] });
  }
  const result = repairMesh({ vertices, faces }, { fillHoles: false });
  assert.ok(result.diagnostics.some((s) => s.includes('nonorientable')));
  assert.ok(result.removedFaces.length > 0);
  assert.equal(result.readyForBoolean, false);
});

test('bad options, IDs, structural input and abort reject without changing source', () => {
  assert.throws(() => repairMesh(null), /arrays/);
  assert.throws(() => repairMesh(cube(), { distance: -1 }), /distance/);
  assert.throws(() => repairMesh(cube(), { fillHoles: 'yes' }), /boolean/);
  assert.throws(() => repairMesh(cube(), { maxHoleEdges: 2 }), /three/);
  assert.throws(() => repairMesh(cube(), { signal: {} }), /AbortSignal/);
  const mesh = cube();
  mesh.faces.push(mesh.faces[0]);
  assert.throws(() => repairMesh(mesh), /IDs/);
  const controller = new AbortController();
  controller.abort(new Error('cancel'));
  assert.throws(() => repairMesh(cube(), { signal: controller.signal }), /cancel/);
});
