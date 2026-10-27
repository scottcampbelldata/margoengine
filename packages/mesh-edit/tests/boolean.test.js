import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNoDegenerate, euler, halfEdges, ids, random, volume } from './topology-helpers.js';

const K = { ...(await import('../dist/index.js')), ...(await import('../dist/modeling.js')) };
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

/** A box of the given size centred at `c`, rotated by `turn` radians about the axis (normalized) `axis`. */
function box(prefix, c = [0, 0, 0], size = [1, 1, 1], turn = 0, axis = [0, 1, 0]) {
  const mesh = K.createPrimitiveMesh('cube', prefix),
    [x, y, z] = axis,
    s = Math.sin(turn),
    k = 1 - Math.cos(turn);
  mesh.vertices = mesh.vertices.map((p) => {
    const q = p.map((v, i) => v * size[i]),
      // Rodrigues' rotation.
      cross = [y * q[2] - z * q[1], z * q[0] - x * q[2], x * q[1] - y * q[0]],
      cross2 = [y * cross[2] - z * cross[1], z * cross[0] - x * cross[2], x * cross[1] - y * cross[0]];
    return q.map((v, i) => v + s * cross[i] + k * cross2[i] + c[i]);
  });
  return mesh;
}

/** Closed: every half-edge matched by its reverse equally often. */
function assertClosedSolid(mesh, label) {
  const { half } = halfEdges(mesh);
  for (const [key, count] of half) {
    const [a, b] = key.split('>');
    assert.equal(half.get(`${b}>${a}`), count, `${label}: half-edge ${key} unmatched`);
  }
}

const all = (a, b) =>
  Object.fromEntries(['union', 'difference', 'intersection'].map((op) => [op, K.booleanMeshes(a, b, op, ids(op))]));

test('overlapping cubes: union, difference and intersection volumes, closed genus-0 shells', () => {
  const r = all(box('a'), box('b', [0.5, 0.5, 0.5]));
  near(volume(r.union.mesh), 2 - 0.125);
  near(volume(r.difference.mesh), 1 - 0.125);
  near(volume(r.intersection.mesh), 0.125);
  for (const [op, result] of Object.entries(r)) {
    assertClosedSolid(result.mesh, op);
    assert.equal(euler(result.mesh), 2, op);
    assert.equal(result.nonManifoldEdges, 0);
    assertNoDegenerate(result.mesh, op);
    K.compilePolygonMesh(result.mesh);
  }
  // The intersection is a cube again: pieces of each source face merge back into one quad.
  assert.equal(r.intersection.mesh.faces.length, 6);
});

test('coplanar faces: boxes sharing four side planes', () => {
  const r = all(box('a'), box('b', [0.5, 0, 0]));
  near(volume(r.union.mesh), 1.5);
  near(volume(r.difference.mesh), 0.5);
  near(volume(r.intersection.mesh), 0.5);
  for (const [op, result] of Object.entries(r)) {
    assertClosedSolid(result.mesh, op);
    assert.equal(euler(result.mesh), 2, op);
  }
});

test('touching along a face: the union is one closed box; the intersection is empty', () => {
  const r = all(box('a'), box('b', [1, 0, 0]));
  near(volume(r.union.mesh), 2);
  assertClosedSolid(r.union.mesh, 'union');
  assert.equal(euler(r.union.mesh), 2);
  near(volume(r.difference.mesh), 1);
  assert.equal(r.intersection.mesh.faces.length, 0);
  assert.match(r.intersection.diagnostics.join(' '), /empty/);
});

test('touching along an edge: closed results, with the shared edge reported as non-manifold', () => {
  const r = all(box('a'), box('b', [1, 1, 0]));
  near(volume(r.union.mesh), 2);
  assertClosedSolid(r.union.mesh, 'union');
  assert.ok(r.union.nonManifoldEdges >= 1);
  near(volume(r.difference.mesh), 1);
  near(volume(r.intersection.mesh), 0);
});

test('nested and disjoint shapes', () => {
  const nested = all(box('a', [0, 0, 0], [2, 2, 2]), box('b', [0.1, 0, 0]));
  near(volume(nested.union.mesh), 8);
  near(volume(nested.intersection.mesh), 1);
  near(volume(nested.difference.mesh), 7);
  // A hollow box: two shells, Euler characteristic 2 + 2.
  assert.equal(euler(nested.difference.mesh), 4);
  assertClosedSolid(nested.difference.mesh, 'hollow');
  const apart = all(box('a'), box('b', [3, 0, 0]));
  near(volume(apart.union.mesh), 2);
  assert.equal(euler(apart.union.mesh), 4);
  near(volume(apart.difference.mesh), 1);
  assert.equal(apart.intersection.mesh.faces.length, 0);
});

test('provenance: faces keep source IDs and UVs inside their source tile', () => {
  const a = box('a'),
    b = box('b', [0.5, 0.5, 0.5]),
    result = K.booleanMeshes(a, b, 'union', ids());
  for (const [id, source] of Object.entries(result.sources)) {
    const input = source.input === 'a' ? a : b,
      tile = input.faces.find((face) => face.id === source.face).uv,
      face = result.mesh.faces.find((f) => f.id === id);
    assert.ok(result.faceMap[source.input][source.face].includes(id));
    for (const uv of face.uv)
      for (const axis of [0, 1]) {
        const values = tile.map((t) => t[axis]);
        assert.ok(uv[axis] >= Math.min(...values) - 1e-12 && uv[axis] <= Math.max(...values) + 1e-12);
      }
  }
  assert.ok(result.mesh.faces.some((face) => face.id === 'a-face-0'));
});

