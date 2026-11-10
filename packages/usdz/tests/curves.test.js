import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUSDA } from '../dist/index.js';
import { curves } from '../dist/curves.js';
import { composition } from '../dist/compose.js';
import { pointInstancers } from '../dist/instancer.js';
import { GLTFAsset } from '@margoengine/gltf-pro/asset';
const parse = (body, options = {}) =>
  parseUSDA('#usda 1.0\n(metersPerUnit=1 upAxis="Y")\n' + body, { extensions: [curves({ segments: 2 })], ...options });
const part = (asset) => {
  const mesh = asset.document.meshes[0],
    p = mesh.extras.usdCurves[0],
    gltf = new GLTFAsset(asset.document, asset.buffers);
  return Object.fromEntries(['points', 'widths', 'colors'].map((k) => [k, Array.from(gltf.accessor(p[k]))]));
};
test('curve prototypes share generated geometry regardless of extension order', () => {
  const text =
    '#usda 1.0\ndef PointInstancer "I" { rel prototypes=</I/P> int[] protoIndices=[0,0] point3f[] positions=[(0,0,0),(1,0,0)] def Points "P" {point3f[] points=[(0,0,0)]} }';
  for (const extensions of [
    [pointInstancers(), curves()],
    [curves(), pointInstancers()],
  ]) {
    const asset = parseUSDA(text, { extensions });
    const instances = asset.document.nodes.filter((node) => node.extras?.usdInstanceId !== undefined);
    assert.equal(instances.length, 2);
    const meshes = instances.map((node) => asset.document.nodes[node.children[0]].mesh);
    assert.deepEqual(meshes, [0, 0]);
  }
});
test('linear multi-curves, periodic closure, world widths and indexed uniform colors', () => {
  const a = parse(
    'def BasisCurves "C" { token type="linear" token wrap="periodic" int[] curveVertexCounts=[3,3] point3f[] points=[(0,0,0),(1,0,0),(0,1,0),(2,0,0),(3,0,0),(2,1,0)] float[] widths=[0.1,0.2] (interpolation="uniform") color3f[] primvars:displayColor=[(1,0,0),(0,1,0)] (interpolation="uniform") int[] primvars:displayColor:indices=[1,0] }',
  );
  assert.equal(a.document.meshes[0].extras.usdCurves.length, 2);
  const p = part(a);
  assert.deepEqual(p.points.slice(0, 3), p.points.slice(-3));
  assert.ok(Math.abs(p.widths[2] - 0.1) < 1e-7);
  assert.deepEqual(p.colors.slice(0, 4), [0, 1, 0, 1]);
});
for (const [basis, mid] of [
  ['bezier', 1.5],
  ['bspline', 1.5],
  ['catmullRom', 1.5],
])
  test(basis + ' cubic evaluation and varying widths', () => {
    const p = part(
      parse(
        `def BasisCurves "C" { token basis="${basis}" int[] curveVertexCounts=[4] point3f[] points=[(0,0,0),(1,0,0),(2,0,0),(3,0,0)] float[] widths=[0,2] (interpolation="varying") }`,
      ),
    );
    assert.equal(p.points[3], mid);
    assert.deepEqual(p.widths, [0, 1, 2]);
  });
for (const basis of ['bspline', 'catmullRom'])
  test(basis + ' pinned phantom endpoints', () => {
    const p = part(
      parse(
        `def BasisCurves "C" { token basis="${basis}" token wrap="pinned" int[] curveVertexCounts=[2] point3f[] points=[(0,0,0),(3,0,0)] }`,
      ),
    );
    assert.deepEqual(p.points, [0, 0, 0, 1.5, 0, 0, 3, 0, 0]);
  });
test('Points sampled positions, diameters, indexed colors, opacity and hierarchy', () => {
  const a = parse(
    'def Xform "Root" { def Points "P" { point3f[] points.timeSamples={0:[(0,0,0),(1,0,0)],2:[(2,0,0),(3,0,0)]} float[] widths=[0.2,0.4] color3f[] primvars:displayColor=[(1,0,0)] (interpolation="constant") float[] primvars:displayOpacity=[0.5,1] (interpolation="vertex") } }',
    { extensions: [composition(), curves({ timeCode: 1 })] },
  );
  const p = part(a);
  assert.deepEqual(p.points, [1, 0, 0, 2, 0, 0]);
  assert.equal(p.colors[3], 0.5);
  assert.ok(Math.abs(p.widths[1] - 0.4) < 1e-7);
  assert.deepEqual(a.document.nodes[1].children, [2]);
});
test('counts, basis and stream cardinalities reject before output allocation', () => {
  assert.throws(() => curves({ segments: 0 }), /options/);
  assert.throws(
    () =>
      parse(
        'def BasisCurves "C" { int[] curveVertexCounts=[5] point3f[] points=[(0,0,0),(1,0,0),(2,0,0),(3,0,0),(4,0,0)] }',
      ),
    /basis step/,
  );
  const body = 'def Points "P" { point3f[] points=[(0,0,0),(1,0,0)] float[] widths=[1] }';
  assert.throws(() => parse(body), /cardinality/);
  assert.throws(() => parse('def Points "P" { point3f[] points=[(0,0,0),(1,0,0)] }', { maxVertices: 1 }), /budget/);
});
