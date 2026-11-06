import assert from 'node:assert/strict';
import test from 'node:test';
import { booleanMeshesExact } from '@margoengine/mesh-edit/boolean-exact';
import { booleanMeshes } from '@margoengine/mesh-edit/modeling';
import { compilePolygonMesh, createPrimitiveMesh, polygonMeshEdges } from '@margoengine/mesh-edit';

const ids = () => {
  let next = 0;
  return () => `new-${next++}`;
};

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

const moved = (mesh, prefix, map) => ({
  vertices: mesh.vertices.map((p) => map(p)),
  faces: mesh.faces.map((face) => ({ ...face, id: prefix + face.id })),
});

const shifted = (mesh, prefix, [x, y, z]) => moved(mesh, prefix, (p) => [p[0] + x, p[1] + y, p[2] + z]);

const rotated = (mesh, prefix, angle, axis = 2) =>
  moved(mesh, prefix, (p) => {
    const u = axis === 0 ? 1 : 0,
      v = axis === 2 ? 1 : 2,
      out = [...p],
      c = Math.cos(angle),
      s = Math.sin(angle);
    out[u] = p[u] * c - p[v] * s;
    out[v] = p[u] * s + p[v] * c;
    return out;
  });

/** Every half-edge has its reverse, and the mesh passes the strict validator (compile runs it). */
function assertClosed(mesh) {
  compilePolygonMesh(mesh);
  for (const edge of polygonMeshEdges(mesh)) {
    assert.equal(edge.incidences.length % 2, 0, `edge ${edge.id} has an odd face count`);
    const forward = edge.incidences.filter((use) => use.from === edge.vertices[0]).length;
    assert.equal(forward * 2, edge.incidences.length, `edge ${edge.id} is not matched by its reverse`);
  }
}

/** The three operations agree with each other: |A u B| + |A n B| = |A| + |A \ B| + |A n B| + ... */
function assertConsistent(a, b, tolerance) {
  const createId = ids(),
    union = booleanMeshesExact(a, b, 'union', { createId }),
    both = booleanMeshesExact(a, b, 'intersection', { createId }),
    only = booleanMeshesExact(a, b, 'difference', { createId });
  for (const { mesh } of [union, both, only]) assertClosed(mesh);
  assert.ok(Math.abs(volume(union.mesh) + volume(both.mesh) - volume(a) - volume(b)) <= tolerance, 'union + both');
  assert.ok(Math.abs(volume(only.mesh) + volume(both.mesh) - volume(a)) <= tolerance, 'only + both');
}

const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

test('plain overlap matches the known volumes and the tolerance boolean', () => {
  const box = createPrimitiveMesh('cube', 'a'),
    other = shifted(box, 'b', [0.3, 0.15, -0.1]),
    createId = ids();
  for (const operation of ['union', 'difference', 'intersection']) {
    const exact = booleanMeshesExact(box, other, operation, { createId }),
      float = booleanMeshes(box, other, operation, { createId });
    assertClosed(exact.mesh);
    assert.ok(Math.abs(volume(exact.mesh) - volume(float.mesh)) < 1e-12);
    assert.equal(exact.collapsedFaces, 0);
  }
});

test('regression: offsets the tolerance boolean refuses are exact here', () => {
  const box = createPrimitiveMesh('cube', 'a'),
    near = shifted(box, 'b', [1e-9, 5e-10, -1e-9 / 3]),
    createId = ids();
  assert.throws(() => booleanMeshes(box, near, 'union', { createId }), { code: 'failed' });
  assertConsistent(box, near, 1e-8);
});

test('nearly coincident faces at every scale down to one unit in the last place', () => {
  const box = createPrimitiveMesh('cube', 'a');
  for (const d of [1e-3, 1e-6, 1e-8, 1e-9, 1e-10, 1e-12, 1e-14, 1e-15, 2 ** -52, 2 ** -53, 1e-300])
    assertConsistent(box, shifted(box, 'b', [d, d / 2, -d / 3]), 1e-7);
});

