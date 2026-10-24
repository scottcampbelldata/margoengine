import assert from 'node:assert/strict';
import test from 'node:test';
import { MeshRegionInsetSession, insetMeshRegion, compilePolygonMesh, createPrimitiveMesh } from '../dist/index.js';

function grid(w = 4, h = 3, omit = () => false) {
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
          [0.1, 0.1],
          [0.2, 0.1],
          [0.2, 0.2],
          [0.1, 0.2],
        ],
      });
    }
  return { vertices, faces };
}
const ids = () => {
  let n = 0;
  return { createId: () => `border-${++n}` };
};
const chosen = (mesh) => mesh.faces.map((f) => f.id);
const freeze = (v) => {
  for (const x of Object.values(v)) if (x && typeof x === 'object') freeze(x);
  return Object.freeze(v);
};
function equivalent(a, b) {
  const av = a.mesh.vertices,
    bv = b.mesh.vertices;
  assert.equal(av.length, bv.length);
  for (let i = 0; i < av.length; i++)
    for (let c = 0; c < 3; c++) assert(Math.abs(av[i][c] - bv[i][c]) < 1e-10, `${i}/${c}: ${av[i][c]} != ${bv[i][c]}`);
  assert.deepEqual({ ...a, mesh: { ...a.mesh, vertices: [] } }, { ...b, mesh: { ...b.mesh, vertices: [] } });
}
function borderWidth(source, out, width, m) {
  const point = (p) =>
    m
      ? [
          m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
          m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
          m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
        ]
      : p;
  for (const border of out.borderFaces) {
    const sourceFace = source.faces.find((f) => f.id === border.sourceFaceId),
      face = out.mesh.faces.find((f) => f.id === border.faceId);
    assert.deepEqual(out.mesh.faces.find((f) => f.id === sourceFace.id).uv, sourceFace.uv);
    const [a, b, q, p] = face.vertices.map((i) => point(out.mesh.vertices[i])),
      d = b.map((v, i) => v - a[i]);
    for (const v of [p, q]) {
      const e = v.map((v, i) => v - a[i]),
        c = [d[1] * e[2] - d[2] * e[1], d[2] * e[0] - d[0] * e[2], d[0] * e[1] - d[1] * e[0]];
      assert(Math.abs(Math.hypot(...c) / Math.hypot(...d) - width) < 1e-10);
    }
  }
  compilePolygonMesh(out.mesh);
}

