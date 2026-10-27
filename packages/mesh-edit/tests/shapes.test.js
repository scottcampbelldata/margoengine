import assert from 'node:assert/strict';
import test from 'node:test';
import {
  area,
  assertClosed,
  assertNoDegenerate,
  euler,
  grid,
  halfEdges,
  ids,
  random,
  volume,
} from './topology-helpers.js';

const K = { ...(await import('../dist/index.js')), ...(await import('../dist/modeling.js')) };
const cube = () => K.createPrimitiveMesh('cube', 'box');
const flatArea = (points) => {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i],
      q = points[(i + 1) % points.length];
    sum += p[0] * q[2] - q[0] * p[2];
  }
  return -sum / 2; // XZ outlines wound clockwise seen from +Y face up
};
const outline = (xz) => xz.map(([x, z]) => [x, 0, z]);
// An L in the XZ plane, wound to face +Y (like the grid helper's faces).
const L = outline([
  [0, 0],
  [0, 2],
  [1, 2],
  [1, 1],
  [2, 1],
  [2, 0],
]);

/** Assert every edge has at most two faces and every half-edge is used once (no T-junctions, consistent winding). */
function assertWatertightSheet(mesh, label = 'mesh') {
  const { half, edges } = halfEdges(mesh);
  for (const [key, count] of half) assert.equal(count, 1, `${label}: half-edge ${key} used ${count} times`);
  for (const [id, count] of edges) assert.ok(count <= 2, `${label}: edge ${id} has ${count} faces`);
  // A T-junction leaves a vertex lying inside another face's edge: check no used vertex sits on an edge it is not part of.
  const used = [...new Set(mesh.faces.flatMap((face) => face.vertices))];
  for (const id of edges.keys()) {
    const [a, b] = id.split(':').map(Number),
      A = mesh.vertices[a],
      B = mesh.vertices[b];
    for (const v of used) {
      if (v === a || v === b) continue;
      const P = mesh.vertices[v],
        ab = B.map((x, i) => x - A[i]),
        ap = P.map((x, i) => x - A[i]),
        t = ap.reduce((s, x, i) => s + x * ab[i], 0) / ab.reduce((s, x) => s + x * x, 0);
      if (t <= 1e-9 || t >= 1 - 1e-9) continue;
      const off = Math.hypot(...ap.map((x, i) => x - t * ab[i]));
      assert.ok(off > 1e-9, `${label}: vertex ${v} lies inside edge ${id} (T-junction)`);
    }
  }
}

test('triangulatePolygon keeps every corner of a concave outline, collinear ones included', () => {
  const triangles = K.triangulatePolygon(L);
  assert.equal(triangles.length, 4);
  const sum = triangles.reduce((s, t) => s + flatArea(t.map((i) => L[i])), 0);
  assert.ok(Math.abs(sum - 3) < 1e-12);
  for (const t of triangles) assert.ok(flatArea(t.map((i) => L[i])) > 0, 'triangle keeps the winding');
  const withMidpoint = [...L.slice(0, 1), [0, 0, 1], ...L.slice(1)];
  const seven = K.triangulatePolygon(withMidpoint);
  assert.equal(seven.length, 5);
  assert.deepEqual(
    [...new Set(seven.flat())].sort((a, b) => a - b),
    [0, 1, 2, 3, 4, 5, 6],
  );
  assert.throws(
    () =>
      K.triangulatePolygon(
        outline([
          [0, 0],
          [1, 1],
          [1, 0],
          [0, 1],
        ]),
      ),
    TypeError,
  );
  assert.throws(
    () =>
      K.triangulatePolygon([
        [0, 0, 0],
        [1, 0, 0],
      ]),
    TypeError,
  );
});

