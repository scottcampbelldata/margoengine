import assert from 'node:assert/strict';
import test from 'node:test';
import { compilePolygonMesh, createPrimitiveMesh, polygonMeshEdges } from '@margoengine/mesh-edit';
import { fillMeshHoles, meshBoundaryLoops, subdivideMesh } from '@margoengine/mesh-edit/modeling';

let next = 0;
const createId = () => `h${next++}`;

function assertClosed(mesh) {
  compilePolygonMesh(mesh);
  for (const edge of polygonMeshEdges(mesh)) {
    assert.equal(edge.incidences.length, 2, `edge ${edge.id}`);
    assert.notEqual(edge.incidences[0].from, edge.incidences[1].from, 'winding');
  }
}

const volume = (mesh) => {
  let sum = 0;
  for (const face of mesh.faces) {
    const a = mesh.vertices[face.vertices[0]];
    for (let i = 1; i < face.vertices.length - 1; i++) {
      const b = mesh.vertices[face.vertices[i]],
        c = mesh.vertices[face.vertices[i + 1]];
      sum +=
        a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    }
  }
  return sum / 6;
};

/** A unit sphere as triangles. */
function sphere(levels = 3) {
  let mesh = createPrimitiveMesh('cube', 'box');
  for (let i = 0; i < levels; i++) mesh = subdivideMesh(mesh, { createId }).mesh;
  return {
    vertices: mesh.vertices.map((p) => p.map((x) => x / Math.hypot(...p))),
    faces: mesh.faces.flatMap((face) =>
      face.vertices.slice(1, -1).map((_, i) => ({
        id: `${face.id}.${i}`,
        vertices: [face.vertices[0], face.vertices[i + 1], face.vertices[i + 2]],
        uv: [face.uv[0], face.uv[i + 1], face.uv[i + 2]],
      })),
    ),
  };
}

const without = (mesh, keep) => ({ ...mesh, faces: mesh.faces.filter(keep) });

test('boundary loops: closed has none, a missing face leaves one wound to fill it', () => {
  const cube = createPrimitiveMesh('cube', 'box');
  assert.deepEqual(meshBoundaryLoops(cube), []);
  const open = without(cube, (face) => face.id !== cube.faces[0].id),
    loops = meshBoundaryLoops(open);
  assert.equal(loops.length, 1);
  assert.equal(loops[0].length, 4);
  const removed = cube.faces[0].vertices,
    at = removed.indexOf(loops[0][0]);
  assert.deepEqual(loops[0], [...removed.slice(at), ...removed.slice(0, at)]);
});

test('a loop touching itself at a vertex gives two loops', () => {
  const vertices = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
      [-1, 0, 0],
      [-1, -1, 0],
      [0, -1, 0],
    ],
    uv = [
      [0, 0],
      [1, 0],
      [1, 1],
    ],
    mesh = {
      vertices,
      faces: [
        { id: 'a', vertices: [0, 1, 2], uv },
        { id: 'b', vertices: [0, 2, 3], uv },
        { id: 'c', vertices: [0, 4, 5], uv },
        { id: 'd', vertices: [0, 5, 6], uv },
      ],
    };
  assert.deepEqual(
    meshBoundaryLoops(mesh)
      .map((loop) => loop.length)
      .sort(),
    [4, 4],
  );
});

test('a removed cube face comes back closed, with the same volume', () => {
  const cube = createPrimitiveMesh('cube', 'box'),
    open = without(cube, (face) => face.id !== cube.faces[2].id);
  for (const mode of ['triangles', 'grid']) {
    const { mesh, holes, createdFaces } = fillMeshHoles(open, { mode, createId });
    assertClosed(mesh);
    assert.equal(holes.length, 1);
    assert.deepEqual(holes[0].faces, createdFaces);
    assert.ok(Math.abs(volume(mesh) - 1) < 1e-12);
  }
});

test('faces around a hole do not change', () => {
  const cube = createPrimitiveMesh('cube', 'box'),
    open = without(cube, (face) => face.id !== cube.faces[0].id),
    { mesh, faceMap } = fillMeshHoles(open, { createId });
  for (const face of open.faces) {
    assert.deepEqual(faceMap[face.id], [face.id]);
    assert.deepEqual(
      mesh.faces.find((f) => f.id === face.id),
      face,
    );
  }
});

test('a curved hole fills along the surface', () => {
  const ball = sphere(),
    cap = (face) => !face.vertices.every((v) => ball.vertices[v][1] > 0.75),
    open = without(ball, cap),
    { mesh, holes, createdVertices } = fillMeshHoles(open, { createId });
  assert.equal(holes.length, 1);
  assertClosed(mesh);
  assert.ok(createdVertices.length > 0);
  const top = Math.max(...createdVertices.map((v) => mesh.vertices[v][1])),
    flat = fillMeshHoles(open, { fair: false, createId }),
    flatTop = Math.max(...flat.createdVertices.map((v) => flat.mesh.vertices[v][1]));
  // The hole's rim sits near y = 0.8: fairing lifts the fill toward the sphere's top at 1.
  assert.ok(top > flatTop + 0.05, `fair ${top} plain ${flatTop}`);
  assert.ok(top < 1.1, `fair overshoots: ${top}`);
  for (const v of createdVertices) assert.ok(Math.abs(Math.hypot(...mesh.vertices[v]) - 1) < 0.08);
});