test('boolean fuzz: rotated, scaled boxes obey the inclusion-exclusion volume identities and stay closed', () => {
  const rand = random(21);
  for (let trial = 0; trial < 40; trial++) {
    const axis = [rand() - 0.5, rand() - 0.5, rand() - 0.5],
      l = Math.hypot(...axis);
    const a = box('a', [0, 0, 0], [1, 0.8, 1.2]),
      b = box(
        'b',
        [rand() - 0.5, rand() - 0.5, rand() - 0.5],
        [0.5 + rand(), 0.5 + rand(), 0.5 + rand()],
        rand() * Math.PI,
        axis.map((v) => v / l),
      ),
      r = all(a, b),
      va = volume(a),
      vb = volume(b),
      vu = volume(r.union.mesh),
      vi = volume(r.intersection.mesh),
      vd = volume(r.difference.mesh);
    near(vu + vi, va + vb, 1e-9);
    near(vd + vi, va, 1e-9);
    for (const [op, result] of Object.entries(r)) {
      assertClosedSolid(result.mesh, `${trial} ${op}`);
      assertNoDegenerate(result.mesh, `${trial} ${op}`);
    }
  }
});

test('boolean fuzz: a rounded (subdivided) solid against moved boxes keeps the volume identities', () => {
  const rand = random(33),
    round = K.subdivideMesh(box('r', [0, 0, 0], [1.4, 1.4, 1.4]), { levels: 2, createId: ids('s').createId }).mesh,
    vr = volume(round);
  for (let trial = 0; trial < 12; trial++) {
    const b = box('b', [rand() - 0.5, rand() - 0.5, rand() - 0.5], [0.6, 0.6, 0.6], rand() * Math.PI, [0, 0.6, 0.8]),
      r = all(round, b),
      vb = volume(b);
    near(volume(r.union.mesh) + volume(r.intersection.mesh), vr + vb, 1e-9);
    near(volume(r.difference.mesh) + volume(r.intersection.mesh), vr, 1e-9);
    for (const [op, result] of Object.entries(r)) assertClosedSolid(result.mesh, `${trial} ${op}`);
  }
});

test('boolean of a cylinder and a box, and of a result with another box (chained)', () => {
  // The unit cylinder's caps are coplanar with the box and its sides touch the box along four lines.
  const cylinder = K.createPrimitiveMesh('cylinder', 'c'),
    tangent = K.booleanMeshes(box('a'), cylinder, 'difference', ids('t'));
  assertClosedSolid(tangent.mesh, 'tangent');
  near(volume(tangent.mesh), 1 - volume(cylinder));
  assert.equal(tangent.nonManifoldEdges, 4);
  // A thinner peg drills a clean through-hole: genus 1, Euler characteristic 0.
  cylinder.vertices = cylinder.vertices.map(([x, y, z]) => [x * 0.6, y * 1.5, z * 0.6]);
  const cut = K.booleanMeshes(box('a'), cylinder, 'difference', ids('d'));
  assertClosedSolid(cut.mesh, 'difference');
  near(volume(cut.mesh), 1 - volume(cylinder) / 1.5);
  assert.equal(cut.nonManifoldEdges, 0);
  assert.equal(euler(cut.mesh), 0);
  const again = K.booleanMeshes(cut.mesh, box('e', [0.5, 0, 0]), 'union', ids('u'));
  assertClosedSolid(again.mesh, 'chained');
});

test('boolean rejects open, inward and bad inputs, and honors AbortSignal', () => {
  const open = K.deleteMeshComponents(box('a'), { mode: 'face', faces: ['a-face-0'] }).mesh,
    inward = box('i');
  inward.faces = inward.faces.map((face) => ({
    ...face,
    vertices: [...face.vertices].reverse(),
    uv: [...face.uv].reverse(),
  }));
  assert.throws(() => K.booleanMeshes(open, box('b'), 'union'), TypeError);
  assert.throws(() => K.booleanMeshes(inward, box('b'), 'union'), TypeError);
  assert.throws(() => K.booleanMeshes(box('a'), box('b'), 'xor'), TypeError);
  assert.throws(() => K.booleanMeshes(box('a'), box('b'), 'union', { tolerance: -1 }), RangeError);
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  assert.throws(() => K.booleanMeshes(box('a'), box('b'), 'union', { signal: controller.signal }), /stop/);
});

test('README boolean example runs as written', () => {
  const box = K.createPrimitiveMesh('cube', 'box');
  const peg = K.createPrimitiveMesh('cylinder', 'peg');
  peg.vertices = peg.vertices.map(([x, y, z]) => [x * 0.6, y * 1.5, z * 0.6]);
  const drilled = K.booleanMeshes(box, peg, 'difference');
  assertClosedSolid(drilled.mesh, 'drilled');
  assert.equal(drilled.nonManifoldEdges, 0);
  assert.equal(euler(drilled.mesh), 0);
  assert.ok(drilled.faceMap.a['box-face-0'].length >= 1);
});