test('convexPolygonPieces splits an L into two convex pieces and leaves a convex polygon whole', () => {
  const pieces = K.convexPolygonPieces(L);
  assert.equal(pieces.length, 2);
  for (const piece of pieces) assert.equal(K.polygonGeometryError(piece.map((i) => L[i])), null);
  assert.deepEqual(
    K.convexPolygonPieces(
      outline([
        [0, 0],
        [0, 1],
        [1, 1],
        [1, 0],
      ]),
    ),
    [[0, 1, 2, 3]],
  );
});

test('triangulation fuzz: random star outlines tile their exact area with n - 2 winding-preserving triangles', () => {
  const rand = random(5);
  for (let trial = 0; trial < 200; trial++) {
    const n = 3 + Math.floor(rand() * 40),
      points = Array.from({ length: n }, (_, i) => {
        const angle = (-i / n) * Math.PI * 2,
          r = 0.2 + rand();
        return [Math.cos(angle) * r, 0, Math.sin(angle) * r];
      }),
      triangles = K.triangulatePolygon(points),
      total = flatArea(points);
    assert.equal(triangles.length, n - 2, `trial ${trial}`);
    let sum = 0;
    for (const t of triangles) {
      const a = flatArea(t.map((i) => points[i]));
      assert.ok(a > 0, `trial ${trial}: flipped triangle`);
      sum += a;
    }
    assert.ok(Math.abs(sum - total) < 1e-9 * Math.max(1, total), `trial ${trial}`);
    const pieces = K.convexPolygonPieces(points);
    for (const piece of pieces) assert.equal(K.polygonGeometryError(piece.map((i) => points[i])), null);
    assert.ok(pieces.length <= n - 2);
  }
});

test('splitMeshConcaveFaces makes an imported concave n-gon editable and keeps its UVs', () => {
  const mesh = {
      vertices: L.map((p) => [...p]),
      faces: [{ id: 'L', vertices: [0, 1, 2, 3, 4, 5], uv: L.map(([x, , z]) => [x / 2, z / 2]) }],
    },
    result = K.splitMeshConcaveFaces(mesh, ids());
  assert.equal(result.mesh.faces.length, 2);
  assert.equal(result.mesh.faces[0].id, 'L');
  assert.deepEqual(
    result.faceMap.L,
    result.mesh.faces.map((face) => face.id),
  );
  assert.ok(Math.abs(area(result.mesh) - 3) < 1e-12);
  for (const face of result.mesh.faces)
    face.vertices.forEach((v, i) => assert.deepEqual(face.uv[i], [mesh.vertices[v][0] / 2, mesh.vertices[v][2] / 2]));
  K.compilePolygonMesh(result.mesh);
  const bowtie = {
    vertices: outline([
      [0, 0],
      [1, 1],
      [1, 0],
      [0, 1],
    ]),
    faces: [
      {
        id: 'x',
        vertices: [0, 1, 2, 3],
        uv: [
          [0, 0],
          [1, 1],
          [1, 0],
          [0, 1],
        ],
      },
    ],
  };
  assert.throws(() => K.splitMeshConcaveFaces(bowtie), TypeError);
});

test('knife across a grid splits the crossed faces with shared edge vertices and no T-junctions', () => {
  const mesh = grid(2),
    result = K.knifeMeshFaces(
      mesh,
      [
        [-0.1, 1, 0.5],
        [2.1, 1, 0.5],
      ],
      [0, -1, 0],
      ids(),
    );
  assert.equal(result.mesh.faces.length, 6);
  assert.equal(result.createdVertices.length, 3);
  assert.equal(result.cutEdges.length, 2);
  assert.ok(Math.abs(area(result.mesh) - 4) < 1e-12);
  assertWatertightSheet(result.mesh);
  assertNoDegenerate(result.mesh);
  for (const face of result.mesh.faces)
    face.vertices.forEach((v, i) => {
      const [x, , z] = result.mesh.vertices[v];
      assert.ok(Math.hypot(face.uv[i][0] - x / 2, face.uv[i][1] - z / 2) < 1e-12);
    });
  // Restricted to one face: the neighbor still gains the shared edge vertex, so no T-junction appears.
  const one = K.knifeMeshFaces(
    mesh,
    [
      [-0.1, 1, 0.5],
      [2.1, 1, 0.5],
    ],
    [0, -1, 0],
    { ...ids(), faces: ['g0-0'] },
  );
  assert.equal(one.mesh.faces.length, 5);
  assertWatertightSheet(one.mesh);
});

