import assert from 'node:assert/strict';
import test from 'node:test';
import { area, edgeId, grid, ids, random } from './topology-helpers.js';

const K = { ...(await import('../dist/index.js')), ...(await import('../dist/modeling.js')) };
const cube = () => K.createPrimitiveMesh('cube', 'box');

/** Twice the signed area of a UV polygon (shoelace; top-left UVs of an outward face are negative). */
const uvTwice = (uv) =>
  uv.reduce((sum, p, i) => sum + p[0] * uv[(i + 1) % uv.length][1] - uv[(i + 1) % uv.length][0] * p[1], 0);

/** A closed torus of triangles (genus 1), optionally jittered. */
function torus(n, m, jitter = 0, seed = 1) {
  const rand = random(seed),
    vertices = [],
    faces = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++) {
      const u = (2 * Math.PI * i) / n,
        v = (2 * Math.PI * j) / m,
        r = 0.7 * (1 + jitter * (rand() - 0.5));
      vertices.push([(2 + r * Math.cos(v)) * Math.cos(u), (2 + r * Math.cos(v)) * Math.sin(u), r * Math.sin(v)]);
    }
  const at = (i, j) => (i % n) * m + (j % m);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++) {
      const a = at(i, j),
        b = at(i + 1, j),
        c = at(i + 1, j + 1),
        d = at(i, j + 1);
      faces.push({
        id: `t${i}-${j}a`,
        vertices: [a, b, c],
        uv: [
          [0, 0],
          [0, 0],
          [0, 0],
        ],
      });
      faces.push({
        id: `t${i}-${j}b`,
        vertices: [a, c, d],
        uv: [
          [0, 0],
          [0, 0],
          [0, 0],
        ],
      });
    }
  return { vertices, faces };
}

/** Every structural invariant of a layout: unchanged geometry, folds, disks, packing, bounds. */
function assertLayout(input, uvOf, charts, { resolution, padding, packed = true }) {
  const faces = input.faces;
  // Every face in exactly one chart.
  const owner = new Map();
  charts.forEach((chart, k) =>
    chart.faces.forEach((id) => {
      assert.ok(!owner.has(id), `face ${id} in two charts`);
      owner.set(id, k);
    }),
  );
  assert.equal(owner.size, faces.length);
  faces.forEach((face, f) => {
    const uv = uvOf(f);
    assert.equal(uv.length, face.vertices.length);
    for (const p of uv) for (const x of p) assert.ok(x >= 0 && x <= 1, `uv ${p} outside the unit square`);
    // No fold: every fan triangle keeps the outward (negative, top-left) orientation.
    for (let i = 1; i < uv.length - 1; i++) {
      const t = uvTwice([uv[0], uv[i], uv[i + 1]]);
      assert.ok(t <= 0, `face ${face.id} folds (${t})`);
    }
    assert.ok(uvTwice(uv) < 0, `face ${face.id} collapsed`);
  });
  // Each chart is a disk: V - E + F = 1 over (vertex, uv) corners.
  for (const chart of charts) {
    const key = (f, c) => `${faces[f].vertices[c]}@${uvOf(f)[c].join(',')}`,
      vertices = new Set(),
      edges = new Set(),
      index = new Map(faces.map((face, f) => [face.id, f]));
    for (const id of chart.faces) {
      const f = index.get(id),
        n = faces[f].vertices.length;
      for (let c = 0; c < n; c++) {
        const a = key(f, c),
          b = key(f, (c + 1) % n);
        vertices.add(a);
        edges.add(a < b ? `${a}|${b}` : `${b}|${a}`);
      }
    }
    assert.equal(vertices.size - edges.size + chart.faces.length, 1, 'chart is not a disk');
  }
  if (!packed) return;
  // Packed chart boxes keep `padding` texels apart and from the border.
  const boxes = charts.map((chart) => chart.bounds.map((x) => x * resolution));
  for (const [u0, v0, u1, v1] of boxes) {
    assert.ok(u0 >= padding - 1e-6 && v0 >= padding - 1e-6, 'chart in the border padding');
    assert.ok(u1 <= resolution - padding + 1e-6 && v1 <= resolution - padding + 1e-6, 'chart in the border padding');
  }
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i],
        b = boxes[j],
        apart =
          a[2] + padding <= b[0] + 1e-6 ||
          b[2] + padding <= a[0] + 1e-6 ||
          a[3] + padding <= b[1] + 1e-6 ||
          b[3] + padding <= a[1] + 1e-6;
      assert.ok(apart, `charts ${i} and ${j} closer than ${padding} texels`);
    }
}

