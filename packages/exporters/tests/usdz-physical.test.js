// KHR_materials_clearcoat and KHR_materials_ior in USDZ. Expected values come from the two glTF extensions (defaults
// 0, 0 and 1.5; coat from red, its roughness from green) and from UsdPreviewSurface (clearcoat 0, clearcoatRoughness
// 0.01, ior 1.5).
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportUSDZ } from '../dist/usdz.js';
import { exportMaterialGLB } from '../dist/materials.js';
import { storedZIP } from '../dist/usdz-write.js';
import { readZipDirectory, readZipEntry } from '@margoengine/loaders';
import { parseUSDZ as readUSD } from '@margoengine/usdz';
import { previewSurface } from '@margoengine/usdz/preview-surface';

const quad = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
  uvs1: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};
const png = (seed) => ({
  image: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed, seed + 1, seed + 2]),
  mimeType: 'image/png',
  name: `map${seed}`,
});
const scene = (material) => ({ nodes: [{ geometry: quad, material }] });
const usda = async (archive) => new TextDecoder().decode(await readZipEntry(archive, readZipDirectory(archive)[0]));
const surfaceOf = (source) => {
  const start = source.indexOf('def Shader "Surface"');
  return source.slice(start, source.indexOf('\n    }', start));
};
const shader = (source, name) => {
  const start = source.indexOf(`def Shader "${name}"`);
  assert.ok(start >= 0, `shader ${name}`);
  return source.slice(start, source.indexOf('\n    }', start));
};
const readers = [
  ['the default importer', {}],
  ['previewSurface()', { extensions: [previewSurface()] }],
];
const coated = {
  roughness: 0.4,
  extensions: {
    KHR_materials_clearcoat: { clearcoatFactor: 0.75, clearcoatRoughnessFactor: 0.25 },
    KHR_materials_ior: { ior: 1.76 },
  },
};

test('USDZ writes clearcoat and ior, and both USD importers read them back', async () => {
  const archive = exportUSDZ(scene(coated)),
    surface = surfaceOf(await usda(archive));
  assert.match(surface, /float inputs:clearcoat = 0\.75\n/);
  assert.match(surface, /float inputs:clearcoatRoughness = 0\.25\n/);
  assert.match(surface, /float inputs:ior = 1\.76\n/);
  for (const [name, options] of readers) {
    const { document } = await readUSD(archive, options),
      [material] = document.materials;
    assert.deepEqual(
      material.extensions,
      {
        KHR_materials_clearcoat: { clearcoatFactor: 0.75, clearcoatRoughnessFactor: 0.25 },
        KHR_materials_ior: { ior: 1.76 },
      },
      name,
    );
    for (const used of ['KHR_materials_clearcoat', 'KHR_materials_ior'])
      assert.ok(document.extensionsUsed.includes(used), `${name}: ${used}`);
  }
});

test('USDZ takes clearcoat and ior from GLB bytes, and an ior from the material field', async () => {
  const glb = exportMaterialGLB(scene(coated)),
    surface = surfaceOf(await usda(exportUSDZ(glb)));
  assert.match(surface, /float inputs:clearcoat = 0\.75\n/);
  assert.match(surface, /float inputs:clearcoatRoughness = 0\.25\n/);
  assert.match(surface, /float inputs:ior = 1\.76\n/);
  assert.match(surfaceOf(await usda(exportUSDZ(scene({ ior: 2.4 })))), /float inputs:ior = 2\.4\n/);
});

test('a coat states its roughness, and no coat or the usual ior writes nothing', async () => {
  // glTF's coat roughness is 0 when absent; USD's fallback is 0.01, so it must be written.
  const smooth = { extensions: { KHR_materials_clearcoat: { clearcoatFactor: 1 } } };
  assert.match(surfaceOf(await usda(exportUSDZ(scene(smooth)))), /float inputs:clearcoatRoughness = 0\n/);
  for (const material of [
    {},
    { roughness: 0.5 },
    // A factor of 0 turns the whole layer off, whatever its other fields say (KHR_materials_clearcoat).
    {
      extensions: { KHR_materials_clearcoat: { clearcoatRoughnessFactor: 0.5, clearcoatTexture: { texture: png(1) } } },
    },
    { ior: 1.5 },
  ]) {
    const archive = exportUSDZ(scene(material));
    assert.doesNotMatch(await usda(archive), /inputs:clearcoat|inputs:ior/);
    assert.equal(readZipDirectory(archive).length, 1, 'no image for a layer that is off');
    assert.equal((await readUSD(archive)).document.materials[0].extensions, undefined);
  }
});

test('USDZ keeps the material of painted geometry whose coat or ior says more than the paint', async () => {
  const geometry = { ...quad, colors: new Float32Array(12).fill(0.5) };
  for (const material of [{ ior: 2 }, { extensions: { KHR_materials_clearcoat: { clearcoatFactor: 1 } } }]) {
    const source = await usda(exportUSDZ({ nodes: [{ geometry, material: { roughness: 1, ...material } }] }));
    assert.match(source, /material:binding/);
    assert.match(source, /inputs:(ior|clearcoat) =/);
  }
});