test('knife through a cube cuts front and back and keeps it closed', () => {
  const result = K.knifeMeshFaces(
    cube(),
    [
      [-1, 1, 0.1],
      [1, 1, 0.1],
    ],
    [0, -1, 0],
    ids(),
  );
  assert.equal(result.mesh.faces.length, 10);
  assertClosed(result.mesh);
  assert.equal(euler(result.mesh), 2);
  assert.ok(Math.abs(volume(result.mesh) - 1) < 1e-12);
});

test('knife with a bend inside a face splits it through the bend, concave side into convex pieces', () => {
  const mesh = grid(1),
    result = K.knifeMeshFaces(
      mesh,
      [
        [-0.1, 1, 0.3],
        [0.5, 1, 0.5],
        [1.1, 1, 0.3],
      ],
      [0, -1, 0],
      ids(),
    );
  assert.equal(result.mesh.faces.length, 3);
  assert.equal(result.createdVertices.length, 3);
  assert.ok(Math.abs(area(result.mesh) - 1) < 1e-12);
  assertWatertightSheet(result.mesh);
  const bend = result.mesh.vertices.findIndex((p) => Math.abs(p[0] - 0.5) < 1e-12 && Math.abs(p[2] - 0.5) < 1e-12);
  assert.ok(bend >= 0);
  // A cut that stops inside the face splits nothing.
  const partial = K.knifeMeshFaces(
    mesh,
    [
      [-0.1, 1, 0.3],
      [0.5, 1, 0.5],
    ],
    [0, -1, 0],
  );
  assert.equal(partial.mesh.faces.length, 1);
  assert.match(partial.diagnostics.join(' '), /nothing was split/);
  assert.throws(
    () =>
      K.knifeMeshFaces(
        mesh,
        [
          [0, 0, 0],
          [0, 1, 0],
        ],
        [0, -1, 0],
      ),
    RangeError,
  );
});

test('knife fuzz: random straight cuts through a cube keep it closed, genus 0 and volume-exact', () => {
  const rand = random(9);
  for (let trial = 0; trial < 80; trial++) {
    const angle = rand() * Math.PI,
      c = [rand() - 0.5, rand() - 0.5],
      dx = Math.cos(angle),
      dz = Math.sin(angle),
      result = K.knifeMeshFaces(
        cube(),
        [
          [c[0] - dx * 3, 2, c[1] - dz * 3],
          [c[0] + dx * 3, 2, c[1] + dz * 3],
        ],
        [0, -1, 0],
        ids(`k${trial}`),
      );
    assertClosed(result.mesh, `trial ${trial}`);
    assert.equal(euler(result.mesh), 2);
    assertNoDegenerate(result.mesh);
    assert.ok(Math.abs(volume(result.mesh) - 1) < 1e-12);
  }
});