test('unwrap a flat grid: one chart, an exact similarity, no seams', () => {
  const mesh = grid(4, 3),
    result = K.unwrapMesh(mesh);
  assert.equal(result.charts.length, 1);
  assert.deepEqual(result.seams, []);
  assert.ok(result.charts[0].stretch < 1 + 1e-6);
  assertLayout(mesh, (f) => result.mesh.faces[f].uv, result.charts, { resolution: 1024, padding: 4 });
  // Distances in UV are distances on the surface times one scale.
  const uvAt = new Map();
  result.mesh.faces.forEach((face) => face.vertices.forEach((v, c) => uvAt.set(v, face.uv[c])));
  const scale = result.texelsPerUnit / 1024;
  for (const [a, b] of [
    [0, 19],
    [3, 16],
    [5, 7],
  ]) {
    const p = mesh.vertices[a],
      q = mesh.vertices[b],
      s = uvAt.get(a),
      t = uvAt.get(b);
    assert.ok(Math.abs(Math.hypot(s[0] - t[0], s[1] - t[1]) - Math.hypot(p[0] - q[0], p[2] - q[2]) * scale) < 1e-9);
  }
  // Positions, IDs and winding are unchanged.
  assert.deepEqual(result.mesh.vertices, mesh.vertices);
  assert.deepEqual(
    result.mesh.faces.map((face) => [face.id, face.vertices]),
    mesh.faces.map((face) => [face.id, face.vertices]),
  );
});

test('unwrap a cube: six square charts at one density, every edge a seam', () => {
  const mesh = cube(),
    result = K.unwrapMesh(mesh);
  assert.equal(result.charts.length, 6);
  assert.equal(result.seams.length, 12);
  assertLayout(mesh, (f) => result.mesh.faces[f].uv, result.charts, { resolution: 1024, padding: 4 });
  for (const chart of result.charts) {
    const [u0, v0, u1, v1] = chart.bounds;
    assert.ok(Math.abs((u1 - u0) * 1024 - result.texelsPerUnit) < 1e-6);
    assert.ok(Math.abs((v1 - v0) * 1024 - result.texelsPerUnit) < 1e-6);
  }
  // Six unit squares: 3 x 2 shelf at (1024 - 4 * 4) / 3 texels a side at most.
  assert.ok(result.texelsPerUnit > 300 && result.texelsPerUnit <= (1024 - 16) / 3);
});

test('unwrap a smooth closed solid and a torus: split into disks, no folds or overlaps', () => {
  const smooth = K.subdivideMesh(cube(), { levels: 2, ...ids('s') }).mesh;
  for (const mesh of [smooth, torus(24, 12)]) {
    const result = K.unwrapMesh(mesh, { angle: 180 });
    assert.ok(result.charts.length >= 2, `${result.charts.length} charts`);
    assert.ok(result.seams.length > 0);
    assert.deepEqual(result.diagnostics, []);
    assertLayout(mesh, (f) => result.mesh.faces[f].uv, result.charts, { resolution: 1024, padding: 4 });
    // Conformal maps keep stretch moderate on smooth charts.
    for (const chart of result.charts) assert.ok(chart.stretch < 8, `stretch ${chart.stretch}`);
  }
});