test('USDZ writes coat maps from red and green with their factors, UV sets and transforms, and reads them back', async () => {
  const mask = png(3),
    rough = png(5),
    archive = exportUSDZ(
      scene({
        extensions: {
          KHR_materials_clearcoat: {
            clearcoatFactor: 0.5,
            clearcoatRoughnessFactor: 0.75,
            clearcoatTexture: {
              texture: mask,
              extensions: { KHR_texture_transform: { scale: [2, 2] } },
            },
            clearcoatRoughnessTexture: { texture: rough },
          },
        },
      }),
    ),
    source = await usda(archive),
    surface = surfaceOf(source),
    m = '/Margo/Material_0';
  assert.match(surface, new RegExp(`float inputs:clearcoat.connect = <${m}/ClearcoatTexture.outputs:r>`));
  assert.match(
    surface,
    new RegExp(`float inputs:clearcoatRoughness.connect = <${m}/ClearcoatRoughnessTexture.outputs:g>`),
  );
  const coat = shader(source, 'ClearcoatTexture');
  assert.match(coat, /asset inputs:file = @textures\/map3\.png@/);
  assert.match(coat, /float4 inputs:scale = \(0\.5, 1, 1, 1\)/);
  assert.match(coat, /token inputs:sourceColorSpace = "raw"/);
  assert.match(coat, new RegExp(`float2 inputs:st.connect = <${m}/ClearcoatTransform.outputs:result>`));
  assert.match(shader(source, 'ClearcoatRoughnessTexture'), /float4 inputs:scale = \(1, 0\.75, 1, 1\)/);
  assert.match(source, /primvars:st = /);
  assert.deepEqual(
    readZipDirectory(archive).map((e) => e.name),
    ['scene.usda', 'textures/map3.png', 'textures/map5.png'],
  );
  for (const [name, options] of readers) {
    const model = await readUSD(archive, options),
      layer = model.document.materials[0].extensions.KHR_materials_clearcoat;
    assert.equal(layer.clearcoatFactor, 0.5, name);
    assert.equal(layer.clearcoatRoughnessFactor, 0.75, name);
    const files = [layer.clearcoatTexture, layer.clearcoatRoughnessTexture].map(
      (info) => model.sources[model.document.textures[info.index].source],
    );
    assert.deepEqual(files, [{ path: 'textures/map3.png' }, { path: 'textures/map5.png' }], name);
    assert.deepEqual(layer.clearcoatTexture.extensions.KHR_texture_transform.scale, [2, 2], name);
  }
});

test('a coat map on the second UV set writes st1, from texCoord or the transform', async () => {
  for (const info of [{ texCoord: 1 }, { extensions: { KHR_texture_transform: { texCoord: 1 } } }]) {
    const source = await usda(
      exportUSDZ(
        scene({
          extensions: {
            KHR_materials_clearcoat: { clearcoatFactor: 1, clearcoatTexture: { texture: png(1), ...info } },
          },
        }),
      ),
    );
    assert.match(source, /primvars:st1 = /);
    assert.match(source, /string inputs:varname = "st1"/);
  }
});

test('an importer converts a coat map read from another channel', async () => {
  const map = png(1),
    archive = exportUSDZ(
      scene({
        extensions: {
          KHR_materials_clearcoat: {
            clearcoatFactor: 1,
            clearcoatTexture: { texture: map },
            clearcoatRoughnessTexture: { texture: map },
          },
        },
      }),
    );
  // The same file, with the roughness taken from red, as a grey roughness map is often wired.
  const [entry] = readZipDirectory(archive),
    text = new TextDecoder()
      .decode(await readZipEntry(archive, entry))
      .replace('ClearcoatRoughnessTexture.outputs:g>', 'ClearcoatRoughnessTexture.outputs:r>');
  const rewired = storedZIP([
    ['scene.usda', new TextEncoder().encode(text)],
    ['textures/map1.png', map.image],
  ]);
  for (const [name, options] of readers) {
    const model = await readUSD(rewired, options),
      layer = model.document.materials[0].extensions.KHR_materials_clearcoat,
      source = model.sources[model.document.textures[layer.clearcoatRoughnessTexture.index].source];
    assert.equal(layer.clearcoatRoughnessFactor, 1, name);
    assert.deepEqual(source.scalar, { channel: 0, scale: 1, bias: 0, srgb: false }, name);
  }
});

test('a coat normal map is reported, and bad payload values are refused', () => {
  const warnings = [];
  exportUSDZ(
    scene({
      name: 'car',
      extensions: {
        KHR_materials_clearcoat: { clearcoatFactor: 1, clearcoatNormalTexture: { texture: png(1) } },
      },
    }),
    { onWarning: (warning) => warnings.push(warning) },
  );
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'unsupported');
  assert.match(warnings[0].message, /car: clearcoatNormalTexture/);
  for (const extensions of [
    { KHR_materials_clearcoat: { clearcoatFactor: 2 } },
    { KHR_materials_clearcoat: { clearcoatFactor: 1, clearcoatRoughnessFactor: -1 } },
    { KHR_materials_ior: { ior: 0.5 } },
  ])
    assert.throws(() => exportUSDZ(scene({ extensions })), RangeError);
});

test('each importer keeps a coat map on its own texture coordinates', async () => {
  const archive = exportUSDZ(
    scene({
      baseColorTexture: png(1),
      extensions: {
        KHR_materials_clearcoat: { clearcoatFactor: 1, clearcoatTexture: { texture: png(3), texCoord: 1 } },
      },
    }),
  );
  for (const [name, options] of readers) {
    const [material] = (await readUSD(archive, options)).document.materials;
    assert.equal(material.pbrMetallicRoughness.baseColorTexture.texCoord ?? 0, 0, name);
    assert.equal(material.extensions.KHR_materials_clearcoat.clearcoatTexture.texCoord, 1, name);
  }
});
