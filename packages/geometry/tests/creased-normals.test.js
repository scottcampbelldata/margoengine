import test from 'node:test';
import assert from 'node:assert/strict';
import { boxGeometry, creasedNormals, toNonIndexed } from '../dist/index.js';

// A unit cube stored one vertex per triangle corner, as the tile editor keeps tiles.
const cube = toNonIndexed(boxGeometry(1, 1, 1));
const near = (actual, expected, eps = 1e-5) =>
  assert.ok(
    actual.every((v, i) => Math.abs(v - expected[i]) <= eps),
    `${[...actual]} != ${expected}`,
  );
const vertex = (normals, v) => normals.subarray(v * 3, v * 3 + 3);
const faceNormal = (P, t) => {
  const [a, b, c] = [0, 1, 2].map((k) => P.subarray((t * 3 + k) * 3, (t * 3 + k) * 3 + 3));
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
    w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]],
    n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]],
    l = Math.hypot(...n);
  return n.map((x) => x / l);
};

test('creasedNormals: a cube is flat below 90 degrees and fully smooth above', () => {
  const P = cube.positions,
    flat = creasedNormals(P, { angle: 30 }),
    smooth = creasedNormals(P, { angle: 100 });
  for (let v = 0; v < P.length / 3; v++) {
    near(vertex(flat, v), faceNormal(P, (v / 3) | 0));
    // Every face contributes 90 degrees at a cube corner, so the smooth normal is the corner diagonal.
    near(
      vertex(smooth, v),
      [...vertex(P, v)].map((x) => Math.sign(x) / Math.sqrt(3)),
    );
  }
  near(creasedNormals(P, { angle: 0 }), flat);
  near(creasedNormals(P), smooth);
  // Indexed input (one vertex per face corner, shared by that face's two triangles) gives the same normals.
  const box = boxGeometry(1, 1, 1),
    indexed = creasedNormals(box.positions, { indices: box.indices, angle: 100 });
  for (let v = 0; v < box.positions.length / 3; v++)
    near(
      vertex(indexed, v),
      [...vertex(box.positions, v)].map((x) => Math.sign(x) / Math.sqrt(3)),
    );
});

test('creasedNormals: only triangles in the same smoothing group smooth together', () => {
  const P = cube.positions,
    triangles = P.length / 9,
    groups = new Uint32Array(triangles);
  // Mark the +y face as its own group.
  for (let t = 0; t < triangles; t++) if (faceNormal(P, t)[1] > 0.5) groups[t] = 1;
  const normals = creasedNormals(P, { angle: 180, groups });
  for (let v = 0; v < P.length / 3; v++) {
    const t = (v / 3) | 0,
      p = [...vertex(P, v)].map(Math.sign),
      n = vertex(normals, v);
    if (groups[t]) near(n, [0, 1, 0]);
    else if (p[1] > 0)
      near(
        n,
        [p[0], 0, p[2]].map((x) => x / Math.SQRT2),
      ); // top ring: only the two side faces
    else
      near(
        n,
        p.map((x) => x / Math.sqrt(3)),
      );
  }
  assert.throws(() => creasedNormals(P, { groups: [1, 2] }), RangeError);
});

test('creasedNormals: zero-area triangles add nothing and get zero normals', () => {
  const quad = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0];
  // A raised triangle shares the corner at the origin; then a needle (repeated corner) and a collinear sliver there.
  const roof = [0, 0, 0, 0, 1, 0, 0, 0, 1];
  const junk = [0, 0, 0, 0, 0, 0, 0.5, 0.5, 0, 0, 0, 0, 0.1, 0.1, 0.1, 0.3, 0.3, 0.3];
  const clean = creasedNormals([...quad, ...roof], { angle: 180 }),
    noisy = creasedNormals([...quad, ...roof, ...junk], { angle: 180 });
  near(noisy.subarray(0, clean.length), clean);
  near(noisy.subarray(clean.length), new Array(18).fill(0));
  assert.ok(noisy.every(Number.isFinite));
});

test('creasedNormals: corners within the tolerance weld, farther ones stay apart', () => {
  // A floor (+y) and a wall (+z) meeting at 90 degrees, the wall's copy of the shared edge offset by up to 5e-5.
  const floor = [0, 0, 0, 1, 0, 0, 0, 0, -1],
    wall = [5e-5, 0, 0, 1, 1e-5, 0, 0, 1, 0];
  const welded = creasedNormals([...floor, ...wall], { angle: 180 }),
    apart = creasedNormals([...floor, ...wall], { angle: 180, tolerance: 1e-6 });
  near(vertex(welded, 0), [0, 1 / Math.SQRT2, 1 / Math.SQRT2], 1e-3);
  near(vertex(welded, 3), vertex(welded, 0), 1e-3);
  near(vertex(apart, 0), [0, 1, 0], 1e-3);
  near(vertex(apart, 3), [0, 0, 1], 1e-3);
  assert.throws(() => creasedNormals([0, 0, 0, 1], {}), RangeError);
  assert.throws(() => creasedNormals(floor, { angle: 200 }), RangeError);
  assert.throws(() => creasedNormals(floor, { indices: [0, 1, 3] }), RangeError);
});