test('fill triangles match the size of the edges around them', () => {
  const plane = subdivideMesh(
      subdivideMesh(subdivideMesh(createPrimitiveMesh('plane', 'tile'), { createId }).mesh, { createId }).mesh,
      { createId },
    ).mesh,
    middle = (face) => !face.vertices.every((v) => Math.hypot(plane.vertices[v][0], plane.vertices[v][2]) < 0.3),
    open = without(plane, middle),
    { mesh, holes } = fillMeshHoles(open, { createId }),
    hole = holes.find((item) => item.vertices.length < 30),
    edges = hole.vertices.map((v, i) =>
      Math.hypot(
        ...[0, 1, 2].map((k) => mesh.vertices[v][k] - mesh.vertices[hole.vertices[(i + 1) % hole.vertices.length]][k]),
      ),
    ),
    mean = edges.reduce((a, b) => a + b) / edges.length;
  compilePolygonMesh(mesh);
  for (const id of hole.faces) {
    const face = mesh.faces.find((f) => f.id === id);
    face.vertices.forEach((v, i) => {
      const w = face.vertices[(i + 1) % face.vertices.length],
        size = Math.hypot(...[0, 1, 2].map((k) => mesh.vertices[v][k] - mesh.vertices[w][k]));
      assert.ok(size <= mean * 2.2, `edge ${size} against mean ${mean}`);
    });
    assert.ok(mesh.vertices[face.vertices[0]][1] === mesh.vertices[hole.vertices[0]][1]);
  }
});

test('grid mode makes quads over a long even border, triangles on an odd one', () => {
  const ring = [];
  for (let i = 0; i < 16; i++) ring.push([Math.cos((i / 16) * Math.PI * 2), 0, -Math.sin((i / 16) * Math.PI * 2)]);
  const collar = {
      vertices: [...ring, ...ring.map(([x, , z]) => [x * 2, 0, z * 2])],
      faces: ring.map((_, i) => {
        const j = (i + 1) % 16;
        return {
          id: `c${i}`,
          vertices: [16 + i, 16 + j, j, i],
          uv: [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ],
        };
      }),
    },
    { mesh, holes } = fillMeshHoles(collar, { mode: 'grid', createId }),
    inner = holes.find((hole) => hole.faces.length);
  compilePolygonMesh(mesh);
  assert.ok(holes.length === 2);
  const quads = mesh.faces.filter((face) => face.vertices.length === 4 && !face.id.startsWith('c'));
  assert.ok(quads.length >= 8, `${quads.length} quads`);
  assert.ok(inner);
  const odd = createPrimitiveMesh('cylinder', 'can'),
    side = without(odd, (face) => face.vertices.length === 4),
    { mesh: closed } = fillMeshHoles(side, { mode: 'grid', createId });
  assertClosed(closed);
});

test('maxEdges leaves big holes open, big holes fill by a fan', () => {
  const count = 300,
    ring = Array.from({ length: count }, (_, i) => [
      Math.cos((i / count) * Math.PI * 2),
      0,
      -Math.sin((i / count) * Math.PI * 2),
    ]),
    collar = {
      vertices: [...ring, ...ring.map(([x, , z]) => [x * 2, 0, z * 2])],
      faces: ring.map((_, i) => ({
        id: `c${i}`,
        vertices: [count + i, count + ((i + 1) % count), (i + 1) % count, i],
        uv: [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      })),
    },
    kept = fillMeshHoles(collar, { maxEdges: 10, createId });
  assert.equal(kept.mesh.faces.length, count);
  assert.equal(kept.holes.length, 2);
  assert.ok(kept.diagnostics.some((line) => line.includes('left open')));
  const inner = fillMeshHoles(collar, { createId, refine: false });
  compilePolygonMesh(inner.mesh);
  assert.ok(inner.holes.every((hole) => hole.faces.length));
});

test('deterministic IDs through createId, bad options, abort', () => {
  const cube = createPrimitiveMesh('cube', 'box'),
    open = without(cube, (face) => face.id !== cube.faces[0].id);
  assert.throws(() => fillMeshHoles(open, { mode: 'hexes' }), TypeError);
  assert.throws(() => fillMeshHoles(open, { maxEdges: 2 }), RangeError);
  assert.throws(() => fillMeshHoles(open, { createId: 1 }), TypeError);
  assert.throws(() => fillMeshHoles(open, { signal: {} }), TypeError);
  assert.throws(() => fillMeshHoles(open, { signal: AbortSignal.abort(new RangeError('stop')) }), { message: 'stop' });
  let n = 0;
  const one = fillMeshHoles(open, { createId: () => `x${n++}` });
  n = 0;
  assert.deepEqual(fillMeshHoles(open, { createId: () => `x${n++}` }).mesh, one.mesh);
});