test('nearly parallel faces: a turn of a few units in the last place', () => {
  const box = createPrimitiveMesh('cube', 'a');
  for (const angle of [1e-6, 1e-9, 1e-12, 1e-15, 3e-16])
    for (const axis of [0, 1, 2]) assertConsistent(box, rotated(box, 'b', angle, axis), 1e-7);
});

test('exact contact: shared faces, an edge, a corner, nested, apart, identical', () => {
  const box = createPrimitiveMesh('cube', 'a'),
    createId = ids(),
    stacked = shifted(box, 'b', [1, 0, 0]),
    union = booleanMeshesExact(box, stacked, 'union', { createId });
  assertClosed(union.mesh);
  assert.equal(volume(union.mesh), 2);
  assert.equal(booleanMeshesExact(box, stacked, 'intersection', { createId }).mesh.faces.length, 0);
  assert.equal(booleanMeshesExact(box, box, 'difference', { createId }).mesh.faces.length, 0);
  assert.equal(volume(booleanMeshesExact(box, shifted(box, 'c', [5, 0, 0]), 'union', { createId }).mesh), 2);
  const edge = booleanMeshesExact(box, shifted(box, 'd', [1, 1, 0]), 'union', { createId });
  assert.equal(edge.nonManifoldEdges, 1);
  const inner = moved(box, 'e', (p) => p.map((x) => x / 2)),
    hollow = booleanMeshesExact(box, inner, 'difference', { createId });
  assertClosed(hollow.mesh);
  assert.equal(volume(hollow.mesh), 1 - 1 / 8);
});

test('seeded fuzz: rotated and offset solids stay closed and consistent', () => {
  const next = random(20261105),
    shapes = ['cube', 'cylinder', 'wedge'];
  for (let round = 0; round < 60; round++) {
    const a = createPrimitiveMesh(shapes[round % 3], 'a'),
      b = createPrimitiveMesh(shapes[(round + 1) % 3], 'b'),
      scale = 10 ** -(next() * 16),
      offset = [0, 1, 2].map(() => (next() - 0.5) * scale),
      turned = rotated(b, 'c', (next() - 0.5) * scale, round % 3);
    assertConsistent(a, shifted(turned, 'd', offset), 1e-6);
  }
});

test('results feed the next boolean, and extreme coordinates work', () => {
  const box = createPrimitiveMesh('cube', 'a'),
    createId = ids();
  let mesh = box;
  for (let i = 1; i <= 6; i++) {
    const cutter = moved(box, `c${i}`, (p) => [p[0] * 0.2 + 0.1 * i - 0.35, p[1] * 2, p[2] * 0.2 + 0.05 * i]);
    mesh = booleanMeshesExact(mesh, cutter, 'difference', { createId }).mesh;
    assertClosed(mesh);
  }
  for (const size of [1e-200, 1e200]) {
    const big = moved(box, 'p', (p) => p.map((x) => x * size)),
      over = shifted(big, 'q', [size / 3, 0, 0]),
      result = booleanMeshesExact(big, over, 'union', { createId });
    assert.equal(result.collapsedFaces, 0);
    assertClosed(result.mesh);
  }
});

