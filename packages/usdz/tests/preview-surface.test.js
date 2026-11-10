import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUSDA } from '../dist/index.js';
import { parseUSDFiles } from '../dist/compose.js';
import { previewSurface } from '../dist/preview-surface.js';
import { curves } from '../dist/curves.js';
import { GLTFAsset } from '@margoengine/gltf-pro/asset';
import { previewReaderFixture } from './preview-fixture.js';

const mesh = `def Mesh "M" { uniform token subdivisionScheme="none" rel material:binding=</Mat> int[] faceVertexCounts=[3] int[] faceVertexIndices=[0,1,2] point3f[] points=[(-1,-1,0),(1,-1,0),(0,1,0)]
color3f[] primvars:paint=[(1,0,0),(0,1,0),(0,0,1)] (interpolation="vertex")
float[] primvars:fade=[0.2,0.8,1] (interpolation="faceVarying")
float2[] primvars:otherUV=[(0,0),(1,0),(0,1)] (interpolation="vertex") }
`;
const material = `def Material "Mat" { token outputs:surface.connect=</Mat/S.outputs:surface>
 def Shader "S" { uniform token info:id="UsdPreviewSurface" color3f inputs:diffuseColor.connect=</Mat/Color.outputs:result> float inputs:opacity.connect=</Mat/Alpha.outputs:result> }
 def Shader "Color" {uniform token info:id="UsdPrimvarReader_float3" string inputs:varname="paint" float3 inputs:fallback=(0.1,0.2,0.3)}
 def Shader "Alpha" {uniform token info:id="UsdPrimvarReader_float" string inputs:varname="fade" float inputs:fallback=0.5}
}`;
test('arbitrary indexed color and opacity readers expand their authored interpolation', () => {
  const a = parseUSDA('#usda 1.0\n' + mesh + material, { extensions: [previewSurface()] });
  assert.deepEqual(
    Array.from(a.meshes[0].colors).map((n) => Math.round(n * 10) / 10),
    [1, 0, 0, 0.2, 0, 1, 0, 0.8, 0, 0, 1, 1],
  );
  assert.deepEqual(a.document.materials[0].pbrMetallicRoughness.baseColorFactor, [1, 1, 1, 1]);
  assert.equal(a.document.materials[0].alphaMode, 'BLEND');
});
test('all numeric inputs retain corner values and independent barycentric coordinates', () => {
  const a = parseUSDA(previewReaderFixture(), { extensions: [previewSurface()] }),
    primitive = a.document.meshes[0].primitives[0],
    data = primitive.extras.usdPreviewValues,
    gltf = new GLTFAsset(a.document, a.buffers);
  assert.equal(data.inputs.length, 11);
  const values = gltf.accessor(data.accessor),
    slot = data.inputs.indexOf('roughness');
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(values[(i * 11 + slot) * 4] - 0.4) < 1e-7);
  assert.deepEqual(Array.from(gltf.accessor(primitive.attributes.TEXCOORD_2)), [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(gltf.accessor(primitive.attributes.TEXCOORD_3)), [0, 0, 1, 0, 0, 1]);
});
test('blocked reader data uses fallback independently of its interpolation metadata', () => {
  const a = parseUSDA(
    '#usda 1.0\n' + mesh.replace('float[] primvars:fade=[0.2,0.8,1]', 'float[] primvars:fade=None') + material,
    { extensions: [previewSurface()] },
  );
  for (let i = 0; i < 3; i++) assert.equal(a.meshes[0].colors[i * 4 + 3], 0.5);
});
test('missing and blocked named primvars use typed fallbacks', () => {
  const a = parseUSDA(
    '#usda 1.0\n' +
      mesh.replace('primvars:paint', 'primvars:unused').replace('primvars:fade', 'primvars:unusedFade') +
      material,
    { extensions: [previewSurface()] },
  );
  for (let i = 0; i < 3; i++)
    for (let d = 0; d < 4; d++) assert.ok(Math.abs(a.meshes[0].colors[i * 4 + d] - [0.1, 0.2, 0.3, 0.5][d]) < 1e-7);
});
test('constant inherited custom primvars reach descendant meshes', () => {
  const text =
    '#usda 1.0\ndef Xform "Parent" {color3f[] primvars:paint=[(0.4,0.5,0.6)] (interpolation="constant") ' +
    mesh.replace(/color3f\[\] primvars:paint=[^\n]+/, '') +
    '}\n' +
    material;
  const a = parseUSDA(text, { extensions: [previewSurface()] });
  assert.ok(Math.abs(a.meshes[0].colors[0] - 0.4) < 1e-7);
});
test('separate opacity uses its own channel, UV set, transform and mask threshold', async () => {
  const m = material
    .replace(
      'float inputs:opacity.connect=</Mat/Alpha.outputs:result>',
      'float inputs:opacity.connect=</Mat/Tex.outputs:g> float inputs:opacityThreshold=0.4',
    )
    .replace(
      /def Shader "Alpha"[^\n]+/,
      `def Shader "Tex" {uniform token info:id="UsdUVTexture" asset inputs:file=@alpha.png@ float2 inputs:st.connect=</Mat/UV.outputs:result> float4 inputs:scale=(1,0.5,1,1) float4 inputs:bias=(0,0.2,0,0)} def Shader "UV" {uniform token info:id="UsdPrimvarReader_float2" string inputs:varname="otherUV"}`,
    );
  const text = '#usda 1.0\n' + mesh + m;
  const a = await parseUSDFiles('scene.usda', (id) => new TextEncoder().encode(id === 'scene.usda' ? text : 'image'), {
    extensions: [previewSurface()],
  });
  const mat = a.document.materials[0],
    opacity = mat.extras.usdPreviewOpacity,
    p = a.document.meshes[0].primitives[0];
  assert.equal(opacity.texCoord, 1);
  assert.equal(mat.alphaMode, 'MASK');
  assert.equal(mat.alphaCutoff, 0.4);
  assert.deepEqual(
    Array.from(new GLTFAsset(a.document, a.buffers).accessor(p.attributes.TEXCOORD_1)),
    [0, 1, 1, 1, 0, 0],
  );
});
test('geometry-only extensions count triangle vertices against the shared geometry budget', () => {
  const text =
    '#usda 1.0\n' + mesh.replace('rel material:binding=</Mat>', '') + 'def Points "P" {point3f[] points=[(0,0,0)]}';
  assert.throws(() => parseUSDA(text, { maxVertices: 3, extensions: [curves()] }), /budget/);
});
