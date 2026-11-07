import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { exportUSDZ } from '@margoengine/exporters/usdz';
import { parseUSDA, parseUSDZ, parseAny, detectFormat, crc32 } from '../dist/index.js';
const triangle = `def Mesh "Triangle" {
 point3f[] points = [(0,0,0),(1,0,0),(0,1,0)]
 int[] faceVertexCounts = [3]
 int[] faceVertexIndices = [0,1,2]
 uniform token subdivisionScheme = "none"
}`;
const stage = (body, meta = 'metersPerUnit = 1 upAxis = "Y"') => `#usda 1.0\n(${meta})\n${body}`;
test('USDA imports nested transforms, units, Z up, visibility and reset stacks', () => {
  const source = stage(
    `def Xform "Parent" {
 double3 xformOp:translate = (10,20,30)
 uniform token[] xformOpOrder = ["xformOp:translate"]
 ${triangle}
 def Xform "Reset" { double3 xformOp:translate = (1,2,3)
 uniform token[] xformOpOrder = ["!resetXformStack!","xformOp:translate"]
 ${triangle.replace('"Triangle"', '"ResetTriangle"')}
 }
 def Xform "Hidden" { token visibility = "invisible"
 ${triangle}
 }
}`,
    'metersPerUnit = 0.1 upAxis = "Z"',
  );
  const result = parseUSDA(source);
  assert.equal(result.groups.length, 2);
  for (const [i, value] of [1, 3, -2].entries()) assert.ok(Math.abs(result.positions[i] - value) < 1e-6);
  for (const [i, value] of [0.1, 0.3, -0.2].entries()) assert.ok(Math.abs(result.positions[9 + i] - value) < 1e-6);
  const file = parseUSDA(source, { units: 'file' });
  assert.deepEqual(Array.from(file.positions.slice(0, 3)), [10, 30, -20]);
});
test('USDA handles affine matrices, rotation, reflected and left-handed winding', () => {
  const source = stage(
    triangle.replace(
      ' point3f[]',
      ' matrix4d xformOp:transform = ((-1,0,0,0),(0,1,0,0),(0,0,1,0),(2,3,4,1))\n uniform token[] xformOpOrder = ["xformOp:transform"]\n point3f[]',
    ),
  );
  const mesh = parseUSDA(source);
  assert.deepEqual(Array.from(mesh.positions.slice(0, 6)), [2, 3, 4, 1, 3, 4]);
  assert.deepEqual(Array.from(mesh.indices), [0, 2, 1]);
  const left = parseUSDA(
    stage(triangle.replace(' point3f[]', ' uniform token orientation = "leftHanded"\n point3f[]')),
  );
  assert.deepEqual(Array.from(left.indices), [0, 2, 1]);
  const rotated = parseUSDA(
    stage(
      `def Xform "Rotate" { float3 xformOp:rotateXYZ = (0,0,90)\n uniform token[] xformOpOrder = ["xformOp:rotateXYZ"]\n${triangle}}`,
    ),
  );
  assert.ok(Math.abs(rotated.positions[3]) < 1e-6);
  assert.ok(Math.abs(rotated.positions[4] - 1) < 1e-6);
});
test('USDA validates topology, syntax, unsupported composition and budgets', () => {
  for (const [source, pattern] of [
    [triangle.replace('[0,1,2]', '[0,1,9]'), /index/],
    [triangle.replace('[3]', '[4]'), /Counts/],
    [triangle.replace('"none"', '"catmullClark"'), /subdivision/],
    [triangle.replace('(1,0,0)', '(1e100,0,0)'), /Float32/],
  ])
    assert.throws(() => parseUSDA(stage(source)), pattern);
  assert.throws(() => parseUSDA(stage(triangle), { maxVertices: 2 }), /vertex limit/);
  assert.throws(() => parseUSDA(stage(triangle), { maxTriangles: 0 }), /triangle limit/);
  assert.throws(() => parseUSDA(stage(triangle), { maxEntryBytes: 1 }), /maxEntryBytes/);
  assert.throws(() => parseUSDA(stage(triangle), { signal: AbortSignal.abort() }), /aborted/);
  assert.throws(() => parseUSDA(stage(`def Xform "A" (references = @other.usda@) {${triangle}}`)), /composition/);
  assert.throws(
    () => parseUSDA(stage(triangle.replace(' point3f[]', ' point3f[] points.timeSamples = { 0: [] }\n point3f[]'))),
    /animated/,
  );
  const concave = triangle
    .replace('[(0,0,0),(1,0,0),(0,1,0)]', '[(0,0,0),(2,0,0),(1,0.5,0),(2,2,0),(0,2,0)]')
    .replace('[3]', '[5]')
    .replace('[0,1,2]', '[0,1,2,3,4]');
  assert.throws(() => parseUSDA(stage(concave)), /concave/);
  const square = triangle
    .replace('[(0,0,0),(1,0,0),(0,1,0)]', '[(0,0,0),(1,0,0),(1,1,0),(0,1,0)]')
    .replace('[3]', '[4]')
    .replace('[0,1,2]', '[0,1,2,3]');
  assert.equal(parseUSDA(stage(square)).indices.length, 6);
  assert.throws(
    () => parseUSDA(stage(triangle.replace(' uniform token subdivisionScheme = "none"', ''))),
    /subdivision/,
  );
  assert.throws(
    () => parseUSDA(stage(triangle.replace(' point3f[]', ' int[] holeIndices = [0]\n point3f[]'))),
    /hole faces/,
  );
});
test('USDZ detection, CRC, stored/aligned envelope and USDC rejection', async () => {
  const archive = exportUSDZ({ nodes: [{ geometry: box() }] });
  assert.equal(detectFormat(archive), 'usdz');
  assert.equal((await parseAny(archive)).indices.length, 36);
  assert.equal(detectFormat(new TextEncoder().encode(stage(triangle))), 'usda');
  assert.equal((await parseAny(new TextEncoder().encode(stage(triangle)))).indices.length, 3);
  const corrupt = archive.slice(),
    view = new DataView(corrupt.buffer),
    start = 30 + view.getUint16(26, true) + view.getUint16(28, true),
    central = view.getUint32(corrupt.length - 6, true);
  corrupt[start] ^= 1;
  await assert.rejects(parseUSDZ(corrupt), /CRC/);
  const binary = archive.slice();
  binary.set(new TextEncoder().encode('PXR-USDC'), start);
  const checksum = crc32(binary.subarray(start, central));
  new DataView(binary.buffer).setUint32(14, checksum, true);
  new DataView(binary.buffer).setUint32(central + 16, checksum, true);
  await assert.rejects(parseUSDZ(binary), /USDC/);
  const unaligned = archive.slice();
  new DataView(unaligned.buffer).setUint16(28, 1, true);
  await assert.rejects(parseUSDZ(unaligned), /64 bytes/);
  const compressed = archive.slice();
  new DataView(compressed.buffer).setUint16(central + 10, 8, true);
  await assert.rejects(parseUSDZ(compressed), /compression/);
});

