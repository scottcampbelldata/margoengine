// A material's maps may read different UV primvars. Each lands on a TEXCOORD set of its own, and the texture info says
// which, for the base reader, previewSurface() and materialX().
import assert from 'node:assert/strict';
import test from 'node:test';
import { GLTFAsset } from '@margoengine/gltf/asset';
import { parseUSDA } from '../dist/index.js';
import { parseUSDFiles } from '../dist/compose.js';
import { materialX } from '../dist/materialx.js';
import { previewSurface } from '../dist/preview-surface.js';

const A = [0, 0, 1, 0, 0, 1],
  B = [0.25, 0.5, 0.75, 0.5, 0.25, 1],
  C = [0.125, 0.125, 0.875, 0.125, 0.125, 0.875];
/** USD's t points up and glTF's v down. */
const flipped = (uv) => uv.map((x, i) => (i % 2 ? 1 - x : x));
const tuples = (uv) => '[' + [0, 2, 4].map((i) => `(${uv[i]}, ${uv[i + 1]})`).join(', ') + ']';
const primvar = (name, uv) => `float2[] primvars:${name} = ${tuples(uv)} (interpolation="vertex")`;
const triangle = (name, material, extra = '') => `def Mesh "${name}" {
  uniform token subdivisionScheme="none"
  rel material:binding=<${material}>
  int[] faceVertexCounts=[3] int[] faceVertexIndices=[0,1,2] point3f[] points=[(0,0,0),(1,0,0),(0,1,0)]
  ${primvar('st', A)}
  ${primvar('st1', B)}
  ${primvar('detail', C)}
  ${extra}
}`;
/** A UsdPreviewSurface whose maps, `slot: primvar`, each read their own primvar. */
const surface = (name, maps, extra = '') => {
  const inputs = [],
    shaders = [];
  for (const [slot, from] of Object.entries(maps)) {
    const type = ['roughness', 'metallic'].includes(slot) ? 'r' : 'rgb';
    inputs.push(`color3f inputs:${slot}.connect=</${name}/${slot}.outputs:${type}>`);
    shaders.push(
      `def Shader "${slot}" { uniform token info:id="UsdUVTexture" asset inputs:file=@${slot}.png@
       float2 inputs:st.connect=</${name}/${slot}UV.outputs:result> }`,
      `def Shader "${slot}UV" { uniform token info:id="UsdPrimvarReader_float2" string inputs:varname="${from}" }`,
    );
  }
  return `def Material "${name}" { token outputs:surface.connect=</${name}/S.outputs:surface>
  def Shader "S" { uniform token info:id="UsdPreviewSurface" ${inputs.join('\n')} ${extra} }
  ${shaders.join('\n')}
}`;
};
const usda = (...parts) => '#usda 1.0\n' + parts.join('\n');
/** A one-layer stage whose images are all present. */
const parse = (text, extensions = []) =>
  parseUSDFiles('a.usda', (id) => new TextEncoder().encode(id === 'a.usda' ? text : 'image'), { extensions });
/** The coordinates a texture info of a primitive samples. */
const sampled = (asset, primitive, info) => {
  const gltf = new GLTFAsset(asset.document, asset.buffers);
  return Array.from(gltf.accessor(primitive.attributes['TEXCOORD_' + (info.texCoord ?? 0)], 'VEC2'));
};
const maps = (material) => ({
  base: material.pbrMetallicRoughness.baseColorTexture,
  rough: material.pbrMetallicRoughness.metallicRoughnessTexture,
  normal: material.normalTexture,
});

for (const [reader, extensions] of [
  ['the base reader', []],
  ['previewSurface()', [previewSurface()]],
])
  test(`each map of a material samples its own UV primvar: ${reader}`, async () => {
    const asset = await parse(
        usda(triangle('M', '/Mat'), surface('Mat', { diffuseColor: 'st', normal: 'st1', roughness: 'detail' })),
        extensions,
      ),
      primitive = asset.document.meshes[0].primitives[0],
      { base, normal, rough } = maps(asset.document.materials[0]);
    assert.equal(base.texCoord ?? 0, 0);
    assert.deepEqual(
      [base, normal, rough].map((info) => sampled(asset, primitive, info)),
      [A, B, C].map(flipped),
    );
    assert.deepEqual(Array.from(asset.meshes[0].uvs), A, 'the mesh stream is the first set, as authored');
  });

test('maps that name one primvar share its set', async () => {
  const asset = await parse(usda(triangle('M', '/Mat'), surface('Mat', { diffuseColor: 'st1', normal: 'st1' }))),
    { attributes } = asset.document.meshes[0].primitives[0],
    { base, normal } = maps(asset.document.materials[0]);
  assert.equal(base.texCoord ?? 0, 0);
  assert.equal(normal.texCoord ?? 0, 0);
  assert.equal(attributes.TEXCOORD_1, undefined);
  assert.deepEqual(Array.from(asset.meshes[0].uvs), B);
});

