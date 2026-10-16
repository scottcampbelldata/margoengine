import test from 'node:test';
import assert from 'node:assert/strict';
import { delaunay2, delaunay3, voronoi2, voronoi3, fractureMesh } from '../dist/voronoi.js';
import { boxGeometry, icosahedronGeometry, torusGeometry, toGeometry } from '@margoengine/geometry';

const seeded = (seed) => {
  let s = seed;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
};
const polygonArea = (p) => {
  let a = 0;
  for (let k = 0, n = p.length / 2; k < n; k++) {
    const m = (k + 1) % n;
    a += p[k * 2] * p[m * 2 + 1] - p[m * 2] * p[k * 2 + 1];
  }
  return a / 2;
};
const volume = (g) => {
  const v = g.vertices,
    i = g.indices;
  let s = 0;
  for (let t = 0; t < i.length; t += 3) {
    const a = i[t] * 6,
      b = i[t + 1] * 6,
      c = i[t + 2] * 6;
    s +=
      v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) -
      v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) +
      v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]);
  }
  return s / 6;
};
// A closed surface's triangle area vectors sum to zero; a missing cap would leave its area here.
const holeArea = (g) => {
  const v = g.vertices,
    i = g.indices,
    s = [0, 0, 0];
  for (let t = 0; t < i.length; t += 3) {
    const [a, b, c] = [i[t] * 6, i[t + 1] * 6, i[t + 2] * 6],
      u = [0, 1, 2].map((k) => v[b + k] - v[a + k]),
      w = [0, 1, 2].map((k) => v[c + k] - v[a + k]);
    s[0] += u[1] * w[2] - u[2] * w[1];
    s[1] += u[2] * w[0] - u[0] * w[2];
    s[2] += u[0] * w[1] - u[1] * w[0];
  }
  return Math.hypot(...s) / 2;
};

test('2D Delaunay has empty circumcircles and the Voronoi cells tile the bounds', () => {
  const random = seeded(5),
    points = Array.from({ length: 600 }, random),
    { triangles, neighbors } = delaunay2(points);
  for (let t = 0; t < triangles.length; t += 3) {
    const [a, b, c] = [...triangles.subarray(t, t + 3)].map((i) => [points[i * 2], points[i * 2 + 1]]);
    assert.ok((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0, 'counter-clockwise');
    for (let p = 0; p < 300; p += 7) {
      // Incircle determinant: no other point strictly inside.
      const [x, y] = [points[p * 2], points[p * 2 + 1]],
        m = [a, b, c].map(([u, v]) => [u - x, v - y, (u - x) ** 2 + (v - y) ** 2]);
      const det =
        m[0][0] * (m[1][1] * m[2][2] - m[2][1] * m[1][2]) -
        m[0][1] * (m[1][0] * m[2][2] - m[2][0] * m[1][2]) +
        m[0][2] * (m[1][0] * m[2][1] - m[2][0] * m[1][1]);
      assert.ok(det <= 1e-12, 'empty circumcircle');
    }
  }
  assert.equal(triangles.length / 3, 2 * 300 - 2 - convexHullSize(points)); // Euler: 2n - 2 - h triangles
  const v = voronoi2(points, [0, 0, 1, 1]);
  assert.ok(Math.abs(v.cells.reduce((s, c) => s + polygonArea(c.polygon), 0) - 1) < 1e-12);
  v.cells.forEach((cell, i) => {
    assert.ok(polygonArea(cell.polygon) > 0);
    for (const j of cell.neighbors) assert.ok(neighbors[i].includes(j) && v.cells[j].neighbors.includes(i));
    // Every cell vertex is equidistant from its site and the site across each adjacent edge.
    for (let k = 0; k < cell.edgeSites.length; k++) {
      const j = cell.edgeSites[k];
      if (j < 0) continue;
      const x = cell.polygon[k * 2],
        y = cell.polygon[k * 2 + 1];
      assert.ok(
        Math.abs(
          Math.hypot(x - points[i * 2], y - points[i * 2 + 1]) - Math.hypot(x - points[j * 2], y - points[j * 2 + 1]),
        ) < 1e-9,
      );
    }
  });
  assert.equal(v.edges.length / 4, v.edgeCells.length / 2);
});
function convexHullSize(points) {
  const p = Array.from({ length: points.length / 2 }, (_, i) => [points[i * 2], points[i * 2 + 1]]).sort(
      (a, b) => a[0] - b[0] || a[1] - b[1],
    ),
    cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list) => {
    const h = [];
    for (const q of list) {
      while (h.length >= 2 && cross(h.at(-2), h.at(-1), q) <= 0) h.pop();
      h.push(q);
    }
    return h.length - 1;
  };
  return half(p) + half(p.reverse());
}

