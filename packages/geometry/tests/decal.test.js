// decalGeometry: clipped triangles stay inside the projector box, UVs span [0, 1], areas match the analytic footprint.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planeGeometry, sphereGeometry } from '../dist/index.js';
import { decalGeometry } from '../dist/extras.js';
import {
  assertNormalsAgreeWithWinding,
  assertUVRange,
  assertValid,
  close,
  surfaceArea,
  vertexCount,
} from './support/mesh-checks.js';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// Column-major: rotate a about x, then scale by s, then move by t.
const transform = (a, s, t) => {
  const c = Math.cos(a),
    n = Math.sin(a);
  return [s, 0, 0, 0, 0, c * s, n * s, 0, 0, -n * s, c * s, 0, t[0], t[1], t[2], 1];
};
const quaternionX = (a) => [Math.sin(a / 2), 0, 0, Math.cos(a / 2)];
/** Decal-space coordinates of every output vertex, with the offset along its normal removed. */
function local(g, position, rotation, offset) {
  const [x, y, z, w] = rotation,
    R = [
      [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ];
  const out = [];
  for (let i = 0; i < vertexCount(g); i++) {
    const p = [0, 1, 2].map((c) => g.positions[i * 3 + c] - g.normals[i * 3 + c] * offset - position[c]);
    out.push([0, 1, 2].map((c) => R[0][c] * p[0] + R[1][c] * p[1] + R[2][c] * p[2]));
  }
  return out;
}
function insideBox(points, size, tolerance = 1e-5) {
  for (const p of points)
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(p[c]) <= size[c] / 2 + tolerance, `vertex ${p} outside the box`);
}

test('a decal on a plane is the box footprint: area x * y, UVs 0..1 matching position, lifted by the offset', () => {
  const plane = planeGeometry(4, 4, 7, 5),
    size = [1, 0.5, 1],
    position = [0.3, -0.4, 0],
    g = decalGeometry(plane, identity, position, [0, 0, 0, 1], size, { offset: 0.01 });
  assertValid(g, 'plane decal');
  assertUVRange(g, 'plane decal');
  assertNormalsAgreeWithWinding(g, 'plane decal');
  close(surfaceArea(g), 0.5, 1e-6, 'footprint area');
  const points = local(g, position, [0, 0, 0, 1], 0.01);
  insideBox(points, size);
  for (let i = 0; i < vertexCount(g); i++) {
    close(g.positions[i * 3 + 2], 0.01, 1e-7, 'lifted along +z');
    close(g.uvs[i * 2], points[i][0] / size[0] + 0.5, 1e-6, 'u from box x');
    close(g.uvs[i * 2 + 1], points[i][1] / size[1] + 0.5, 1e-6, 'v from box y');
  }
  // The four box corners are reached: UVs span the whole 0..1 square.
  for (const corner of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ])
    assert.ok(
      Array.from({ length: vertexCount(g) }, (_, i) => [g.uvs[i * 2], g.uvs[i * 2 + 1]]).some(
        (uv) => Math.abs(uv[0] - corner[0]) < 1e-6 && Math.abs(uv[1] - corner[1]) < 1e-6,
      ),
      `uv corner ${corner}`,
    );
  // Default offset: 1/1000 of the smaller side.
  const lifted = decalGeometry(plane, identity, position, [0, 0, 0, 1], size);
  close(lifted.positions[2], 0.0005, 1e-9, 'default offset');
});

