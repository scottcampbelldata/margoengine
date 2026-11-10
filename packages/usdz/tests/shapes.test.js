import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parseUSDA } from '../dist/index.js';
import { implicitShapes } from '../dist/shapes.js';
import { pointInstancers } from '../dist/instancer.js';
const parse = (body, options = {}) => parseUSDA('#usda 1.0\n' + body, { extensions: [implicitShapes()], ...options });
test('all implicit types, axes, defaults and authored sizes match OpenUSD extents', () => {
  const text = readFileSync(new URL('./fixtures/shapes.usda', import.meta.url), 'utf8');
  const truth = JSON.parse(readFileSync(new URL('./fixtures/shapes-openusd.json', import.meta.url), 'utf8'));
  const asset = parseUSDA(text, { extensions: [implicitShapes()] });
  assert.equal(asset.meshes.length, Object.keys(truth).length);
  for (const m of asset.meshes) {
    const lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < m.positions.length; i++) {
      const d = i % 3;
      lo[d] = Math.min(lo[d], m.positions[i]);
      hi[d] = Math.max(hi[d], m.positions[i]);
    }
    for (let d = 0; d < 3; d++) {
      assert.ok(Math.abs(lo[d] - truth[m.path][0][d]) < 1e-6, m.path);
      assert.ok(Math.abs(hi[d] - truth[m.path][1][d]) < 1e-6, m.path);
    }
    for (let i = 0; i < m.normals.length; i += 3)
      assert.ok(Math.abs(Math.hypot(...m.normals.slice(i, i + 3)) - 1) < 1e-5);
    assert.equal(m.uvs.length, (m.positions.length / 3) * 2);
    for (let i = 0; i < m.indices.length; i += 3) {
      const p = m.positions,
        n = m.normals,
        a = i * 3,
        b = (i + 1) * 3,
        c = (i + 2) * 3;
      const u = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]],
        v = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
      const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      assert.ok(cross.reduce((s, x, d) => s + x * n[a + d], 0) >= -1e-8, m.path + ' winding');
    }
  }
});
test('shapes keep hierarchy, materials, display colors and instancer prototype sharing', () => {
  const asset = parse(
    'def PointInstancer "I" { rel prototypes = </I/C> int[] protoIndices = [0,0] point3f[] positions = [(0,0,0),(3,0,0)] def Cube "C" { color3f[] primvars:displayColor = [(1,0,0)] } }',
    { extensions: [implicitShapes(), pointInstancers()] },
  );
  assert.equal(asset.meshes.length, 1);
  assert.equal(asset.document.meshes.length, 1);
  assert.equal(asset.document.nodes.filter((n) => n.extras?.usdInstanceId !== undefined).length, 2);
  assert.deepEqual(Array.from(asset.meshes[0].colors.slice(0, 4)), [1, 0, 0, 1]);
});
test('validates resolution, dimensions and preallocation budgets', () => {
  assert.throws(() => implicitShapes({ radialSegments: 5 }), RangeError);
  assert.throws(() => implicitShapes({ latitudeSegments: 3 }), RangeError);
  assert.throws(() => parse('def Sphere "S" { double radius = -1 }'), /dimension/);
  assert.throws(() => parse('def Cylinder "C" { token axis = "bad" }'), /axis/);
  assert.throws(() => parse('def Sphere "S" {}', { maxTriangles: 1 }), /budget/);
  assert.throws(() => parse('def Sphere "S" {}', { maxVertices: 10 }), /budget/);
});
