import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUSDA, parseUSDC } from '../dist/index.js';
import { writeCrate, V, lz4 } from './crate-writer.js';
// A 5x4 grid of quads, a translated parent, an `over` prim to skip, a bound PreviewSurface and a dictionary to ignore.
const grid = [],
  quads = [];
for (let y = 0; y < 4; y++) for (let x = 0; x < 5; x++) grid.push(x, y * 0.5, 0);
for (let y = 0; y < 3; y++)
  for (let x = 0; x < 4; x++) quads.push(y * 5 + x, y * 5 + x + 1, y * 5 + x + 6, y * 5 + x + 5);
const normals = grid.flatMap((_, i) => (i % 3 ? [] : [0, 0.6, 0.8])),
  st = grid.flatMap((v, i) => (i % 3 === 2 ? [] : [v * 2]));
const tuples = (list, n) =>
  list
    .reduce((out, v, i) => (i % n ? out[out.length - 1].push(v) : out.push([v]), out), [])
    .map((t) => `(${t.join(', ')})`)
    .join(', ');
const usda = `#usda 1.0
(
    metersPerUnit = 1
    upAxis = "Y"
)
def Xform "Root"
{
    double3 xformOp:translate = (0.5, 2, -3)
    double3 xformOp:scale = (1, 2, 3)
    uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:scale"]
    def Mesh "Grid"
    {
        point3f[] points = [${tuples(grid, 3)}]
        int[] faceVertexCounts = [${quads
          .map(() => 4)
          .filter((_, i) => i < 12)
          .join(', ')}]
        int[] faceVertexIndices = [${quads.join(', ')}]
        normal3f[] normals = [${tuples(normals, 3)}] (
            interpolation = "vertex"
        )
        texCoord2f[] primvars:st = [${tuples(st, 2)}] (
            interpolation = "vertex"
        )
        uniform token subdivisionScheme = "none"
        rel material:binding = </Root/Mat>
    }
    def Material "Mat"
    {
        token outputs:surface.connect = </Root/Mat/S.outputs:surface>
        def Shader "S"
        {
            uniform token info:id = "UsdPreviewSurface"
            color3f inputs:diffuseColor = (0.25, 0.5, 0.75)
            float inputs:roughness = 0.375
            float inputs:metallic = 0.5
        }
    }
}
`;
const prim = (path, typeName, extra = {}) => ({
  path,
  type: 6,
  fields: { specifier: V.specifier(0), typeName: V.token(typeName), ...extra },
});
const attr = (path, fields) => ({ path, type: 1, fields });
const specs = [
  { path: '/', type: 7, fields: { metersPerUnit: V.double(1), upAxis: V.token('Y'), customLayerData: V.dictionary() } },
  prim('/Root', 'Xform'),
  attr('/Root.xformOp:translate', { default: V.vec3d([0.5, 2, -3]) }),
  attr('/Root.xformOp:scale', { default: V.inlineVec3([1, 2, 3]) }),
  attr('/Root.xformOpOrder', { default: V.tokens(['xformOp:translate', 'xformOp:scale']) }),
  prim('/Root/Grid', 'Mesh'),
  attr('/Root/Grid.points', { default: V.vec3fArray(grid) }),
  attr('/Root/Grid.faceVertexCounts', { default: V.intArray(quads.filter((_, i) => i < 12).map(() => 4)) }),
  attr('/Root/Grid.faceVertexIndices', { default: V.intArray(quads) }),
  attr('/Root/Grid.normals', { default: V.floatArrayTable(normals), interpolation: V.token('vertex') }),
  attr('/Root/Grid.primvars:st', { default: V.floatArrayInts(st), interpolation: V.token('vertex') }),
  attr('/Root/Grid.subdivisionScheme', { default: V.token('none') }),
  { path: '/Root/Grid.material:binding', type: 8, fields: { targetPaths: V.pathList(['/Root/Mat']) } },
  { path: '/Root/Ghost', type: 6, fields: { specifier: V.specifier(1), typeName: V.token('Mesh') } },
  prim('/Root/Mat', 'Material'),
  attr('/Root/Mat.outputs:surface', { connectionPaths: V.pathList(['/Root/Mat/S.outputs:surface'], true) }),
  prim('/Root/Mat/S', 'Shader'),
  attr('/Root/Mat/S.info:id', { default: V.token('UsdPreviewSurface') }),
  attr('/Root/Mat/S.inputs:diffuseColor', { default: V.vec3f([0.25, 0.5, 0.75]) }),
  attr('/Root/Mat/S.inputs:roughness', { default: V.inlineFloat(0.375) }),
  attr('/Root/Mat/S.inputs:metallic', { default: V.half(0x3800) }),
  attr('/Root/Mat/S.outputs:surface', {}),
];
test('Crate compression paths (LZ4 matches and chunks, integer coding, float tables, list ops, half, inline vectors) match USDA', () => {
  assert.ok(lz4(Buffer.from('abcabcabcabcabcabcabcabc-tail-data')).length < 30, 'writer emits LZ4 matches');
  const crate = writeCrate(specs),
    binary = parseUSDC(crate),
    ascii = parseUSDA(usda);
  assert.equal(binary.meshes.length, 1);
  for (const key of ['positions', 'normals', 'uvs', 'indices'])
    assert.deepEqual(Array.from(binary.meshes[0][key]), Array.from(ascii.meshes[0][key]), key);
  assert.deepEqual(binary.document.nodes, ascii.document.nodes);
  assert.deepEqual(binary.document.materials, ascii.document.materials);
  assert.equal(binary.meshes[0].indices.length, 12 * 6);
});
test('Crate composition values and broken tables fail explicitly', () => {
  const timeSamples = specs.map((s) =>
    s.path === '/Root/Grid.points' ? attr(s.path, { timeSamples: { type: 46, inline: 0 } }) : s,
  );
  assert.throws(() => parseUSDC(writeCrate(timeSamples)), /composition|animation/);
  const crate = writeCrate(specs),
    at = crate.indexOf(Buffer.from('PATHS'));
  const broken = Buffer.from(crate);
  broken.writeBigUInt64LE(BigInt(crate.length - 4), at + 16);
  assert.throws(() => parseUSDC(broken), /USD/);
  const garbled = Buffer.from(crate);
  garbled.fill(0xff, 200, 260);
  assert.throws(() => parseUSDC(garbled), /USD|Crate|LZ4|index|truncated/);
});
