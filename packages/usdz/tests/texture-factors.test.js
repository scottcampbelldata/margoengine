// KB-USDZ-FACTORS1: both importers read a UsdUVTexture's scale and bias, emission and occlusion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUSDA, parseUSDZ } from '../dist/index.js';
import { previewSurface } from '../dist/preview-surface.js';
import { exportUSDZ } from '../../exporters/dist/usdz.js';
import { LinearToSRGB, SRGBToLinear } from '@margoengine/math/color';
import { png, zip } from './preview-fixture.js';

const importers = [
  ['default', {}],
  ['previewSurface', { extensions: [previewSurface()] }],
];
const quad = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  uvs: [0, 0, 1, 0, 1, 1, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
};
const close = (actual, expected, label) => {
  assert.equal(actual?.length, expected.length, `${label}: ${actual}`);
  expected.forEach((v, i) => assert.ok(Math.abs(actual[i] - v) < 1e-6, `${label}: ${actual} against ${expected}`));
};
const sourceOf = (asset, info) => asset.sources[asset.document.textures[info.index].source];

test('a textured file of exportUSDZ reads back with its factors, emission and occlusion', async () => {
  const map = (r) => ({ image: new Uint8Array(png(r, 128, 255)), mimeType: 'image/png' });
  const archive = exportUSDZ({
    nodes: [
      {
        geometry: quad,
        material: {
          color: [0.5, 0.25, 1, 0.75],
          alphaMode: 'BLEND',
          roughness: 0.4,
          metalness: 0.6,
          emissive: [0.5, 0, 0.25],
          emissiveStrength: 3,
          normalScale: 0.5,
          occlusionStrength: 0.7,
          baseColorTexture: map(1),
          metallicRoughnessTexture: map(2),
          normalTexture: map(3),
          occlusionTexture: map(4),
          emissiveTexture: map(5),
        },
      },
    ],
  });
  for (const [name, options] of importers) {
    const asset = await parseUSDZ(archive, options),
      m = asset.document.materials[0],
      p = m.pbrMetallicRoughness;
    // previewSurface() samples opacity as a map of its own, which holds the alpha scale.
    close(p.baseColorFactor, [0.5, 0.25, 1, name === 'default' ? 0.75 : 1], name + ' base');
    close([p.roughnessFactor, p.metallicFactor], [0.4, 0.6], name + ' rough and metal');
    const strength = m.extensions.KHR_materials_emissive_strength.emissiveStrength;
    close(
      m.emissiveFactor.map((v) => v * strength),
      [1.5, 0, 0.75],
      name + ' emission',
    );
    assert.ok(asset.document.extensionsUsed.includes('KHR_materials_emissive_strength'), name);
    close([m.normalTexture.scale], [0.5], name + ' normal scale');
    close([m.occlusionTexture.strength], [0.7], name + ' occlusion strength');
    // The factors hold all of it, so every file goes to the model as it is.
    for (const info of [p.baseColorTexture, m.normalTexture, m.occlusionTexture, m.emissiveTexture]) {
      const source = sourceOf(asset, info);
      assert.deepEqual(Object.keys(source), ['path'], name + ' ' + JSON.stringify(source));
    }
    const packed = sourceOf(asset, p.metallicRoughnessTexture);
    assert.equal(packed.roughnessRemap, undefined, name);
    assert.equal(packed.metallicRemap, undefined, name);
  }
});

test('constant emission of exportUSDZ reads back, brighter than 1 as an emissive strength', async () => {
  const material = (emissive, emissiveStrength) =>
    exportUSDZ({ nodes: [{ geometry: quad, material: { roughness: 0.5, emissive, emissiveStrength } }] });
  for (const [name, options] of importers) {
    const dim = (await parseUSDZ(material([0.5, 0.25, 0], 1), options)).document.materials[0];
    close(dim.emissiveFactor, [0.5, 0.25, 0], name);
    assert.equal(dim.extensions?.KHR_materials_emissive_strength, undefined, name);
    const bright = (await parseUSDZ(material([1, 0.5, 0], 8), options)).document.materials[0];
    close(bright.emissiveFactor, [1, 0.5, 0], name);
    assert.equal(bright.extensions.KHR_materials_emissive_strength.emissiveStrength, 8, name);
  }
});