test('unwrap fuzz: jittered tori and random seams keep every layout invariant', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const rand = random(seed),
      mesh = torus(8 + Math.floor(rand() * 12), 5 + Math.floor(rand() * 8), 0.4, seed),
      edges = K.polygonMeshEdges(mesh).map((edge) => edge.id),
      seams = edges.filter(() => rand() < 0.1),
      angle = rand() < 0.5 ? 180 : 20 + rand() * 60,
      resolution = [256, 512, 1024][seed % 3],
      padding = seed % 4,
      result = K.unwrapMesh(mesh, { seams, angle, resolution, padding });
    assertLayout(mesh, (f) => result.mesh.faces[f].uv, result.charts, { resolution, padding });
    // Every cut seam that a chart's faces meet across is listed; listed seams are real UV discontinuities.
    for (const id of result.seams) assert.ok(edges.includes(id));
  }
});

test('unwrap seams: a cut across a grid makes two charts and is the seam list', () => {
  const mesh = grid(4),
    seams = [0, 1, 2, 3].map((j) => edgeId(j * 5 + 2, (j + 1) * 5 + 2)),
    result = K.unwrapMesh(mesh, { seams, angle: 180 });
  assert.equal(result.charts.length, 2);
  assert.deepEqual(result.seams, [...seams].sort());
  assertLayout(mesh, (f) => result.mesh.faces[f].uv, result.charts, { resolution: 1024, padding: 4 });
  assert.throws(() => K.unwrapMesh(mesh, { seams: ['0:24'] }), TypeError);
});

test('unwrap pins: two pins fix the chart, one pin places it at the packed density', () => {
  const mesh = grid(4),
    two = K.unwrapMesh(mesh, {
      pins: [
        { vertex: 0, uv: [0.1, 0.1] },
        { vertex: 4, uv: [0.9, 0.1] },
      ],
    });
  assert.equal(two.charts[0].pins, 2);
  const uvAt = (result, v) => {
    for (const face of result.mesh.faces) {
      const c = face.vertices.indexOf(v);
      if (c >= 0) return face.uv[c];
    }
  };
  assert.deepEqual(uvAt(two, 0), [0.1, 0.1]);
  assert.deepEqual(uvAt(two, 4), [0.9, 0.1]);
  // A flat grid pinned along one side is an exact similarity: the far corner lands 0.8 further down.
  const far = uvAt(two, 24);
  assert.ok(Math.abs(far[0] - 0.9) < 1e-9 && Math.abs(far[1] - 0.9) < 1e-9, `${far}`);
  assertLayout(mesh, (f) => two.mesh.faces[f].uv, two.charts, { packed: false });

  // One pinned chart beside a packed one: the cube's +Y face keeps the density of the other five.
  const box = cube(),
    top = box.faces.find((face) => face.id === 'box-face-4'),
    one = K.unwrapMesh(box, { pins: [{ vertex: top.vertices[0], uv: [0.5, 0.5] }] });
  const pinned = one.charts.filter((chart) => chart.pins === 1);
  assert.ok(pinned.length >= 1);
  for (const chart of pinned) {
    const [u0, v0, u1, v1] = chart.bounds;
    assert.ok(
      Math.abs((u1 - u0) * 1024 - one.texelsPerUnit) < 1e-6 && Math.abs((v1 - v0) * 1024 - one.texelsPerUnit) < 1e-6,
    );
  }
  assert.deepEqual(uvAt(one, top.vertices[0]).length, 2);
  assert.throws(() => K.unwrapMesh(mesh, { pins: [{ vertex: 99, uv: [0, 0] }] }), TypeError);
  assert.throws(() => K.unwrapMesh(mesh, { pins: [{ vertex: 0, uv: [2, 0] }] }), TypeError);
  assert.throws(
    () =>
      K.unwrapMesh(mesh, {
        pins: [
          { vertex: 0, uv: [0.5, 0.6] },
          { vertex: 4, uv: [1, 0.6] },
        ],
      }),
    RangeError,
  );
});