test('provenance, UVs and inputs follow the tolerance boolean', () => {
  const box = createPrimitiveMesh('cube', 'a'),
    other = shifted(box, 'b', [0.5, 0, 0]),
    before = JSON.stringify(box),
    { mesh, sources, faceMap } = booleanMeshesExact(box, other, 'difference', { createId: ids() });
  assert.equal(JSON.stringify(box), before);
  for (const face of mesh.faces) {
    assert.ok(sources[face.id]);
    assert.ok(faceMap[sources[face.id].input][sources[face.id].face].includes(face.id));
  }
  // The -X cap keeps its face and the cut side faces come from the other solid, turned inward.
  assert.ok(Object.values(sources).some((source) => source.input === 'b'));
  const whole = mesh.faces.find((face) => face.vertices.every((v) => mesh.vertices[v][0] === -0.5)),
    source = box.faces.find((face) => face.vertices.every((v) => box.vertices[v][0] === -0.5));
  assert.equal(sources[whole.id].face, source.id);
  assert.deepEqual([...whole.uv].flat().sort(), [...source.uv].flat().sort());
  // A half-way cut lands half way along the source face's UVs.
  const top = box.faces.find((face) => face.vertices.every((v) => box.vertices[v][1] === 0.5)),
    piece = mesh.faces.find((face) => sources[face.id].face === top.id),
    u = (corner) => {
      const at = top.vertices.findIndex((v) => box.vertices[v][0] === -0.5 && box.vertices[v][2] === corner);
      return top.uv[at];
    },
    cut = piece.vertices.findIndex((v) => mesh.vertices[v][0] === 0 && mesh.vertices[v][2] === 0.5);
  assert.deepEqual(
    piece.uv[cut].map((x) => Math.round(x * 1e12) / 1e12),
    [0, 1].map((k) => {
      const far = top.vertices.findIndex((v) => box.vertices[v][0] === 0.5 && box.vertices[v][2] === 0.5);
      return Math.round(((u(0.5)[k] + top.uv[far][k]) / 2) * 1e12) / 1e12;
    }),
  );
});

test('bad input and abort', () => {
  const box = createPrimitiveMesh('cube', 'a'),
    other = shifted(box, 'b', [0.5, 0, 0]);
  assert.throws(() => booleanMeshesExact(box, other, 'xor'), TypeError);
  assert.throws(() => booleanMeshesExact(createPrimitiveMesh('plane', 'p'), other, 'union'), TypeError);
  assert.throws(() => booleanMeshesExact(box, other, 'union', { createId: 3 }), TypeError);
  assert.throws(() => booleanMeshesExact(box, other, 'union', { signal: {} }), TypeError);
  assert.throws(() => booleanMeshesExact(box, other, 'union', { signal: AbortSignal.abort(new RangeError('stop')) }), {
    message: 'stop',
  });
});

test('regression: only the overlap box goes through the trees, and the answer stays the exact one', () => {
  const box = createPrimitiveMesh('cube', 'a'),
    // Far apart, touching along a face, and with one box wholly inside the other: every way the box filter can go.
    far = shifted(box, 'b', [5, 0, 0]),
    touching = shifted(box, 'b', [1, 0, 0]),
    inner = moved(box, 'b', (p) => p.map((v) => v * 0.5)),
    size = volume(box),
    createId = ids();
  for (const [other, union, difference, intersection] of [
    [far, 2 * size, size, 0],
    [touching, 2 * size, size, 0],
    [inner, size, size - size / 8, size / 8],
  ]) {
    const u = booleanMeshesExact(box, other, 'union', { createId }),
      d = booleanMeshesExact(box, other, 'difference', { createId });
    assertClosed(u.mesh);
    assertClosed(d.mesh);
    assert.ok(Math.abs(volume(u.mesh) - union) < 1e-12);
    assert.ok(Math.abs(volume(d.mesh) - difference) < 1e-12);
    if (intersection) assert.ok(Math.abs(volume(booleanMeshesExact(box, other, 'intersection', { createId }).mesh) - intersection) < 1e-12);
    else assert.equal(booleanMeshesExact(box, other, 'intersection', { createId }).mesh.faces.length, 0);
  }
});