test('co-circular grids and duplicates triangulate without overlap', () => {
  const grid = [];
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) grid.push(x, y);
  const v = voronoi2(grid, [-0.5, -0.5, 11.5, 11.5]);
  for (const cell of v.cells) assert.ok(Math.abs(polygonArea(cell.polygon) - 1) < 1e-9, 'unit square cells');
  const cube = [];
  for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) cube.push(x, y, z);
  const v3 = voronoi3(cube, [-0.5, -0.5, -0.5, 3.5, 3.5, 3.5]);
  for (const cell of v3.cells) assert.ok(Math.abs(cell.volume - 1) < 1e-9, 'unit cube cells');
  assert.equal(v3.cells[21].neighbors.length, 6);
  const twice = delaunay2([0, 0, 1, 0, 0, 1, 1, 0]);
  assert.equal(twice.triangles.length, 3);
  assert.deepEqual(twice.neighbors[3], []);
  assert.throws(() => delaunay2([0, 0, NaN, 1]), /finite/);
  assert.throws(() => voronoi2([0, 0], [1, 0, 0, 1]), /bounds/);
});

test('3D Delaunay has empty circumspheres and Voronoi cells fill the box', () => {
  const random = seeded(11),
    points = Array.from({ length: 600 }, random),
    { tetrahedra } = delaunay3(points);
  const p = (i) => [points[i * 3], points[i * 3 + 1], points[i * 3 + 2]];
  for (let t = 0; t < tetrahedra.length; t += 4 * 9) {
    const [a, b, c, d] = [...tetrahedra.subarray(t, t + 4)].map(p),
      r = [b, c, d].map((q) => q.map((v, k) => v - a[k]));
    const det =
      r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1]) -
      r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0]) +
      r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);
    assert.ok(det > 0, 'positive volume');
    // Circumcenter relative to a, then no point strictly inside the sphere.
    const l = r.map((q) => q[0] ** 2 + q[1] ** 2 + q[2] ** 2),
      x = (u, w) => [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const [cd, db, bc] = [x(r[1], r[2]), x(r[2], r[0]), x(r[0], r[1])],
      center = [0, 1, 2].map((k) => a[k] + (l[0] * cd[k] + l[1] * db[k] + l[2] * bc[k]) / (2 * det)),
      radius = Math.hypot(...center.map((v, k) => v - a[k]));
    for (let q = 0; q < 200; q++)
      assert.ok(Math.hypot(...center.map((v, k) => v - p(q)[k])) >= radius * (1 - 1e-9), 'empty circumsphere');
  }
  const v = voronoi3(points, [0, 0, 0, 1, 1, 1]);
  assert.ok(Math.abs(v.cells.reduce((s, c) => s + c.volume, 0) - 1) < 1e-9);
  // Each face lies on the bisector of its two sites.
  v.cells.forEach((cell, i) =>
    cell.faces.forEach((face, f) => {
      const j = cell.faceSites[f];
      if (j < 0) return;
      for (const k of face) {
        const x = [...cell.vertices.subarray(k * 3, k * 3 + 3)];
        assert.ok(
          Math.abs(Math.hypot(...x.map((v, a) => v - p(i)[a])) - Math.hypot(...x.map((v, a) => v - p(j)[a]))) < 1e-9,
        );
      }
    }),
  );
});

test('mesh fracture gives closed chunks that add up to the mesh, seeded', () => {
  for (const data of [boxGeometry(2, 1, 1), icosahedronGeometry(1, 3), torusGeometry(1, 0.35, 12, 32)]) {
    const mesh = toGeometry(data),
      whole = volume(mesh);
    for (const seed of [1, 2, 3]) {
      const chunks = fractureMesh(mesh, 12, { seed });
      assert.ok(chunks.length >= 6);
      assert.ok(
        Math.abs(chunks.reduce((s, c) => s + volume(c.geometry), 0) - whole) < 1e-5 * whole,
        'volume is conserved',
      );
      for (const c of chunks) {
        assert.ok(volume(c.geometry) > 0);
        assert.ok(holeArea(c.geometry) < 1e-4, 'chunk is closed');
      }
    }
  }
  const mesh = toGeometry(boxGeometry(2, 2, 2)),
    a = fractureMesh(mesh, 8, { seed: 4 }),
    b = fractureMesh(mesh, 8, { seed: 4 });
  assert.deepEqual(
    a.map((c) => c.geometry.vertices),
    b.map((c) => c.geometry.vertices),
  );
  // Explicit sites: two halves split at x = 0 with a flat cap facing each site.
  const halves = fractureMesh(mesh, [-0.5, 0, 0, 0.5, 0, 0]);
  assert.deepEqual(
    halves.map((c) => Math.round(volume(c.geometry) * 1e6) / 1e6),
    [4, 4],
  );
  assert.throws(() => fractureMesh(mesh, 0), /site count/);
});