test('subdivide: a cube rounds off and stays closed; a flat grid keeps its shape and UVs exactly', () => {
  for (const levels of [1, 2]) {
    const result = K.subdivideMesh(cube(), { ...ids(), levels });
    assertClosed(result.mesh, `levels ${levels}`);
    assert.equal(euler(result.mesh), 2);
    assertNoDegenerate(result.mesh);
    const v = volume(result.mesh);
    assert.ok(v > 0.3 && v < 1, `volume ${v}`);
    // Golden: one level moves each cube corner to 5/18 per axis (the Catmull-Clark vertex rule by hand) and
    // encloses 5/12.
    if (levels === 1) {
      for (const axis of [0, 1, 2]) assert.ok(Math.abs(Math.abs(result.mesh.vertices[0][axis]) - 5 / 18) < 1e-15);
      assert.ok(Math.abs(v - 5 / 12) < 1e-12);
    }
    assert.equal(Object.values(result.faceMap).flat().length, result.mesh.faces.length);
    // Each cube face is its own UV island, so every corner UV stays inside its source tile.
    for (const [source, descendants] of Object.entries(result.faceMap)) {
      const tile = cube().faces.find((face) => face.id === source).uv,
        [lo, hi] = [0, 1].map((k) => [0, 1].map((axis) => (k ? Math.max : Math.min)(...tile.map((uv) => uv[axis]))));
      for (const id of descendants)
        for (const uv of result.mesh.faces.find((face) => face.id === id).uv)
          for (const axis of [0, 1]) assert.ok(uv[axis] >= lo[axis] - 1e-15 && uv[axis] <= hi[axis] + 1e-15);
    }
  }
  for (const uv of ['smooth', 'linear'])
    for (const boundary of ['smooth', 'pinned']) {
      const result = K.subdivideMesh(grid(2), { ...ids(), uv, boundary });
      assert.equal(result.mesh.faces.length, 16, `${uv} ${boundary}`);
      assert.ok(Math.abs(area(result.mesh) - 4) < 1e-12);
      for (const face of result.mesh.faces)
        face.vertices.forEach((v, i) => {
          const [x, , z] = result.mesh.vertices[v];
          assert.ok(Math.hypot(face.uv[i][0] - x / 2, face.uv[i][1] - z / 2) < 1e-12, `${uv} ${boundary}`);
        });
    }
});

test('subdivide honors AbortSignal and rejects bad levels', () => {
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  assert.throws(() => K.subdivideMesh(cube(), { signal: controller.signal }), /stop/);
  assert.throws(() => K.subdivideMesh(cube(), { levels: 0 }), RangeError);
  assert.throws(() => K.subdivideMesh(cube(), { levels: 5 }), RangeError);
});

test('subdivide fuzz: random edge bevels of a cube subdivide to closed genus-0 meshes', () => {
  const rand = random(13),
    edges = K.polygonMeshEdges(cube()).map((edge) => edge.id);
  for (let trial = 0; trial < 20; trial++) {
    const pick = edges.filter(() => rand() < 0.4);
    if (!pick.length) continue;
    const beveled = K.bevelMeshEdges(cube(), pick, 0.05 + rand() * 0.1, ids(`b${trial}`)).mesh,
      result = K.subdivideMesh(beveled, ids(`s${trial}`));
    assertClosed(result.mesh, `trial ${trial}`);
    assert.equal(euler(result.mesh), 2);
    assertNoDegenerate(result.mesh);
  }
});

test('README concave, knife and subdivision example runs as written', () => {
  const outline = [
    [0, 0, 0],
    [0, 0, 2],
    [1, 0, 2],
    [1, 0, 1],
    [2, 0, 1],
    [2, 0, 0],
  ];
  const triangles = K.triangulatePolygon(outline);
  const pieces = K.convexPolygonPieces(outline);
  const imported = K.splitMeshConcaveFaces({
    vertices: outline,
    faces: [{ id: 'L', vertices: [0, 1, 2, 3, 4, 5], uv: outline.map(([x, , z]) => [x / 2, z / 2]) }],
  });
  const cut = K.knifeMeshFaces(
    K.createPrimitiveMesh('cube', 'box'),
    [
      [-1, 1, 0.1],
      [1, 1, 0.1],
    ],
    [0, -1, 0],
  );
  const smooth = K.subdivideMesh(K.createPrimitiveMesh('cube', 'box'), { levels: 2 });
  assert.deepEqual([triangles.length, pieces.length, imported.mesh.faces.length, cut.cutEdges.length], [4, 2, 2, 4]);
  assertClosed(smooth.mesh);
});
