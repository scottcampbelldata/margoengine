import assert from 'node:assert/strict';
import test from 'node:test';
import * as engine from '../dist/index.js';

const ids = () => {
  let n = 0;
  return { createId: () => `border-${++n}` };
};
const near = (a, b, e = 1e-11) => assert(Math.abs(a - b) <= e, `${a} != ${b}`);
const frozen = (value) => {
  for (const v of Object.values(value)) if (v && typeof v === 'object') frozen(v);
  return Object.freeze(value);
};
function grid(w = 2, h = 1, omit = () => false) {
  const vertices = [],
    faces = [];
  for (let y = 0; y <= h; y++) for (let x = 0; x <= w; x++) vertices.push([x, y, 0]);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (omit(x, y)) continue;
      const a = y * (w + 1) + x;
      faces.push({
        id: `f-${x}-${y}`,
        vertices: [a, a + 1, a + w + 2, a + w + 1],
        uv: [
          [0.1 + x * 0.1, 0.1 + y * 0.1],
          [0.2 + x * 0.1, 0.1 + y * 0.1],
          [0.2 + x * 0.1, 0.2 + y * 0.1],
          [0.1 + x * 0.1, 0.2 + y * 0.1],
        ],
      });
    }
  return { vertices, faces };
}
function rectangle() {
  return {
    vertices: [
      [0, 0, 0],
      [4, 0, 0],
      [4, 2, 0],
      [0, 2, 0],
    ],
    faces: [
      {
        id: 'q',
        vertices: [0, 1, 2, 3],
        uv: [
          [0.1, 0.1],
          [0.6, 0.1],
          [0.6, 0.4],
          [0.1, 0.4],
        ],
      },
    ],
  };
}
function cap(result, id) {
  return result.mesh.faces.find((f) => f.id === id);
}
function checkRetained(source, result, chosen = source.faces.map((f) => f.id)) {
  const created = new Set(result.createdVertices);
  for (const face of source.faces) {
    const out = cap(result, face.id);
    assert(out);
    assert.deepEqual(out.uv, face.uv);
    if (chosen.includes(face.id))
      for (let c = 0; c < face.vertices.length; c++)
        assert(result.vertexMap[face.vertices[c]].includes(out.vertices[c]));
    else
      assert.deepEqual(
        out.vertices.map((i) => result.mesh.vertices[i]),
        face.vertices.map((i) => source.vertices[i]),
      );
  }
  for (const face of result.mesh.faces)
    for (const i of face.vertices) assert(i >= 0 && i < result.mesh.vertices.length);
  for (const i of result.createdVertices) assert(created.has(i));
  engine.compilePolygonMesh(result.mesh);
}
function incidence(mesh) {
  const edges = new Map();
  for (const face of mesh.faces)
    face.vertices.forEach((a, i) => {
      const b = face.vertices[(i + 1) % face.vertices.length],
        id = `${Math.min(a, b)}:${Math.max(a, b)}`;
      if (!edges.has(id)) edges.set(id, []);
      edges.get(id).push([a, b]);
    });
  return edges;
}
const world = (p, m) =>
  m
    ? [
        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
      ]
    : p;
function edgeDistance(p, a, b) {
  const d = b.map((v, i) => v - a[i]),
    q = p.map((v, i) => v - a[i]),
    cross = [d[1] * q[2] - d[2] * q[1], d[2] * q[0] - d[0] * q[2], d[0] * q[1] - d[1] * q[0]];
  return Math.hypot(...cross) / Math.hypot(...d);
}
function widthOracle(source, result, width, matrix, e = 1e-11) {
  for (const face of source.faces) {
    const out = cap(result, face.id);
    face.vertices.forEach((v, i) => {
      const next = face.vertices[(i + 1) % face.vertices.length],
        edge = incidence(source).get(`${Math.min(v, next)}:${Math.max(v, next)}`);
      if (edge.length !== 1) return;
      const a = world(source.vertices[v], matrix),
        b = world(source.vertices[next], matrix);
      for (const c of [i, (i + 1) % face.vertices.length])
        near(edgeDistance(world(result.mesh.vertices[out.vertices[c]], matrix), a, b), width, e);
    });
  }
}