test('prepared widths retain independent direct provenance and analytic boundary distances across holes and concavity', () => {
  for (const source of [
    grid(),
    grid(4, 4, (x, y) => x === 1 && y === 1),
    grid(3, 3, (x, y) => x > 0 && y > 0),
    grid(3, 3, (x, y) => x === 1 || y === 1),
  ]) {
    freeze(source);
    const session = new MeshRegionInsetSession(source, chosen(source), ids());
    for (const width of [0.08, 0.28, 0.12, 0.32, 0.1, 0.3]) {
      let out;
      try {
        out = session.inset(width);
      } catch {
        assert.throws(() => insetMeshRegion(source, chosen(source), width, ids()));
        continue;
      }
      equivalent(out, insetMeshRegion(source, chosen(source), width, ids()));
      borderWidth(source, out, width);
    }
    session.dispose();
  }
});
test('prepared captured affine metric retains equal world width and coherent mirrored normals', () => {
  const source = grid(3, 2),
    matrix = [-2, 0.2, 0.3, 0, 0.6, 3, 0.1, 0, 0, 0.2, 0.5, 0, 4, -3, 1, 1],
    original = structuredClone(matrix),
    session = new MeshRegionInsetSession(source, chosen(source), { ...ids(), worldMatrix: matrix });
  matrix.fill(0);
  for (const width of [0.04, 0.2, 0.4, 0.1]) {
    const out = session.inset(width);
    equivalent(out, insetMeshRegion(source, chosen(source), width, { ...ids(), worldMatrix: original }));
    borderWidth(source, out, width, original);
  }
});
test('source, selection, options, returned geometry and every provenance array are isolated from later calls', () => {
  const source = grid(),
    before = structuredClone(source),
    faces = chosen(source),
    options = ids(),
    session = new MeshRegionInsetSession(source, faces, options);
  source.vertices[0][0] = 999;
  source.faces[0].uv[0][0] = 0.9;
  faces.length = 0;
  options.createId = () => '';
  const result = session.inset(0.1),
    saved = structuredClone(result);
  freeze(result);
  equivalent(session.inset(0.1), saved);
  assert.equal(session.inset(0.1).mesh.vertices[0][0], before.vertices[0][0]);
  const changed = session.inset(0.2);
  changed.mesh.vertices[0][0] = 999;
  changed.vertexMap[0].length = 0;
  changed.faceMap[before.faces[0].id].length = 0;
  changed.edgeMap[Object.keys(changed.edgeMap)[0]].length = 0;
  changed.regions[0].boundaryLoops[0].length = 0;
  changed.borderFaces[0].faceId = 'bad';
  equivalent(session.inset(0.1), saved);
  assert.notEqual(session.inset(0.1).mesh.faces[0].uv[0][0], 0.9);
});
test('stable generated border IDs allocate once after complete geometric checks and valid template survives errors', () => {
  let calls = 0;
  const source = grid(),
    session = new MeshRegionInsetSession(source, chosen(source), { createId: () => `s-${++calls}` });
  assert.throws(() => session.inset(2), /width|fold|collapse|cross/i);
  assert.equal(calls, 0);
  const first = session.inset(0.1),
    n = calls;
  assert(n > 0);
  for (const width of [0.3, 0.08, 0.2]) {
    const out = session.inset(width);
    assert.deepEqual(out.createdFaces, first.createdFaces);
    assert.equal(calls, n);
  }
  for (const width of [NaN, Infinity, -1, 1e-20, 2])
    assert.throws(() => session.inset(width), /width|collapse|cross|fold/i);
  assert.equal(calls, n);
  equivalent(session.inset(0.1), first);
});
test('zero and empty selection remain owned no-ops without preparing unsupported closed or curved regions', () => {
  const source = grid(),
    session = new MeshRegionInsetSession(source, chosen(source), {
      createId: () => {
        throw Error('must not allocate');
      },
    }),
    zero = session.inset(0);
  assert(!zero.changed);
  assert.deepEqual(zero.mesh, source);
  zero.mesh.vertices[0][0] = 999;
  assert.deepEqual(session.inset(0).mesh, source);
  const empty = new MeshRegionInsetSession(source, [], ids());
  assert(!empty.inset(1e5).changed);
  assert.deepEqual(empty.inset(1e5).mesh, source);
  const cube = createPrimitiveMesh('cube', 'closed-session-fixture');
  const closed = new MeshRegionInsetSession(cube, chosen(cube), ids());
  assert(!closed.inset(0).changed);
  assert.throws(() => closed.inset(0.1), /boundary/);
});
test('repeated positive candidates cannot skip collapse, crossing, finite geometry or planar topology validation', () => {
  const source = grid(4, 4, (x, y) => x === 1 && y === 1),
    session = new MeshRegionInsetSession(source, chosen(source), ids());
  session.inset(0.1);
  for (const width of [0.5, 0.9, 1, 1e300]) assert.throws(() => session.inset(width));
  borderWidth(source, session.inset(0.2), 0.2);
  const bent = grid(2, 1);
  bent.vertices[2][2] = 0.5;
  bent.vertices[5][2] = 0.5;
  const curved = new MeshRegionInsetSession(bent, chosen(bent), ids());
  assert.throws(() => curved.inset(0.1), /planar/);
  const winding = grid(2, 1);
  winding.faces[1].vertices.reverse();
  const wrong = new MeshRegionInsetSession(winding, chosen(winding), ids());
  assert.throws(() => wrong.inset(0.1), /wound|winding/);
});
test('point-touching regions, selected-only compaction and preexisting loose vertices retain exact mappings', () => {
  const source = grid(3, 3, (x, y) => x !== y);
  source.vertices.push([99, 100, 101]);
  const out = new MeshRegionInsetSession(source, chosen(source), ids()).inset(0.1);
  assert.equal(out.regions.length, 3);
  equivalent(out, insetMeshRegion(source, chosen(source), 0.1, ids()));
  assert(out.mesh.vertices.some((v) => v[0] === 99));
  assert(out.vertexMap[5].length > 1);
  const full = grid(5, 4),
    session = new MeshRegionInsetSession(full, chosen(full), ids());
  for (const width of [0.1, 0.2, 0.3]) {
    const out = session.inset(width);
    assert(out.removedVertices.length > 0);
    equivalent(out, insetMeshRegion(full, chosen(full), width, ids()));
  }
});
test('dispose is standard, idempotent, releases preparation and rejects all further evaluations', () => {
  const source = grid(),
    session = new MeshRegionInsetSession(source, chosen(source), ids());
  session.inset(0.1);
  assert(!session.disposed);
  session[Symbol.dispose]();
  session.dispose();
  assert(session.disposed);
  for (const width of [0, 0.1, NaN])
    assert.throws(
      () => session.inset(width),
      (e) => e.code === 'disposed',
    );
});
test('ID callback reentry and callback disposal cannot publish or poison a prepared result', () => {
  const source = grid();
  let session,
    n = 0;
  session = new MeshRegionInsetSession(source, chosen(source), {
    createId: () => {
      assert.throws(
        () => session.inset(0.2),
        (e) => e.code === 'state',
      );
      return `safe-${++n}`;
    },
  });
  const out = session.inset(0.1);
  borderWidth(source, out, 0.1);
  let disposed;
  disposed = new MeshRegionInsetSession(source, chosen(source), {
    createId: () => {
      disposed.dispose();
      return `x-${++n}`;
    },
  });
  assert.throws(
    () => disposed.inset(0.1),
    (e) => e.code === 'disposed',
  );
  assert(disposed.disposed);
});
test('invalid constructor inputs and generated IDs fail with actionable typed errors', () => {
  const source = grid();
  assert.throws(() => new MeshRegionInsetSession(null, []), TypeError);
  assert.throws(() => new MeshRegionInsetSession(source, ['missing']), TypeError);
  assert.throws(() => new MeshRegionInsetSession(source, [], null), TypeError);
  assert.throws(() => new MeshRegionInsetSession(source, [], { worldMatrix: new Array(16).fill(0) }));
  assert.throws(() => new MeshRegionInsetSession(source, [], { createId: 7 }), TypeError);
  for (const id of ['', source.faces[0].id, null]) {
    const session = new MeshRegionInsetSession(source, chosen(source), { createId: () => id });
    assert.throws(() => session.inset(0.1), TypeError);
    assert(!session.disposed);
  }
});
