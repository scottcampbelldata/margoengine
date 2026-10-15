import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { exportUSDZ } from '@margoengine/exporters';
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
