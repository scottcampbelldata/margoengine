import assert from 'node:assert/strict';
import test from 'node:test';
import * as engine from '../dist/index.js';

function grid(width = 2, height = 1) {
  const vertices = [],
    faces = [];
  for (let y = 0; y <= height; y++) for (let x = 0; x <= width; x++) vertices.push([x, y, 0]);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const a = y * (width + 1) + x;
      faces.push({
        id: `f-${x}-${y}`,
        vertices: [a, a + 1, a + width + 2, a + width + 1],
        uv: [
          [0.1, 0.1],
          [0.3, 0.1],
          [0.3, 0.4],
          [0.1, 0.4],
        ],
      });
    }
  return { vertices, faces };
}
function edges(mesh) {
  const result = new Map();
  for (const f of mesh.faces)
    f.vertices.forEach((a, i) => {
      const b = f.vertices[(i + 1) % f.vertices.length],
        id = [Math.min(a, b), Math.max(a, b)].join(':');
      if (!result.has(id)) result.set(id, []);
      result.get(id).push({ face: f.id, a, b });
    });
  return result;
}
function exactRetained(source, result) {
  for (const f of result.mesh.faces) {
    const old = source.faces.find((x) => x.id === f.id);
    assert(old);
    assert.deepEqual(f.uv, old.uv);
    assert.deepEqual(
      f.vertices.map((i) => result.mesh.vertices[i]),
      old.vertices.map((i) => source.vertices[i]),
    );
    assert.deepEqual(
      f.vertices,
      old.vertices.map((i) => result.vertexMap[i][0]),
    );
  }
  const after = edges(result.mesh);
  for (const [id, list] of edges(source)) {
    const a = list[0].a,
      b = list[0].b,
      retained = list.some((i) => result.mesh.faces.some((f) => f.id === i.face));
    const mapped = retained ? [[result.vertexMap[a][0], result.vertexMap[b][0]].sort((a, b) => a - b).join(':')] : [];
    assert.deepEqual(result.edgeMap[id], mapped);
    if (mapped.length) assert(after.has(mapped[0]));
  }
  assert.deepEqual(result.createdEdges, []);
}

test('component deletion is a public Margo operation', () =>
  assert.equal(typeof engine.deleteMeshComponents, 'function'));