test('equal-width rectangular region differs deliberately from the retained legacy centroid inset', () => {
  const source = frozen(rectangle()),
    out = engine.insetMeshRegion(source, ['q'], 0.25, ids());
  assert(out.changed);
  assert.equal(out.borderFaces.length, 4);
  assert.equal(out.regions[0].boundaryLoops.length, 1);
  assert.deepEqual(out.mesh.vertices.slice(0, 4), source.vertices);
  out.mesh.faces[0].vertices.forEach((v, i) => {
    const p = out.mesh.vertices[v],
      expected = [
        [0.25, 0.25, 0],
        [3.75, 0.25, 0],
        [3.75, 1.75, 0],
        [0.25, 1.75, 0],
      ][i];
    p.forEach((n, j) => near(n, expected[j]));
  });
  widthOracle(source, out, 0.25);
  checkRetained(source, out);
  const legacy = engine.insetMeshFace(source, 'q', 0.15, ids()),
    p = legacy.mesh.vertices[legacy.mesh.faces[0].vertices[0]];
  near(p[0], 0.3);
  near(p[1], 0.15);
});
test('adjacent faces share one cap edge and only region boundaries get borders', () => {
  const source = frozen(grid()),
    out = engine.insetMeshRegion(
      source,
      source.faces.map((f) => f.id),
      0.1,
      ids(),
    );
  assert.equal(out.capFaces.length, 2);
  assert.equal(out.borderFaces.length, 6);
  assert.equal(out.mesh.faces.length, 8);
  assert.equal(out.createdVertices.length, 6);
  const shared = cap(out, 'f-0-0').vertices.filter((v) => cap(out, 'f-1-0').vertices.includes(v));
  assert.equal(shared.length, 2);
  const id = `${Math.min(...shared)}:${Math.max(...shared)}`;
  assert.equal(incidence(out.mesh).get(id).length, 2);
  assert.equal(out.borderFaces.filter((f) => f.sourceEdgeId === '1:4').length, 0);
  assert.deepEqual(out.edgeMap['1:4'], [id]);
  assert(out.removedEdges.includes('1:4'));
  checkRetained(source, out);
  widthOracle(source, out, 0.1);
});
test('collinear boundary subdivisions redistribute proportionally instead of reversing near a corner', () => {
  const source = grid();
  for (const p of source.vertices) p[0] = p[0] === 1 ? 0.1 : p[0];
  const out = engine.insetMeshRegion(
    source,
    source.faces.map((f) => f.id),
    0.2,
    ids(),
  );
  widthOracle(source, out, 0.2);
  const middle = out.mesh.vertices[cap(out, 'f-0-0').vertices[1]];
  near(middle[0], 0.28);
  near(middle[1], 0.2);
  checkRetained(source, out);
});
test('oblique triangle offsets both incident lines by the exact requested width', () => {
  const source = {
    vertices: [
      [0, 0, 0],
      [4, 0, 0],
      [1, 3, 0],
    ],
    faces: [
      {
        id: 't',
        vertices: [0, 1, 2],
        uv: [
          [0.1, 0.1],
          [0.8, 0.2],
          [0.3, 0.8],
        ],
      },
    ],
  };
  const out = engine.insetMeshRegion(source, ['t'], 0.2, ids());
  widthOracle(source, out, 0.2);
  checkRetained(source, out);
});
test('a concave L-shaped union remains connected without inserting internal border faces', () => {
  const source = grid(2, 2, (x, y) => x === 1 && y === 1),
    out = engine.insetMeshRegion(
      source,
      source.faces.map((f) => f.id),
      0.1,
      ids(),
    );
  assert.equal(out.regions.length, 1);
  assert.equal(out.regions[0].boundaryLoops.length, 1);
  assert.equal(out.borderFaces.length, 8);
  checkRetained(source, out);
  widthOracle(source, out, 0.1);
});
test('annular selected region offsets the outer loop inward and hole outward', () => {
  const source = grid(3, 3, (x, y) => x === 1 && y === 1),
    out = engine.insetMeshRegion(
      source,
      source.faces.map((f) => f.id),
      0.1,
      ids(),
    );
  assert.equal(out.regions[0].boundaryLoops.length, 2);
  assert.equal(out.borderFaces.length, 16);
  const bottom = cap(out, 'f-1-0'),
    p = out.mesh.vertices[bottom.vertices[2]],
    q = out.mesh.vertices[bottom.vertices[3]];
  near(p[0], 2.1);
  near(p[1], 0.9);
  near(q[0], 0.9);
  near(q[1], 0.9);
  widthOracle(source, out, 0.1);
  checkRetained(source, out);
});
test('interior displacement stays coherent and old interior vertices compact while preexisting loose ones remain', () => {
  const source = grid(2, 2);
  source.vertices.push([99, 98, 97]);
  const out = engine.insetMeshRegion(
    frozen(source),
    source.faces.map((f) => f.id),
    0.1,
    ids(),
  );
  assert.deepEqual(out.removedVertices, [4]);
  assert.equal(out.vertexMap[4].length, 1);
  assert(out.createdVertices.includes(out.vertexMap[4][0]));
  const p = out.mesh.vertices[out.vertexMap[4][0]];
  near(p[0], 1);
  near(p[1], 1);
  assert.deepEqual(out.mesh.vertices[out.vertexMap[9][0]], [99, 98, 97]);
  assert(out.diagnostics.length === 0);
  checkRetained(source, out);
  widthOracle(source, out, 0.1);
});
test('multiple interior rows solve bounded harmonic displacements on a non-square patch', () => {
  const source = grid(5, 4);
  for (const p of source.vertices) p[0] *= 2;
  const out = engine.insetMeshRegion(
    source,
    source.faces.map((f) => f.id),
    0.25,
    ids(),
  );
  widthOracle(source, out, 0.25);
  for (let y = 1; y < 4; y++)
    for (let x = 1; x < 5; x++) {
      const i = y * 6 + x,
        p = out.mesh.vertices[out.vertexMap[i].find((v) => out.createdVertices.includes(v))];
      near(p[0], 0.25 + (9.5 * x) / 5, 1e-10);
      near(p[1], 0.25 + (3.5 * y) / 4, 1e-10);
    }
  checkRetained(source, out);
});
test('world metric retains equal width through reflection, nonuniform scale, shear and translation', () => {
  const source = rectangle(),
    matrix = [-2, 0.3, 0.2, 0, 0.4, 3, 0.6, 0, 0.2, 0.1, 1, 0, 8, -4, 2, 1],
    out = engine.insetMeshRegion(source, ['q'], 0.2, { ...ids(), worldMatrix: matrix });
  widthOracle(source, out, 0.2, matrix);
  checkRetained(source, out);
  assert.deepEqual(source, rectangle());
});
test('large translated coordinates preserve representable width without arbitrary tolerance inflation', () => {
  const source = rectangle();
  for (const p of source.vertices) {
    p[0] += 1e7;
    p[1] -= 2e7;
  }
  const out = engine.insetMeshRegion(source, ['q'], 0.25, ids());
  widthOracle(source, out, 0.25, undefined, 1e-8);
  checkRetained(source, out);
});
test('reversed coherent winding and transformed planar axes retain valid outward border winding', () => {
  const source = rectangle();
  for (const p of source.vertices) [p[0], p[1], p[2]] = [p[0], 2, p[1]];
  source.faces[0].vertices.reverse();
  source.faces[0].uv.reverse();
  const out = engine.insetMeshRegion(source, ['q'], 0.2, ids());
  widthOracle(source, out, 0.2);
  checkRetained(source, out);
});
test('point-touching and disconnected regions get independent caps and explicit source descendants', () => {
  const source = grid(2, 2, (x, y) => x !== y),
    out = engine.insetMeshRegion(
      source,
      source.faces.map((f) => f.id),
      0.1,
      ids(),
    );
  assert.equal(out.regions.length, 2);
  assert.equal(out.borderFaces.length, 8);
  assert.equal(out.vertexMap[4].filter((i) => out.createdVertices.includes(i)).length, 2);
  assert(cap(out, 'f-0-0').vertices.every((v) => !cap(out, 'f-1-1').vertices.includes(v)));
  checkRetained(source, out);
});
test('successive insets retain existing borders, exact cap UVs and distinct face identities', () => {
  const source = rectangle(),
    one = engine.insetMeshRegion(source, ['q'], 0.2, ids()),
    two = engine.insetMeshRegion(one.mesh, ['q'], 0.1, {
      createId: (() => {
        let i = 0;
        return () => `second-${++i}`;
      })(),
    });
  assert.equal(two.mesh.faces.length, 9);
  for (const face of one.mesh.faces.filter((f) => f.id !== 'q')) assert.deepEqual(cap(two, face.id), face);
  assert.deepEqual(cap(two, 'q').uv, source.faces[0].uv);
  near(two.mesh.vertices[cap(two, 'q').vertices[0]][0], 0.3);
});
test('width zero and empty selection are owned no-ops without allocating IDs', () => {
  const source = frozen(rectangle());
  for (const [faces, width] of [
    [['q'], 0],
    [[], 0.1],
  ]) {
    const out = engine.insetMeshRegion(source, faces, width, { createId: () => assert.fail('no ID for no-op') });
    assert(!out.changed);
    assert.deepEqual(out.mesh, source);
    assert.notEqual(out.mesh, source);
    assert.notEqual(out.mesh.vertices, source.vertices);
    assert.deepEqual(out.borderFaces, []);
    assert.deepEqual(out.regions, []);
    assert.deepEqual(out.createdVertices, []);
  }
});
test('collapsed, crossed and oversized widths fail atomically instead of silently clamping', () => {
  const source = frozen(rectangle());
  for (const width of [1, 1.001, 2, 100])
    assert.throws(() => engine.insetMeshRegion(source, ['q'], width, ids()), /width|collapse|cross/i);
  assert.deepEqual(source, rectangle());
});
test('nonplanar adjacent patches and branched boundaries reject before publishing a candidate', () => {
  const bent = grid();
  bent.vertices[2][2] = 0.5;
  bent.vertices[5][2] = 0.5;
  assert.throws(
    () =>
      engine.insetMeshRegion(
        bent,
        bent.faces.map((f) => f.id),
        0.1,
        ids(),
      ),
    /planar/,
  );
  const pinch = grid(3, 3, (x, y) => (x === 0 && y === 0) || (x === 1 && y === 1));
  assert.throws(
    () =>
      engine.insetMeshRegion(
        pinch,
        pinch.faces.map((f) => f.id),
        0.05,
        ids(),
      ),
    /branch|cross|overlap|unwelded/,
  );
});
test('inconsistent winding and nonmanifold incident edges reject without source mutation', () => {
  const source = grid();
  source.faces[1].vertices.reverse();
  source.faces[1].uv.reverse();
  const before = structuredClone(source);
  assert.throws(() => engine.insetMeshRegion(source, ['f-0-0'], 0.1, ids()), /nonmanifold|wound/);
  assert.deepEqual(source, before);
  const extra = grid();
  extra.faces.push({ ...structuredClone(extra.faces[1]), id: 'third' });
  assert.throws(() => engine.insetMeshRegion(extra, ['f-0-0'], 0.1, ids()), /nonmanifold/);
});
test('invalid widths, metric transforms, identities and ID generators produce actionable failures', () => {
  const source = frozen(rectangle());
  for (const width of [-0.1, NaN, Infinity]) assert.throws(() => engine.insetMeshRegion(source, ['q'], width), /width/);
  for (const matrix of [
    [],
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1],
    Array(16).fill(0),
    [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  ])
    assert.throws(() => engine.insetMeshRegion(source, ['q'], 0.1, { worldMatrix: matrix }), /matrix|affine|scale/i);
  assert.throws(() => engine.insetMeshRegion(source, ['absent'], 0.1), /identity/);
  assert.throws(() => engine.insetMeshRegion(source, ['q'], 0.1, { createId: () => 'q' }), /unique/);
  assert.throws(() => engine.insetMeshRegion(source, ['q'], 0.1, null), /options/);
  assert.deepEqual(source, rectangle());
});
test('a selected cube face preserves a closed two-manifold boundary and all unselected geometry', () => {
  const source = engine.createPrimitiveMesh('cube', 'closed-fixture'),
    face = source.faces[0],
    out = engine.insetMeshRegion(frozen(source), [face.id], 0.1, ids());
  checkRetained(source, out, [face.id]);
  widthOracle({ ...source, faces: [face] }, out, 0.1);
  for (const incidents of incidence(out.mesh).values()) {
    assert.equal(incidents.length, 2);
    assert.deepEqual(incidents[0], [...incidents[1]].reverse());
  }
  assert.throws(
    () =>
      engine.insetMeshRegion(
        source,
        source.faces.map((f) => f.id),
        0.1,
        ids(),
      ),
    /boundary/,
  );
});
test('96 analytic convex cases conserve planar area and exact border width across winding and affine metrics', () => {
  const areaOf = (mesh) =>
    mesh.faces.reduce(
      (sum, f) =>
        sum +
        Math.abs(
          f.vertices.reduce((s, i, c) => {
            const p = mesh.vertices[i],
              q = mesh.vertices[f.vertices[(c + 1) % f.vertices.length]];
            return s + p[0] * q[1] - p[1] * q[0];
          }, 0),
        ) /
          2,
      0,
    );
  for (let k = 0; k < 96; k++) {
    const count = 3 + (k % 30),
      vertices = Array.from({ length: count }, (_, i) => {
        const a = (2 * Math.PI * i) / count + 0.017 * k;
        return [2 * Math.cos(a), (0.6 + 0.02 * (k % 13)) * Math.sin(a), 0];
      }),
      face = {
        id: 'analytic',
        vertices: vertices.map((_, i) => i),
        uv: vertices.map(([x, y]) => [0.5 + x * 0.1, 0.5 + y * 0.1]),
      };
    if (k % 2) {
      face.vertices.reverse();
      face.uv.reverse();
    }
    const source = { vertices, faces: [face] },
      matrix = k % 3 ? [1.1, 0.2, 0, 0, -0.3, k % 2 ? -1.3 : 1.3, 0, 0, 0, 0, 1, 0, 3, -2, 0, 1] : undefined,
      width = 0.025,
      out = engine.insetMeshRegion(source, [face.id], width, { ...ids(), worldMatrix: matrix });
    widthOracle(source, out, width, matrix, 2e-11);
    near(areaOf(out.mesh), areaOf(source), 1e-10);
    checkRetained(source, out);
  }
});
test('tiny but well-scaled local geometry keeps finite equal-width caps', () => {
  const source = rectangle(),
    factor = 1e-60;
  for (const p of source.vertices) for (let i = 0; i < 3; i++) p[i] *= factor;
  const out = engine.insetMeshRegion(source, ['q'], factor * 0.25, ids());
  widthOracle(source, out, factor * 0.25, undefined, 1e-71);
  checkRetained(source, out);
  assert(out.mesh.vertices.flat().every(Number.isFinite));
});