test('regression: a small cut in a large mesh costs the faces near it', () => {
  const sphere = (n, prefix, [x, y, z], s) => {
      const vertices = [[x, y + s, z]],
        faces = [];
      for (let r = 1; r < n; r++)
        for (let c = 0; c < n; c++) {
          const t = (Math.PI * r) / n,
            p = (2 * Math.PI * c) / n;
          vertices.push([x + s * Math.sin(t) * Math.cos(p), y + s * Math.cos(t), z + s * Math.sin(t) * Math.sin(p)]);
        }
      vertices.push([x, y - s, z]);
      const at = (r, c) => 1 + (r - 1) * n + (c % n),
        bottom = vertices.length - 1,
        add = (...v) => faces.push({ id: prefix + faces.length, vertices: v, uv: v.map(() => [0, 0]) });
      for (let c = 0; c < n; c++) {
        add(0, at(1, c + 1), at(1, c));
        add(bottom, at(n - 1, c), at(n - 1, c + 1));
        for (let r = 1; r < n - 1; r++) {
          add(at(r, c), at(r, c + 1), at(r + 1, c + 1));
          add(at(r, c), at(r + 1, c + 1), at(r + 1, c));
        }
      }
      return { vertices, faces };
    },
    large = sphere(40, 'a', [0, 0, 0], 1),
    // The first and last face of the large sphere lie outside the cut's box: their IDs and corners stay as they were.
    cut = sphere(8, 'b', [1, 0, 0], 0.2),
    { mesh, faceMap } = booleanMeshesExact(large, cut, 'difference', { createId: ids() });
  assertClosed(mesh);
  assert.ok(volume(mesh) < volume(large) && volume(mesh) > volume(large) - 0.04);
  const untouched = large.faces.filter((face) => faceMap.a[face.id].length === 1).length;
  assert.ok(untouched > large.faces.length * 0.9, `${untouched} of ${large.faces.length} faces stay whole`);
});

test('regression: overlapping shells of one input are joined first', () => {
  const box = createPrimitiveMesh('cube', 'p'),
    side = shifted(box, 'q', [0.5, 0, 0]),
    // One mesh of two boxes that overlap by half: a real asset of parts pushed into each other.
    both = {
      vertices: [...box.vertices, ...side.vertices],
      faces: [...box.faces, ...side.faces.map((f) => ({ ...f, vertices: f.vertices.map((v) => v + box.vertices.length) }))],
    },
    cutter = shifted(createPrimitiveMesh('cube', 'c'), 'd', [0, 0, 0.5]),
    size = volume(box),
    joined = booleanMeshesExact(box, side, 'union', { createId: ids() }).mesh,
    expected = volume(booleanMeshesExact(joined, cutter, 'difference', { createId: ids() }).mesh),
    result = booleanMeshesExact(both, cutter, 'difference', { createId: ids() });
  assertClosed(result.mesh);
  assert.ok(Math.abs(volume(joined) - size * 1.5) < 1e-12, 'the union of the shells');
  assert.ok(Math.abs(volume(result.mesh) - expected) < 1e-12);
  const inputs = new Set(both.faces.map((f) => f.id));
  for (const [id, { input, face }] of Object.entries(result.sources))
    if (input === 'a') assert.ok(inputs.has(face), `${id} names input face ${face}`);
  assert.ok(Object.keys(result.faceMap.a).every((id) => inputs.has(id)));
  assert.equal(Object.values(result.faceMap.a).flat().length + Object.values(result.faceMap.b).flat().length, result.mesh.faces.length);
  assert.ok(result.diagnostics.some((line) => line.includes('shells of input a')));
  // Apart, nothing is joined, so a mesh of parts that do not meet keeps its own faces.
  const apart = shifted(box, 'r', [5, 0, 0]),
    parts = {
      vertices: [...box.vertices, ...apart.vertices],
      faces: [...box.faces, ...apart.faces.map((f) => ({ ...f, vertices: f.vertices.map((v) => v + box.vertices.length) }))],
    };
  assert.ok(!booleanMeshesExact(parts, cutter, 'union', { createId: ids() }).diagnostics.some((line) => line.includes('shells')));
});