test('the world matrix and the orientation move the clip box with the surface', () => {
  // The plane turned to face +y, scaled 2x and moved; the projector looks down -y (a quarter turn about x).
  const m = transform(-Math.PI / 2, 2, [5, 1, -3]),
    orientation = quaternionX(-Math.PI / 2),
    position = [5.2, 1, -3.1],
    size = [0.8, 0.6, 0.4],
    g = decalGeometry(planeGeometry(2, 2, 3, 3), m, position, orientation, size, { offset: 0 });
  assertValid(g, 'turned');
  assertUVRange(g, 'turned');
  assertNormalsAgreeWithWinding(g, 'turned');
  close(surfaceArea(g), 0.8 * 0.6, 1e-6, 'turned footprint');
  insideBox(local(g, position, orientation, 0), size);
  for (let i = 0; i < vertexCount(g); i++) {
    close(g.positions[i * 3 + 1], 1, 1e-6, 'on the moved plane');
    close(g.normals[i * 3 + 1], 1, 1e-6, 'normal turned to +y');
  }
  // Euler XYZ radians give the same decal as the quaternion.
  const euler = decalGeometry(planeGeometry(2, 2, 3, 3), m, position, [-Math.PI / 2, 0, 0], size, { offset: 0 });
  for (let i = 0; i < g.positions.length; i++) close(euler.positions[i], g.positions[i], 1e-6, 'euler');
});

test('on a sphere every triangle is clipped into the box, faces the projector and keeps unit normals', () => {
  const sphere = sphereGeometry(1, 48, 24),
    size = [0.9, 0.7, 3],
    position = [0, 0, 0],
    g = decalGeometry(sphere, identity, position, [0, 0, 0, 1], size, { offset: 0 });
  assertValid(g, 'sphere decal');
  assertUVRange(g, 'sphere decal');
  assertNormalsAgreeWithWinding(g, 'sphere decal');
  insideBox(local(g, position, [0, 0, 0, 1], 0), size);
  for (let i = 0; i < vertexCount(g); i++) assert.ok(g.normals[i * 3 + 2] > -1e-6, 'front half only');
  // The box reaches through the sphere: keeping back faces adds the far side, its mirror image in z.
  const both = decalGeometry(sphere, identity, position, [0, 0, 0, 1], size, { offset: 0, backfaces: true });
  close(surfaceArea(both), 2 * surfaceArea(g), 1e-4, 'both sides');
  // Projected area: the footprint of the front half inside the box is close to x * y.
  let projected = 0;
  for (let t = 0; t < g.indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => g.indices[t + k] * 3);
    projected +=
      ((g.positions[b] - g.positions[a]) * (g.positions[c + 1] - g.positions[a + 1]) -
        (g.positions[b + 1] - g.positions[a + 1]) * (g.positions[c] - g.positions[a])) /
      2;
  }
  close(projected, 0.9 * 0.7, 0.01, 'projected footprint');
});

test('a mirroring world matrix keeps decal triangles front-facing; bad input throws', () => {
  // Mirrored in x, the plane's triangles wind clockwise in world space but still face +z.
  const m = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    g = decalGeometry(planeGeometry(2, 2, 2, 2), m, [0, 0, 0], [0, 0, 0, 1], [1, 1, 1], { offset: 0 });
  close(surfaceArea(g), 1, 1e-6, 'mirrored footprint');
  assertNormalsAgreeWithWinding(g, 'mirrored');
  const plane = planeGeometry();
  assert.throws(() => decalGeometry({}, identity, [0, 0, 0], [0, 0, 0, 1], [1, 1, 1]), TypeError);
  assert.throws(() => decalGeometry(plane, [1, 2], [0, 0, 0], [0, 0, 0, 1], [1, 1, 1]), /matrix needs 16 numbers/);
  assert.throws(
    () => decalGeometry(plane, new Array(16).fill(0), [0, 0, 0], [0, 0, 0, 1], [1, 1, 1]),
    /matrix is singular/,
  );
  assert.throws(() => decalGeometry(plane, identity, [0, 0, 0], [0, 0, 0, 0], [1, 1, 1]), /zero quaternion/);
  assert.throws(() => decalGeometry(plane, identity, [0, 0, 0], [0, 0, 0, 1], [1, 0, 1]), /size must be > 0/);
  assert.throws(() => decalGeometry(plane, identity, [0, Number.NaN, 0], [0, 0, 0, 1], [1, 1, 1]), /position/);
  assert.throws(
    () => decalGeometry(plane, identity, [0, 0, 0], [0, 0, 0, 1], [1, 1, 1], { offset: Number.NaN }),
    /offset/,
  );
});