/** A one-triangle stage whose surface reads `inputs`, with `shaders` beside it. */
const stage = (inputs, shaders = '') =>
  zip([
    [
      'scene.usda',
      Buffer.from(`#usda 1.0
def Mesh "M" { uniform token subdivisionScheme="none" rel material:binding=</Mat> int[] faceVertexCounts=[3] int[] faceVertexIndices=[0,1,2] point3f[] points=[(0,0,0),(1,0,0),(0,1,0)] float2[] primvars:st=[(0,0),(1,0),(0,1)] (interpolation="vertex") }
def Material "Mat" { token outputs:surface.connect=</Mat/S.outputs:surface> float4 inputs:gain=(0.25,0.5,0.75,1)
 def Shader "S" { uniform token info:id="UsdPreviewSurface" ${inputs} }
 ${shaders}
}`),
    ],
    ['map.png', png(128, 64, 32)],
  ]);
const node = (name, body = '') =>
  `def Shader "${name}" { uniform token info:id="UsdUVTexture" asset inputs:file=@map.png@ ${body} }`;
const read = (name, type, input, output) => `${type} inputs:${input}.connect=</Mat/${name}.outputs:${output}>`;

for (const [name, options] of importers) {
  const only = async (inputs, shaders) => {
    const asset = await parseUSDZ(stage(inputs, shaders), options);
    return { asset, m: asset.document.materials[0], p: asset.document.materials[0].pbrMetallicRoughness };
  };

  test(`${name}: a bias or a scale past 1 on the colour is written into the pixels`, async () => {
    const { asset, p } = await only(
      read('C', 'color3f', 'diffuseColor', 'rgb'),
      node('C', 'float4 inputs:scale=(2,1,1,1) float4 inputs:bias=(0,0.1,0,0)'),
    );
    close(p.baseColorFactor, [1, 1, 1, 1], name);
    assert.deepEqual(sourceOf(asset, p.baseColorTexture).color, {
      scale: [2, 1, 1, 0],
      bias: [0, 0.1, 0, 1],
      srgb: true,
    });
  });

  test(`${name}: a raw colour map is read as linear, and a scale through an interface is followed`, async () => {
    const { asset, p } = await only(
      read('C', 'color3f', 'diffuseColor', 'rgb'),
      node('C', 'token inputs:sourceColorSpace="raw" float4 inputs:scale.connect=</Mat.inputs:gain>'),
    );
    close(p.baseColorFactor, [0.25, 0.5, 0.75, 1], name);
    assert.equal(sourceOf(asset, p.baseColorTexture).linearColor, true);
  });

  test(`${name}: emission maps scale into the factor and the strength, and a bias into the pixels`, async () => {
    const scaled = await only(read('E', 'color3f', 'emissiveColor', 'rgb'), node('E', 'float4 inputs:scale=(4,2,0,1)'));
    close(scaled.m.emissiveFactor, [1, 0.5, 0], name);
    assert.equal(scaled.m.extensions.KHR_materials_emissive_strength.emissiveStrength, 4);
    const lifted = await only(
      read('E', 'color3f', 'emissiveColor', 'rgb'),
      node('E', 'float4 inputs:scale=(2,1,1,1) float4 inputs:bias=(1,0,0,0)'),
    );
    close(lifted.m.emissiveFactor, [1, 1, 1], name);
    assert.equal(lifted.m.extensions.KHR_materials_emissive_strength.emissiveStrength, 3);
    const source = sourceOf(lifted.asset, lifted.m.emissiveTexture);
    close(source.color.scale, [2 / 3, 1 / 3, 1 / 3, 0], name);
    close(source.color.bias, [1 / 3, 0, 0, 1], name);
  });

  test(`${name}: roughness with a bias is remapped, and metalness keeps its scale as the factor`, async () => {
    const { asset, p } = await only(
      read('R', 'float', 'roughness', 'r') + ' ' + read('T', 'float', 'metallic', 'g'),
      node('R', 'float4 inputs:scale=(0.5,1,1,1) float4 inputs:bias=(0.25,0,0,0)') +
        ' ' +
        node('T', 'float4 inputs:scale=(1,0.3,1,1)'),
    );
    close([p.roughnessFactor, p.metallicFactor], [1, 0.3], name);
    const packed = sourceOf(asset, p.metallicRoughnessTexture);
    assert.deepEqual(packed.roughness, { path: 'map.png', channel: 0 });
    assert.deepEqual(packed.roughnessRemap, { scale: 0.5, bias: 0.25, srgb: false });
    assert.equal(packed.metallicRemap, undefined);
    assert.deepEqual(packed.metallic, { path: 'map.png', channel: 1 });
  });

  test(`${name}: occlusion from another channel moves to red, and a flipped normal map is rewritten`, async () => {
    const { asset, m } = await only(
      read('O', 'float', 'occlusion', 'g') + ' ' + read('N', 'normal3f', 'normal', 'rgb'),
      node('O') + ' ' + node('N', 'float4 inputs:scale=(2,-2,2,1) float4 inputs:bias=(-1,1,-1,0)'),
    );
    assert.deepEqual(sourceOf(asset, m.occlusionTexture).scalar, { channel: 1, scale: 1, bias: 0, srgb: false });
    assert.equal(m.occlusionTexture.strength, undefined);
    assert.deepEqual(sourceOf(asset, m.normalTexture).normal, { scale: [2, -2, 2], bias: [-1, 1, -1], srgb: false });
    assert.equal(m.normalTexture.scale, undefined);
  });

  test(`${name}: a normal map that states no scale or bias is read as it is`, async () => {
    const { asset, m } = await only(read('N', 'normal3f', 'normal', 'rgb'), node('N'));
    assert.deepEqual(sourceOf(asset, m.normalTexture), { path: 'map.png' });
    assert.equal(m.normalTexture.scale, undefined);
  });
}

