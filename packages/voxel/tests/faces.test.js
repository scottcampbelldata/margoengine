// The normal-map frame of voxel faces: the shaders' voxelNormal(n, t, m) = normalize(u*m.x + cross(n,u)*m.y + n*m.z)
// with u = t made perpendicular to n, t = TANGENTS[face]. This checks that frame against the faces' tile coordinates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalShader, TANGENTS, tile, tileShader } from '../src/faces.ts';

const NORMALS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a) => a.map((x) => x / Math.hypot(...a));
const close = (a, b, message) => a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) < 1e-9, `${message}: ${a} vs ${b}`));
// The shader's math, written out (the WGSL text is checked against it below).
function voxelNormal(n, t, m) {
  const u = unit(t.map((x, i) => x - n[i] * dot(n, t))),
    b = cross(n, u);
  return unit([0, 1, 2].map((i) => u[i] * m[0] + b[i] * m[1] + n[i] * m[2]));
}
// Moving one block along the tangent moves the tile coordinates +1 in u and 0 in v; along N x T it moves -1 in v
// (up the image, where a normal map's +y points).
test('face tangents follow +u and their bitangents point up the image on every face', () => {
  const p = [0.25, 0.5, 0.75];
  NORMALS.forEach((n, face) => {
    const t = TANGENTS[face],
      b = cross(n, t),
      at = tile(face, p),
      du = tile(
        face,
        p.map((x, i) => x + t[i]),
      ),
      dv = tile(
        face,
        p.map((x, i) => x + b[i]),
      );
    assert.equal(dot(n, t), 0, `face ${face} tangent lies in the face`);
    close([du[0] - at[0], du[1] - at[1]], [1, 0], `face ${face} tangent`);
    close([dv[0] - at[0], dv[1] - at[1]], [0, -1], `face ${face} bitangent`);
  });
});

test('a flat normal map leaves every face normal unchanged; a tilted one tilts along the face, not the world', () => {
  const flat = [0, 0, 1],
    right = unit([1, 0, 1]);
  NORMALS.forEach((n, face) => {
    close(voxelNormal(n, TANGENTS[face], flat), n, `face ${face} flat`);
    close(voxelNormal(n, TANGENTS[face], right), unit(n.map((x, i) => x + TANGENTS[face][i])), `face ${face} tilt`);
    // The old shader added the sample in world space: a flat map pushed every face toward +z.
    if (face !== 4) assert.ok(Math.abs(dot(voxelNormal(n, TANGENTS[face], flat), [0, 0, 1]) - n[2]) < 1e-9);
  });
  // A chamfer strip's sloped normal and a cross's up normal get a perpendicular frame from the same tangent.
  const slope = unit([1, 1, 0]);
  close(voxelNormal(slope, TANGENTS[0], flat), slope, 'strip flat');
  assert.ok(Math.abs(dot(voxelNormal([0, 1, 0], TANGENTS[6], [1, 0, 0]), [0, 1, 0])) < 1e-9, 'cross tilt in plane');
});

test('the WGSL frame is the one checked here', () => {
  assert.ok(normalShader.includes('let u=normalize(t-n*dot(n,t));return normalize(u*m.x+cross(n,u)*m.y+n*m.z);'));
  for (const t of TANGENTS) assert.ok(normalShader.includes(`vec3f(${t.join(',')})`));
});

test('the WGSL voxelTile, generated from the same table, gives the JS tile coordinates on all eight faces', () => {
  const cases = [...tileShader.matchAll(/(?:case (\d)u|default) \{return vec2f\(([^,]+),([^)]+)\);\}/g)];
  assert.equal(cases.length, 8);
  const l = [3.25, 7.5, 11.75],
    cell = [3, 7, 11];
  for (const [, face = '7', u, v] of cases) {
    const value = (text) =>
      Function('l', 'cell', `return ${text.replaceAll('.0', '')};`)({ x: l[0], y: l[1], z: l[2] }, { x: cell[0] });
    assert.deepEqual([value(u), value(v)], tile(+face, l, cell[0]), `face ${face}`);
  }
  // Moving along a cross quad's tangent advances u by its length, as on the cube faces.
  for (const face of [6, 7]) {
    const t = TANGENTS[face],
      at = tile(face, l, 3),
      next = tile(
        face,
        l.map((x, i) => x + t[i] * Math.SQRT2),
        3,
      );
    close([next[0] - at[0], next[1] - at[1]], [1, 0], `face ${face}`);
  }
});

test('cross-quad tile terms keep the hand-written order, so their texture coordinates round as before', () => {
  assert.ok(tileShader.includes('case 6u {return vec2f(l.x-cell.x,-l.y);}'));
  assert.ok(tileShader.includes('default {return vec2f(cell.x+1.0-l.x,-l.y);}'));
});