test('GeomSubsets whose materials read different primvars get their own sets', async () => {
  const quad = `def Mesh "M" {
    uniform token subdivisionScheme="none"
    rel material:binding=</Mat>
    int[] faceVertexCounts=[3,3] int[] faceVertexIndices=[0,1,2,0,2,3]
    point3f[] points=[(0,0,0),(1,0,0),(1,1,0),(0,1,0)]
    float2[] primvars:st = [(0,0),(1,0),(1,1),(0,1)] (interpolation="vertex")
    float2[] primvars:st1 = [(0.5,0.5),(0.75,0.5),(0.75,0.75),(0.5,0.75)] (interpolation="vertex")
    def GeomSubset "Other" { uniform token elementType="face" int[] indices=[1] rel material:binding=</Swapped> }
  }`;
  const asset = await parse(
      usda(
        quad,
        surface('Mat', { diffuseColor: 'st', normal: 'st1' }),
        surface('Swapped', { diffuseColor: 'st1', normal: 'st' }),
      ),
    ),
    primitives = asset.document.meshes[0].primitives;
  assert.equal(primitives.length, 2);
  for (const primitive of primitives) {
    const material = asset.document.materials[primitive.material],
      { base, normal } = maps(material),
      st = [0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0],
      other = [0.5, 0.5, 0.75, 0.5, 0.75, 0.25, 0.5, 0.5, 0.75, 0.25, 0.5, 0.25],
      swapped = material.name === '/Swapped';
    assert.deepEqual(sampled(asset, primitive, base), swapped ? other : st, material.name);
    assert.deepEqual(sampled(asset, primitive, normal), swapped ? st : other, material.name);
  }
});

test('previewSurface() keeps a separate opacity map on TEXCOORD_1 beside other sets', async () => {
  const text = usda(
      triangle('M', '/Mat'),
      surface('Mat', { diffuseColor: 'st', normal: 'detail', opacity: 'st1' }, 'float inputs:opacityThreshold=0.5'),
    ),
    asset = await parse(text, [previewSurface()]),
    primitive = asset.document.meshes[0].primitives[0],
    material = asset.document.materials[0],
    { base, normal } = maps(material);
  assert.equal(material.extras.usdPreviewOpacity.texCoord, 1);
  assert.deepEqual(sampled(asset, primitive, { texCoord: 1 }), flipped(B));
  assert.deepEqual(sampled(asset, primitive, base), flipped(A));
  assert.equal(normal.texCoord, 2);
  assert.deepEqual(sampled(asset, primitive, normal), flipped(C));
});

test('a blocked or missing opacity primvar reads the fallback on TEXCOORD_1 only', async () => {
  const text = usda(
      triangle('M', '/Mat', 'float2[] primvars:gone = None'),
      surface('Mat', { diffuseColor: 'st', opacity: 'gone' }),
    ),
    asset = await parse(text, [previewSurface()]),
    primitive = asset.document.meshes[0].primitives[0];
  assert.deepEqual(sampled(asset, primitive, { texCoord: 1 }), [0, 1, 0, 1, 0, 1]);
  assert.deepEqual(sampled(asset, primitive, maps(asset.document.materials[0]).base), flipped(A));
});

test('materialX() binds each image to the primvar its network reads', async () => {
  const image = (name, from) => `def Shader "${name}" { uniform token info:id="ND_image_${
    name === 'Normal' ? 'vector3' : 'color3'
  }" asset inputs:file=@${name}.png@
    float2 inputs:texcoord.connect=</Look/${name}UV.outputs:out> ${name === 'Normal' ? 'float3' : 'color3f'} outputs:out }
  def Shader "${name}UV" { uniform token info:id="ND_geompropvalue_vector2" string inputs:geomprop="${from}"
    float2 outputs:out }`;
  const text = usda(
      triangle('M', '/Look'),
      `def Material "Look" { token outputs:mtlx:surface.connect=</Look/S.outputs:out>
  def Shader "S" { uniform token info:id="ND_standard_surface_surfaceshader"
    color3f inputs:base_color.connect=</Look/Color.outputs:out>
    float3 inputs:normal.connect=</Look/Normal.outputs:out> token outputs:out }
  ${image('Color', 'st')}
  ${image('Normal', 'st1')}
}`,
    ),
    asset = await parse(text, [materialX()]),
    primitive = asset.document.meshes[0].primitives[0],
    { base, normal } = maps(asset.document.materials[0]);
  assert.deepEqual(sampled(asset, primitive, base), flipped(A));
  assert.equal(normal.texCoord, 1);
  assert.deepEqual(sampled(asset, primitive, normal), flipped(B));
});

test('a fifth texture coordinate primvar and split roughness and metallic coordinates are refused', async () => {
  const five = { diffuseColor: 'st', normal: 'st1', roughness: 'detail', emissiveColor: 'd', opacity: 'e' },
    more = ['d', 'e'].map((name) => primvar(name, A)).join('\n'),
    asset = await parse(usda(triangle('M', '/Mat', more), surface('Mat', five)), [previewSurface()]);
  assert.ok(asset.issues.some((issue) => /more than 4 texture coordinate primvars/.test(issue.message)));
  assert.equal(asset.document.materials[0].emissiveTexture.texCoord, undefined);
  const split = usda(triangle('M', '/Mat'), surface('Mat', { roughness: 'st', metallic: 'st1' }));
  assert.throws(() => parseUSDA(split), /different texture coordinates/);
  assert.throws(() => parseUSDA(split, { extensions: [previewSurface()] }), /sampling differs/);
});