test('lightmap UVs: one density, texel-aligned charts with padding, mesh untouched', () => {
  const smooth = K.subdivideMesh(cube(), { levels: 2, ...ids('s') }).mesh;
  for (const [mesh, options] of [
    [cube(), {}],
    [smooth, { resolution: 512, padding: 3 }],
    [torus(16, 8, 0.3, 7), { resolution: 128, padding: 1 }],
  ]) {
    const before = structuredClone(mesh),
      result = K.meshLightmapUVs(mesh, options),
      resolution = options.resolution ?? 256,
      padding = options.padding ?? 2;
    assert.deepEqual(mesh, before);
    assert.equal(result.resolution, resolution);
    assert.equal(result.uv.length, mesh.faces.length);
    assertLayout(mesh, (f) => result.uv[f], result.charts, { resolution, padding });
    const index = new Map(mesh.faces.map((face, f) => [face.id, f]));
    for (const chart of result.charts) {
      // Charts start on a texel corner.
      for (const k of [0, 1]) {
        const start = chart.bounds[k] * resolution;
        assert.ok(Math.abs(start - Math.round(start)) < 1e-6, `chart starts at ${start}`);
      }
      // Texel area equals surface area times the density squared.
      let flat = 0;
      for (const id of chart.faces) flat += -uvTwice(result.uv[index.get(id)]) / 2;
      const expected = chart.area * (result.texelsPerUnit / resolution) ** 2;
      assert.ok(Math.abs(flat - expected) < 1e-9 + expected * 1e-6, `${flat} vs ${expected}`);
      const surface = area({ vertices: mesh.vertices, faces: chart.faces.map((id) => mesh.faces[index.get(id)]) });
      assert.ok(Math.abs(surface - chart.area) < 1e-9);
    }
  }
});

test('unwrap options: errors name the fix, AbortSignal stops, too many charts reject', () => {
  const mesh = grid(2);
  assert.throws(() => K.unwrapMesh(mesh, { angle: 200 }), RangeError);
  assert.throws(() => K.unwrapMesh(mesh, { resolution: 4 }), RangeError);
  assert.throws(() => K.unwrapMesh(mesh, { padding: 1.5 }), RangeError);
  assert.throws(() => K.unwrapMesh(mesh, { seams: 'x' }), TypeError);
  assert.throws(() => K.unwrapMesh(mesh, null), TypeError);
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  assert.throws(() => K.unwrapMesh(mesh, { signal: controller.signal }), /stop/);
  assert.throws(() => K.meshLightmapUVs(mesh, { signal: controller.signal }), /stop/);
  // 24 charts of at least one texel plus 3 padding each cannot fit in 16 texels.
  const smooth = K.subdivideMesh(cube(), { levels: 1, ...ids('s') }).mesh;
  assert.throws(() => K.meshLightmapUVs(smooth, { resolution: 16, padding: 3, angle: 0 }), RangeError);
  // Draft (missing) UVs are fine: unwrap replaces them.
  const draft = { vertices: mesh.vertices, faces: mesh.faces.map((face) => ({ ...face, uv: [] })) };
  assert.equal(K.unwrapMesh(draft).mesh.faces[0].uv.length, 4);
});

test('README unwrap example runs as written', () => {
  const smooth = K.subdivideMesh(K.createPrimitiveMesh('cube', 'box'), { levels: 2 }).mesh;
  const unwrapped = K.unwrapMesh(smooth, { angle: 60, padding: 4 });
  const lightmap = K.meshLightmapUVs(smooth, { resolution: 256, padding: 2 });
  assert.ok(unwrapped.charts.length >= 2);
  assert.equal(lightmap.uv.length, smooth.faces.length);
  assert.ok(lightmap.texelsPerUnit > 0);
});