test('USDA resolves indexed vertex displayColor and displayOpacity without dropping alpha', () => {
  const attrs = `
 color3f[] primvars:displayColor = [(0.25,0.5,1),(1,0,0.5)] (interpolation = "vertex")
 int[] primvars:displayColor:indices = [1,0,1]
 float[] primvars:displayOpacity = [0.25,0.75] (interpolation = "vertex")
 int[] primvars:displayOpacity:indices = [0,1,0]
 `;
  const mesh = parseUSDA(stage(triangle.replace(' point3f[]', `${attrs}\n point3f[]`)));
  const srgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
  assert.deepEqual(
    [...mesh.colors],
    [1, 0, 0.5, 0.25, 0.5, 1, 1, 0, 0.5].map((v) => Math.fround(srgb(v))),
  );
  assert.deepEqual([...mesh.attributes.opacity], [0.25, 0.75, 0.25]);
  for (const [invalid, pattern] of [
    [attrs.replace('[1,0,1]', '[1,0]'), /length/],
    [attrs.replace('[1,0,1]', '[1,0,2]'), /index/],
    [attrs.replace('[1,0,1]', '[1,0,-1]'), /index/],
    [attrs.replace('"vertex"', '"faceVarying"'), /interpolation/],
    [attrs.replace('(0.25,0.5,1)', '(0.25,0.5,2)'), /color|primvar/],
  ])
    assert.throws(() => parseUSDA(stage(triangle.replace(' point3f[]', `${invalid}\n point3f[]`))), pattern);
});