test('a primvar reader on emission or occlusion still opens a single layer without previewSurface()', () => {
  const text = `#usda 1.0
def Mesh "M" { uniform token subdivisionScheme="none" rel material:binding=</Mat> int[] faceVertexCounts=[3] int[] faceVertexIndices=[0,1,2] point3f[] points=[(0,0,0),(1,0,0),(0,1,0)] }
def Material "Mat" { token outputs:surface.connect=</Mat/S.outputs:surface>
 def Shader "S" { uniform token info:id="UsdPreviewSurface" color3f inputs:emissiveColor.connect=</Mat/P.outputs:result> float inputs:occlusion.connect=</Mat/Q.outputs:result> }
 def Shader "P" { uniform token info:id="UsdPrimvarReader_float3" string inputs:varname="glow" }
 def Shader "Q" { uniform token info:id="UsdPrimvarReader_float" string inputs:varname="shade" }
}`;
  const m = parseUSDA(text).document.materials[0];
  assert.equal(m.emissiveFactor, undefined);
  assert.equal(m.occlusionTexture, undefined);
});

test('the model gets the converted pixels', async () => {
  // Node has no image decoder or canvas: stand-ins that pass the raw bytes of one pixel through.
  const saved = [globalThis.createImageBitmap, globalThis.OffscreenCanvas],
    pixel = [128, 64, 32, 200],
    copy = (data) => Uint8ClampedArray.from(data);
  // A file decodes to `pixel`; pixels and a canvas give a bitmap of what they hold.
  globalThis.createImageBitmap = async (from) => ({
    width: 1,
    height: 1,
    data: copy(from.data ?? pixel),
    close() {},
  });
  globalThis.OffscreenCanvas = class {
    data = new Uint8ClampedArray(4);
    getContext() {
      return {
        drawImage: (image) => (this.data = copy(image.data)),
        clearRect: () => (this.data = new Uint8ClampedArray(4)),
        getImageData: () => ({ data: copy(this.data) }),
        createImageData: () => ({ data: new Uint8ClampedArray(4) }),
        putImageData: (image) => (this.data = copy(image.data)),
      };
    }
  };
  try {
    const asset = await parseUSDZ(
      stage(
        [
          read('C', 'color3f', 'diffuseColor', 'rgb'),
          read('R', 'float', 'roughness', 'r'),
          read('N', 'normal3f', 'normal', 'rgb'),
          read('O', 'float', 'occlusion', 'g'),
        ].join(' '),
        [
          node('C', 'float4 inputs:bias=(0.1,0,0,0)'),
          node('R', 'float4 inputs:bias=(0.25,0,0,0)'),
          node('N', 'float4 inputs:scale=(2,-2,2,1) float4 inputs:bias=(-1,1,-1,0)'),
          node('O'),
        ].join(' '),
      ),
    );
    const images = await asset.images(),
      m = asset.document.materials[0],
      p = m.pbrMetallicRoughness,
      of = (info) => Array.from(images[asset.document.textures[info.index].source].data);
    const red = Math.round(255 * LinearToSRGB(SRGBToLinear(128 / 255) + 0.1));
    // Alpha is not read from this texture, so it is opaque.
    assert.deepEqual(of(p.baseColorTexture), [red, 64, 32, 255]);
    assert.equal(of(p.metallicRoughnessTexture)[1], Math.round(255 * (128 / 255 + 0.25)));
    assert.deepEqual(of(m.normalTexture), [128, 191, 32, 200]);
    assert.deepEqual(of(m.occlusionTexture), [64, 64, 0, 255]);
  } finally {
    [globalThis.createImageBitmap, globalThis.OffscreenCanvas] = saved;
  }
});