test('face deletion preserves exact retained corners and semantic edge IDs through compaction collisions', () => {
  const source = grid(),
    before = structuredClone(source),
    r = engine.deleteMeshComponents(source, { mode: 'face', faces: ['f-0-0', 'f-0-0'] });
  assert(r.changed);
  assert.deepEqual(r.removedFaces, ['f-0-0']);
  assert.deepEqual(r.removedVertices, [0, 3]);
  assert.deepEqual(r.vertexMap, [[], [0], [1], [], [2], [3]]);
  assert.deepEqual(r.faceMap, { 'f-0-0': [], 'f-1-0': ['f-1-0'] });
  assert.deepEqual(r.edgeMap['0:1'], []);
  assert.deepEqual(r.edgeMap['1:2'], ['0:1']);
  assert(r.removedEdges.includes('0:1'));
  assert(!r.removedEdges.includes('1:2'));
  assert.equal(r.boundaryEdges.length, 4);
  assert.deepEqual(r.affectedFaces, ['f-1-0']);
  exactRetained(source, r);
  assert.deepEqual(source, before);
});
test('affected-only pruning preserves preexisting loose vertices; false retains unselected former corners', () => {
  const source = grid();
  source.vertices.push([9, 9, 9]);
  const a = engine.deleteMeshComponents(source, { mode: 'face', faces: ['f-0-0'] }),
    b = engine.deleteMeshComponents(source, { mode: 'face', faces: ['f-0-0'] }, { pruneUnusedVertices: false });
  assert.deepEqual(a.mesh.vertices.at(-1), [9, 9, 9]);
  assert.deepEqual(a.removedVertices, [0, 3]);
  assert.deepEqual(b.mesh.vertices, source.vertices);
  assert.deepEqual(b.removedVertices, []);
  assert.deepEqual(b.mesh.faces[0], source.faces[1]);
  exactRetained(source, a);
  exactRetained(source, b);
});
test('vertex deletion removes incident faces and explicit vertices, with independently selectable pruning', () => {
  const source = grid();
  source.vertices.push([9, 9, 9]);
  const a = engine.deleteMeshComponents(source, { mode: 'vertex', vertices: [1] }),
    b = engine.deleteMeshComponents(source, { mode: 'vertex', vertices: [1] }, { pruneUnusedVertices: false });
  assert.deepEqual(
    a.removedFaces,
    source.faces.map((f) => f.id),
  );
  assert.deepEqual(a.removedVertices, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(a.mesh, { vertices: [[9, 9, 9]], faces: [] });
  assert.deepEqual(b.removedVertices, [1]);
  assert.equal(b.mesh.vertices.length, 6);
  assert.deepEqual(b.mesh.faces, []);
  assert.deepEqual(b.vertexMap[1], []);
  exactRetained(source, a);
  exactRetained(source, b);
});
test('edge deletion removes all incident faces and never silently dissolves or invents a polygon', () => {
  const source = grid(),
    a = engine.deleteMeshComponents(source, { mode: 'edge', edges: ['1:4', '1:4'] }),
    b = engine.deleteMeshComponents(source, { mode: 'edge', edges: ['0:1'] });
  assert.deepEqual(a.mesh, { vertices: [], faces: [] });
  assert.equal(a.removedFaces.length, 2);
  assert.deepEqual(a.boundaryEdges, []);
  assert.equal(b.mesh.faces.length, 1);
  assert.equal(b.mesh.faces[0].id, 'f-1-0');
  exactRetained(source, a);
  exactRetained(source, b);
  assert.equal(engine.compilePolygonMesh(a.mesh).positions.length, 0);
});
test('empty selections are independent owned no-ops, even with loose and empty input geometry', () => {
  const source = grid();
  source.vertices.push([9, 9, 9]);
  for (const selection of [
    { mode: 'vertex', vertices: [] },
    { mode: 'edge', edges: [] },
    { mode: 'face', faces: [] },
  ]) {
    const r = engine.deleteMeshComponents(source, selection);
    assert(!r.changed);
    assert.deepEqual(r.mesh, source);
    assert.notEqual(r.mesh.vertices[0], source.vertices[0]);
    assert.notEqual(r.mesh.faces[0].uv[0], source.faces[0].uv[0]);
    assert.deepEqual(r.removedVertices, []);
    exactRetained(source, r);
  }
  const empty = engine.deleteMeshComponents({ vertices: [], faces: [] }, { mode: 'face', faces: [] });
  assert(!empty.changed);
  assert.deepEqual(empty.boundaryEdges, []);
});
test('explicitly deleting a preexisting loose vertex retains all face geometry and UVs', () => {
  const source = grid();
  source.vertices.push([9, 9, 9]);
  const r = engine.deleteMeshComponents(source, { mode: 'vertex', vertices: [6] });
  assert(r.changed);
  assert.deepEqual(r.mesh, grid());
  assert.deepEqual(r.removedFaces, []);
  assert.deepEqual(r.removedVertices, [6]);
  assert.deepEqual(r.affectedFaces, []);
  exactRetained(source, r);
});
test('open, nonmanifold and winding edge diagnostics report remaining topology and allow deliberate repair', () => {
  const source = {
    vertices: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
    ],
    faces: [
      [0, 1, 2],
      [1, 0, 3],
      [0, 1, 4],
    ].map((vertices, i) => ({
      id: `f${i}`,
      vertices,
      uv: [
        [0, 0],
        [1, 0],
        [0, 1],
      ],
    })),
  };
  const a = engine.deleteMeshComponents(source, { mode: 'face', faces: [] }),
    b = engine.deleteMeshComponents(source, { mode: 'face', faces: ['f2'] }),
    c = engine.deleteMeshComponents(source, { mode: 'face', faces: ['f1'] });
  assert.deepEqual(a.nonManifoldEdges, ['0:1']);
  assert.deepEqual(a.windingConflicts, []);
  assert.deepEqual(b.nonManifoldEdges, []);
  assert.deepEqual(b.windingConflicts, []);
  assert.deepEqual(c.nonManifoldEdges, []);
  assert.deepEqual(c.windingConflicts, ['0:1']);
  assert.equal(b.boundaryEdges.length, 4);
  exactRetained(source, b);
  exactRetained(source, c);
});
test('far and mirrored coordinates, signed zero and hostile face IDs retain exact source values', () => {
  const source = grid();
  source.vertices = source.vertices.map(([x, y]) => [1e9 - x * 2, 1e9 + y * 0.5, -0]);
  source.faces[1].id = '__proto__';
  const r = engine.deleteMeshComponents(source, { mode: 'face', faces: ['f-0-0'] });
  exactRetained(source, r);
  assert(r.mesh.vertices.every((p) => Object.is(p[2], -0)));
  assert.deepEqual(r.faceMap.__proto__, ['__proto__']);
  assert(Object.hasOwn(r.faceMap, '__proto__'));
});
test('malformed/stale selections and unsupported object/options reject without source mutation', () => {
  const source = grid(),
    before = structuredClone(source);
  for (const selection of [
    null,
    {},
    [],
    { mode: 'object' },
    { mode: 'face', faces: ['absent'] },
    { mode: 'face', faces: ['f-0-0', 'absent'] },
    { mode: 'vertex', vertices: [-1] },
    { mode: 'vertex', vertices: [0.5] },
    { mode: 'vertex', vertices: [1, 99] },
    { mode: 'edge', edges: ['1:0'] },
    { mode: 'edge', edges: null },
  ])
    assert.throws(() => engine.deleteMeshComponents(source, selection));
  for (const options of [null, [], true, { pruneUnusedVertices: 0 }, { pruneUnusedVertices: 'false' }])
    assert.throws(() => engine.deleteMeshComponents(source, { mode: 'face', faces: [] }, options));
  assert.deepEqual(source, before);
});
test('independent retained-corner and edge provenance oracles survive many separated/repeated deletion masks', () => {
  for (let seed = 0; seed < 30; seed++) {
    const source = grid(5, 4);
    source.vertices.push([1e6, 2, 3]);
    const before = structuredClone(source),
      ids = source.faces.filter((_, i) => (i * 17 + seed * 11) % 7 < 3).map((f) => f.id),
      r = engine.deleteMeshComponents(source, { mode: 'face', faces: ids });
    exactRetained(source, r);
    assert.deepEqual(source, before);
    const next = engine.deleteMeshComponents(r.mesh, { mode: 'face', faces: r.mesh.faces.map((f) => f.id) });
    exactRetained(r.mesh, next);
    assert.deepEqual(next.mesh, { vertices: [[1e6, 2, 3]], faces: [] });
    assert.deepEqual(source, before);
  }
});