test('USDA reader fallback, constant opacity, mixed meshes and unsupported graphs stay explicit', () => {
  const material = `def Material "Mat" {
 token outputs:surface.connect = </Mat/Surface.outputs:surface>
 def Shader "Surface" {
  uniform token info:id = "UsdPreviewSurface"
  color3f inputs:diffuseColor.connect = </Mat/Color.outputs:result>
  float inputs:opacity = 0.5
 }
 def Shader "Color" {
  uniform token info:id = "UsdPrimvarReader_float3"
  string inputs:varname = "absent"
  float3 inputs:fallback = (0.25,0.5,1)
  float3 outputs:result
 }
}`;
  const bound = triangle.replace(' point3f[]', ' rel material:binding = </Mat>\n point3f[]');
  const plain = parseUSDA(stage(material + bound));
  assert.equal(plain.colors, undefined);
  assert.equal(plain.groups[0].color[3], 0.5);
  assert.ok(Math.abs(plain.groups[0].color[0] - 0.5370987304831942) < 1e-10);
  const varied = triangle
    .replace('"Triangle"', '"Vertex"')
    .replace(
      ' point3f[]',
      ' color3f[] primvars:displayColor = [(1,0,0),(0,1,0),(0,0,1)] (interpolation = "vertex")\n point3f[]',
    );
  const mixed = parseUSDA(stage(material + bound + varied));
  assert.equal(mixed.colors.length, 18);
  assert.deepEqual([...mixed.attributes.opacity], [0.5, 0.5, 0.5, 1, 1, 1]);
  assert.equal(mixed.groups[1].color, undefined);
  assert.throws(
    () => parseUSDA(stage(material.replace('UsdPrimvarReader_float3', 'UsdUVTexture') + bound)),
    /PrimvarReader/,
  );
  assert.throws(
    () =>
      parseUSDA(
        stage(
          material.replace(
            'float3 inputs:fallback',
            'string inputs:varname.connect = </Other.outputs:result>\n float3 inputs:fallback',
          ) + bound,
        ),
      ),
    /PrimvarReader/,
  );
});

test("regression: triple single quoted strings, as MaterialX's converter writes in customLayerData", () => {
  const meta = `customLayerData = {\n string source = '''Converted to usd from teapot.obj'''\n}\nmetersPerUnit = 1 upAxis = "Y"`;
  assert.equal(parseUSDA(stage(triangle, meta)).positions.length, 9);
});

test('USDA ignores every transform op up to the last reset', () => {
  const result = parseUSDA(
    stage(`def Xform "Parent" {
 double3 xformOp:translate = (10,0,0)
 uniform token[] xformOpOrder = ["xformOp:translate"]
 def Xform "Late" { double3 xformOp:translate:ignored = (50,0,0)
 double3 xformOp:translate = (1,2,3)
 uniform token[] xformOpOrder = ["xformOp:translate:ignored","!resetXformStack!","xformOp:translate"]
 ${triangle}
 }
}`),
  );
  assert.deepEqual(Array.from(result.positions.slice(0, 3)), [1, 2, 3]);
});
