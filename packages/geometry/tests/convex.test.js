// convexGeometry (quickhull) against analytic hulls: cubes, spheres and random clouds with duplicate and coplanar points.
import test from 'node:test';
import assert from 'node:assert/strict';
import { convexGeometry } from '../dist/extras.js';
import {
  assertNormalsAgreeWithWinding,
  assertUVRange,
  assertValid,
  close,
  dot,
  point,
  signedVolume,
  surfaceArea,
  vertexCount,
  watertight,
} from './support/mesh-checks.js';

// Deterministic points (mulberry32), so failures reproduce.
const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const distinct = (g) => new Set(Array.from({ length: vertexCount(g) }, (_, i) => point(g, i).join(','))).size;
/** Every input point is inside or on every hull face plane, within `tolerance`. */
function contains(g, points, tolerance) {
  for (let t = 0; t < g.indices.length; t += 3) {
    const a = point(g, g.indices[t]),
      n = [g.normals[g.indices[t] * 3], g.normals[g.indices[t] * 3 + 1], g.normals[g.indices[t] * 3 + 2]];
    for (const p of points) assert.ok(dot(n, [p[0] - a[0], p[1] - a[1], p[2] - a[2]]) <= tolerance, 'point outside');
  }
}
function checkHull(g, label) {
  assertValid(g, label);
  assertUVRange(g, label);
  assertNormalsAgreeWithWinding(g, label);
  const { euler } = watertight(g, label, 6);
  assert.equal(euler, 2, `${label} Euler characteristic`);
  assert.ok(signedVolume(g) > 0, `${label} outward`);
}

test('a cube lattice with duplicates and interior, face and edge points hulls to its 8 corners and 6 faces', () => {
  const points = [];
  for (let x = 0; x <= 4; x++)
    for (let y = 0; y <= 4; y++) for (let z = 0; z <= 4; z++) points.push([x / 2 - 1, y / 2 - 1, z / 2 - 1]);
  points.push(...points.slice(0, 40), [1, 1, 1], [-1, -1, -1]);
  const g = convexGeometry(points);
  checkHull(g, 'lattice');
  assert.equal(distinct(g), 8, 'only the corners are vertices');
  assert.equal(vertexCount(g), 24, 'one quad of four shared vertices per flat face');
  assert.equal(g.indices.length / 3, 12);
  close(signedVolume(g), 8, 1e-6, 'cube volume');
  close(surfaceArea(g), 24, 1e-6, 'cube area');
  const normals = new Set();
  for (let i = 0; i < vertexCount(g); i++)
    normals.add([g.normals[i * 3], g.normals[i * 3 + 1], g.normals[i * 3 + 2]].map((v) => v + 0).join(','));
  assert.deepEqual([...normals].sort(), ['-1,0,0', '0,-1,0', '0,0,-1', '0,0,1', '0,1,0', '1,0,0']);
  contains(g, points, 1e-6);
});

test('points along hull edges are dropped: stacked rings keep only the top and bottom circles', () => {
  const points = [],
    sides = 64;
  for (let k = 0; k < 20; k++)
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * 2 * Math.PI;
      points.push([Math.cos(a), (k / 19) * 3, Math.sin(a)]);
    }
  const g = convexGeometry(points);
  checkHull(g, 'rings');
  assert.equal(distinct(g), 2 * sides);
  const polygon = (sides / 2) * Math.sin((2 * Math.PI) / sides);
  close(signedVolume(g), polygon * 3, 1e-6, 'prism volume');
  contains(g, points, 1e-6);
});

test('flat xyz numbers and a scaled, translated tetrahedron give the exact solid', () => {
  const g = convexGeometry([10, 10, 10, 13, 10, 10, 10, 13, 10, 10, 10, 13, 11, 11, 11]);
  checkHull(g, 'tetrahedron');
  assert.equal(distinct(g), 4);
  close(signedVolume(g), 4.5, 1e-4, 'tetrahedron volume (27 / 6)');
});

test('points on a sphere all become vertices and the hull converges to the sphere', () => {
  const n = 2000,
    golden = Math.PI * (3 - Math.sqrt(5)),
    points = [];
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n,
      r = Math.sqrt(1 - y * y);
    points.push([Math.cos(golden * i) * r, y, Math.sin(golden * i) * r]);
  }
  const g = convexGeometry(points);
  checkHull(g, 'sphere');
  assert.equal(distinct(g), n);
  assert.equal(g.indices.length / 3, 2 * n - 4, 'a triangulated sphere: F = 2V - 4');
  // Inscribed in the sphere: a little smaller, within 0.5% at 2,000 vertices.
  assert.ok(signedVolume(g) < (4 / 3) * Math.PI && surfaceArea(g) < 4 * Math.PI);
  close(signedVolume(g), (4 / 3) * Math.PI, (4 / 3) * Math.PI * 5e-3, 'sphere volume');
  close(surfaceArea(g), 4 * Math.PI, 4 * Math.PI * 5e-3, 'sphere area');
  contains(g, points, 1e-6);
});

test('random clouds: every point is inside, every vertex is an input point, solids are closed and outward', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const next = random(seed),
      count = 50 + seed * 300,
      points = [];
    for (let i = 0; i < count; i++) {
      // A box, a ball and coplanar slabs mixed together, with exact repeats.
      const kind = i % 4,
        p = [next() * 2 - 1, next() * 2 - 1, next() * 2 - 1];
      if (kind === 1) {
        const l = Math.hypot(...p) || 1;
        for (let c = 0; c < 3; c++) p[c] /= l;
      }
      if (kind === 2) p[i % 3] = Math.sign(p[i % 3]) || 1;
      points.push(p);
      if (kind === 3) points.push(p.slice());
    }
    const g = convexGeometry(points),
      label = `cloud ${seed}`,
      inputs = new Set(points.map((p) => p.map(Math.fround).join(',')));
    checkHull(g, label);
    contains(g, points, 1e-6);
    for (let i = 0; i < vertexCount(g); i++)
      assert.ok(inputs.has(point(g, i).join(',')), `${label} vertex ${i} is an input`);
  }
});

test('degenerate input throws RangeError naming the fix', () => {
  assert.throws(
    () =>
      convexGeometry([
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ]),
    /at least four points/,
  );
  assert.throws(() => convexGeometry(Array.from({ length: 9 }, () => [1, 2, 3])), /all coincide/);
  assert.throws(() => convexGeometry([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3]), /one line/);
  assert.throws(
    () =>
      convexGeometry([
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [1, 1, 0],
        [0.5, 0.2, 0],
      ]),
    /one plane/,
  );
  assert.throws(() => convexGeometry([0, 0, 0, 1]), /three \(x, y, z\) per point/);
  assert.throws(
    () =>
      convexGeometry([
        [0, 0, 0],
        [1, 0, 0],
        [0, Number.NaN, 0],
        [0, 0, 1],
      ]),
    /point 2 is not finite/,
  );
  assert.throws(() => convexGeometry(null), TypeError);
});
