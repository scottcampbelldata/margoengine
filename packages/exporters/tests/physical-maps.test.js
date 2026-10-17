// Constructed physical maps export through their live Material owner, including rows outside the native UV frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { Material, Texture, createMesh, createInstancedMesh } from '@margoengine/materials';
import { parseGLTF, parseGLTFAsync } from '@margoengine/gltf-pro';
import { extendedMaterials } from '@margoengine/gltf-pro/extended';
import { instancing } from '@margoengine/gltf-pro/instancing';
import { exportModel } from '../dist/model.js';
import { headless, headlessModels } from '../../../tests/support/pbr-snapshot.js';
import { accessor, readGLB, validate, validator } from './helpers.js';

const quad = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  uvs: Array(8).fill(0),
  uvs1: Array(8).fill(0),
  tangents: [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
};
// The slot, extension and field are independent expectations for the exported glTF schema.
const maps = [
  [5, 'clearcoatMap', 'clearcoat', 'clearcoatTexture'],
  [6, 'clearcoatRoughnessMap', 'clearcoat', 'clearcoatRoughnessTexture'],
  [7, 'clearcoatNormalMap', 'clearcoat', 'clearcoatNormalTexture'],
  [8, 'transmissionMap', 'transmission', 'transmissionTexture'],
  [9, 'sheenColorMap', 'sheen', 'sheenColorTexture'],
  [10, 'sheenRoughnessMap', 'sheen', 'sheenRoughnessTexture'],
  [11, 'specularIntensityMap', 'specular', 'specularTexture'],
  [12, 'specularColorMap', 'specular', 'specularColorTexture'],
  [13, 'iridescenceMap', 'iridescence', 'iridescenceTexture'],
  [14, 'iridescenceThicknessMap', 'iridescence', 'iridescenceThicknessTexture'],
  [15, 'anisotropyMap', 'anisotropy', 'anisotropyTexture'],
  [16, 'thicknessMap', 'volume', 'thicknessTexture'],
];
const pixel = (rgba) => new Texture({ width: 1, height: 1, data: Uint8Array.from(rgba) });
const rgba = (slot) => [slot * 11, 240 - slot * 7, slot * 13, 255 - slot * 3];
const near = (a, b, label) => {
  assert.equal(a.length, b.length, label);
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-6, `${label}[${i}]: ${v} vs ${b[i]}`));
};

function imagePixel(model, textureIndex) {
  const image = model.asset.doc.images[model.asset.doc.textures[textureIndex].source],
    png = model.asset.view(image.bufferView),
    view = new DataView(png.buffer, png.byteOffset),
    chunks = [];
  for (let at = 8; at < png.length; ) {
    const length = view.getUint32(at);
    if (new TextDecoder().decode(png.subarray(at + 4, at + 8)) === 'IDAT')
      chunks.push(png.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  return [...inflateSync(Buffer.concat(chunks)).subarray(1, 5)];
}
async function valid(bytes) {
  if (!validator) return;
  const report = await validate(bytes);
  assert.equal(report.errors, 0, JSON.stringify(report.messages));
  assert.equal(report.warnings, 0, JSON.stringify(report.messages));
}

// A prepared Material-like owner isolates exporter support from the constructor/shader implementation.
async function physicalModel(instanced = false) {
  const native = new Material({
      clearcoat: 0.6,
      clearcoatRoughness: 0.2,
      transmission: 0.7,
      thickness: 0.3,
      attenuationColor: [0.2, 0.4, 0.6],
      attenuationDistance: 2,
      sheenColor: [0.1, 0.2, 0.3],
      sheenRoughness: 0.4,
      specularIntensity: 0.8,
      specularColor: [0.9, 0.8, 0.7],
    }),
    engine = await headless(),
    source = instanced ? createInstancedMesh(engine, quad, native, 2) : createMesh(engine, quad, native),
    m = { ...source.primitives[0].material },
    owner = {
      shading: 'standard',
      uvt: Array.from({ length: 17 }, () => [1, 0, 0, 0, 0, 1, 0, 0]).flat(),
      thickness: 0.8,
      attenuationColor: [0.25, 0.5, 0.75],
      attenuationDistance: 5,
    };
  source.primitives[0].material = m;
  m.physical = [...native.physical, 0.65, 1.45, 120, 480, 0.55, Math.cos(0.35), Math.sin(0.35), 0, 0, 1, 1, 1];
  m.physical[2] = 0.45;
  m.extended = { iridescence: true, anisotropy: true, diffuseTransmission: false };
  m.extensions.KHR_materials_iridescence = {};
  m.extensions.KHR_materials_anisotropy = {};
  // Native physical frames may trim UV rows at slot 12; higher owner rows remain authoritative for export.
  m.uvt = Array.from({ length: 13 }, () => [1, 0, 0, 0, 0, 1, 0, 0]).flat();
  for (const [slot, name] of maps) {
    owner[name] = pixel(rgba(slot));
    owner.uvt.splice(
      slot * 8,
      8,
      2 * Math.cos(0.3),
      0.5 * Math.sin(0.3),
      0.125,
      slot === 16 ? 1 : 0,
      -2 * Math.sin(0.3),
      0.5 * Math.cos(0.3),
      0.25,
      0,
    );
  }
  return { source: { ...source, material: owner }, owner };
}

test('exportModel writes all physical owner maps with their channel pixels, UV sets and live affine rows', () =>
  headlessModels(async () => {
    const { source, owner } = await physicalModel(),
      bytes = await exportModel(source, { binary: true }),
      { json, bin } = readGLB(bytes),
      extension = json.materials[0].extensions,
      attrs = json.meshes[0].primitives[0].attributes,
      copy = await parseGLTFAsync(await headless(), bytes, { decoders: { materials: extendedMaterials } });
    assert.equal(json.textures?.length, 12, 'all physical Texture objects are serialized');
    assert.equal(json.images?.length, 12);
    assert.equal(json.samplers.length, 1, 'identical samplers share one definition');
    for (const [slot, name, family, field] of maps) {
      const info = extension[`KHR_materials_${family}`][field];
      assert.ok(info, `${name} glTF texture reference`);
      assert.equal(info.texCoord ?? 0, slot === 16 ? 1 : 0, `${name} UV set`);
      near(info.extensions.KHR_texture_transform.offset, [0.125, 0.25], `${name} offset`);
      near(info.extensions.KHR_texture_transform.scale, [2, 0.5], `${name} scale`);
      assert.ok(Math.abs(info.extensions.KHR_texture_transform.rotation - 0.3) < 1e-6);
      assert.deepEqual(imagePixel(copy, info.index), rgba(slot), `${name} encoded RGBA channels`);
      if (slot < 16)
        near(
          copy.primitives[0].material.uvt.slice(slot * 8, slot * 8 + 8),
          owner.uvt.slice(slot * 8, slot * 8 + 8),
          name,
        );
    }
    assert.deepEqual([...accessor(json, bin, attrs.TEXCOORD_0)], Array(8).fill(0));
    assert.deepEqual([...accessor(json, bin, attrs.TEXCOORD_1)], Array(8).fill(0));
    assert.equal(extension.KHR_materials_clearcoat.clearcoatNormalTexture.scale, 0.45);
    assert.deepEqual(extension.KHR_materials_iridescence.iridescenceFactor, 0.65);
    assert.equal(extension.KHR_materials_iridescence.iridescenceIor, 1.45);
    assert.equal(extension.KHR_materials_iridescence.iridescenceThicknessMinimum, 120);
    assert.equal(extension.KHR_materials_iridescence.iridescenceThicknessMaximum, 480);
    assert.equal(extension.KHR_materials_anisotropy.anisotropyStrength, 0.55);
    assert.ok(Math.abs(extension.KHR_materials_anisotropy.anisotropyRotation - 0.35) < 1e-6);
    await valid(bytes);
    owner.iridescenceMap = pixel([17, 39, 83, 121]);
    owner.uvt[13 * 8 + 2] = 0.625;
    const changed = await exportModel(source, { binary: true }),
      loaded = await parseGLTFAsync(await headless(), changed, { decoders: { materials: extendedMaterials } }),
      info = loaded.asset.doc.materials[0].extensions.KHR_materials_iridescence.iridescenceTexture;
    assert.deepEqual(imagePixel(loaded, info.index), [17, 39, 83, 121]);
    assert.equal(info.extensions.KHR_texture_transform.offset[0], 0.625);
  }));

test('exportModel writes live physical owner volume values rather than packed per-unit attenuation', () =>
  headlessModels(async () => {
    const { source, owner } = await physicalModel();
    const first = (await exportModel(source)).json.materials[0].extensions.KHR_materials_volume;
    assert.equal(first.thicknessFactor, 0.8);
    assert.deepEqual(first.attenuationColor, [0.25, 0.5, 0.75]);
    assert.equal(first.attenuationDistance, 5);
    owner.thickness = 1.25;
    owner.attenuationColor = [0.6, 0.7, 0.8];
    owner.attenuationDistance = Infinity;
    const next = (await exportModel(source)).json.materials[0].extensions.KHR_materials_volume;
    assert.equal(next.thicknessFactor, 1.25);
    assert.deepEqual(next.attenuationColor, [0.6, 0.7, 0.8]);
    assert.equal(next.attenuationDistance, undefined, 'glTF Infinity is expressed by omitting its default');
  }));

test('exportModel retains physical owners across grouped instances and deduplicates shared Texture identity', () =>
  headlessModels(async () => {
    const { source: a, owner: first } = await physicalModel(true),
      { source: b, owner: second } = await physicalModel(),
      p = a.primitives[0],
      q = b.primitives[0];
    for (const [, name] of maps) {
      first[name] = null;
      second[name] = null;
    }
    const shared = pixel([71, 129, 193, 251]);
    first.clearcoatMap = shared;
    first.specularColorMap = shared;
    second.clearcoatMap = pixel([13, 27, 51, 255]);
    a.asset.doc.meshes[0].primitives = [{ material: 1 }, { material: 0 }, { material: 1 }];
    const source = {
        ...a,
        material: [first, second],
        primitives: [
          {
            ...q,
            node: p.node,
            nodeIndex: 0,
            instances: p.instances,
            definition: { material: 1 },
            indices: new Uint32Array([0, 1, 2]),
          },
          { ...p, definition: { material: 0 }, indices: new Uint32Array([0, 2, 3]) },
          {
            ...q,
            node: p.node,
            nodeIndex: 0,
            instances: p.instances,
            definition: { material: 1 },
            indices: new Uint32Array([0, 1, 2]),
          },
        ],
      },
      bytes = await exportModel(source, { binary: true }),
      { json } = readGLB(bytes),
      copy = await parseGLTFAsync(await headless(), bytes, { decoders: { instancing, materials: extendedMaterials } });
    assert.deepEqual(
      json.meshes[0].primitives.map((v) => v.material),
      [0, 1, 0],
    );
    assert.equal(json.materials.length, 2);
    assert.equal(json.textures?.length, 2, 'each physical owner exports its textures');
    const extension = json.materials[1].extensions;
    assert.equal(
      extension.KHR_materials_clearcoat.clearcoatTexture.index,
      extension.KHR_materials_specular.specularColorTexture.index,
    );
    assert.deepEqual(
      imagePixel(copy, json.materials[0].extensions.KHR_materials_clearcoat.clearcoatTexture.index),
      [13, 27, 51, 255],
    );
    assert.deepEqual(imagePixel(copy, extension.KHR_materials_clearcoat.clearcoatTexture.index), [71, 129, 193, 251]);
    assert.equal(copy.primitives[0].instances.count, 2);
    await valid(bytes);
  }));

test('exportModel keeps loaded thickness metadata separate from native diffuse-transmission slot 16', () =>
  headlessModels(async () => {
    const { source } = await physicalModel(),
      fixture = await exportModel(source, { embed: false }),
      material = fixture.json.materials[0],
      iridescence = material.extensions.KHR_materials_iridescence,
      volume = material.extensions.KHR_materials_volume;
    material.extensions.KHR_materials_diffuse_transmission = {
      diffuseTransmissionFactor: 0.35,
      diffuseTransmissionTexture: { index: iridescence.iridescenceTexture.index, texCoord: 1 },
    };
    fixture.json.extensionsUsed.push('KHR_materials_diffuse_transmission');
    const loaded = parseGLTF(
        await headless(),
        fixture.json,
        [fixture.bin.buffer],
        fixture.json.images.map(() => ({ width: 1, height: 1 })),
        { materials: extendedMaterials },
      ),
      m = loaded.primitives[0].material;
    assert.equal(
      m.maps[16].index,
      iridescence.iridescenceTexture.index,
      'loaded slot 16 belongs to diffuse transmission',
    );
    m.physical[12] = 0.2;
    m.physical[16] = 0.3;
    m.uvt[13 * 8 + 2] = 0.75;
    const bytes = await exportModel(loaded, { binary: true }),
      { json } = readGLB(bytes),
      extension = json.materials[0].extensions,
      copy = await parseGLTFAsync(await headless(), bytes, { decoders: { materials: extendedMaterials } });
    assert.ok(extension.KHR_materials_volume.thicknessTexture, 'loaded thickness map is retained');
    assert.deepEqual(imagePixel(copy, extension.KHR_materials_volume.thicknessTexture.index), rgba(16));
    assert.deepEqual(extension.KHR_materials_volume.thicknessTexture.extensions, volume.thicknessTexture.extensions);
    assert.equal(extension.KHR_materials_iridescence.iridescenceFactor, 0.2);
    assert.equal(extension.KHR_materials_anisotropy.anisotropyStrength, 0.3);
    assert.equal(
      extension.KHR_materials_iridescence.iridescenceTexture.extensions.KHR_texture_transform.offset[0],
      0.75,
    );
    await valid(bytes);
  }));

test('exportModel roundtrips all physical maps and live controls from a real Material constructor', () =>
  headlessModels(async () => {
    const material = new Material({
        ...Object.fromEntries(maps.map(([slot, name]) => [name, pixel(rgba(slot))])),
        clearcoat: 0.6,
        clearcoatRoughness: 0.2,
        clearcoatNormalScale: 0.45,
        transmission: 0.7,
        thickness: 0.8,
        attenuationColor: [0.25, 0.5, 0.75],
        attenuationDistance: 5,
        sheenColor: [0.1, 0.2, 0.3],
        sheenRoughness: 0.4,
        specularIntensity: 0.8,
        specularColor: [0.9, 0.8, 0.7],
        iridescence: 0.65,
        iridescenceIOR: 1.45,
        iridescenceThicknessRange: [120, 480],
        anisotropy: 0.55,
        anisotropyRotation: 0.35,
        uvTransform: { texCoord: 1, offset: [0.125, 0.25], scale: [2, 0.5], rotation: 0.3 },
      }),
      source = createMesh(await headless(), quad, material),
      bytes = await exportModel(source, { binary: true }),
      { json } = readGLB(bytes),
      extension = json.materials[0].extensions,
      copy = await parseGLTFAsync(await headless(), bytes, { decoders: { materials: extendedMaterials } });
    assert.equal(json.textures?.length, 12, 'constructor physical maps are exported');
    for (const [slot, name, family, field] of maps) {
      const info = extension[`KHR_materials_${family}`][field];
      assert.equal(info.texCoord, 1, `${name} live coordinate selection`);
      near(info.extensions.KHR_texture_transform.offset, [0.125, 0.25], `${name} live transform`);
      assert.deepEqual(imagePixel(copy, info.index), rgba(slot), `${name} encoded channels`);
    }
    assert.equal(extension.KHR_materials_clearcoat.clearcoatNormalTexture.scale, 0.45);
    assert.equal(extension.KHR_materials_iridescence.iridescenceIor, 1.45);
    assert.equal(extension.KHR_materials_iridescence.iridescenceThicknessMinimum, 120);
    assert.equal(extension.KHR_materials_iridescence.iridescenceThicknessMaximum, 480);
    assert.ok(Math.abs(extension.KHR_materials_anisotropy.anisotropyRotation - 0.35) < 1e-6);
    assert.equal(extension.KHR_materials_volume.thicknessFactor, 0.8);
    assert.deepEqual(extension.KHR_materials_volume.attenuationColor, [0.25, 0.5, 0.75]);
    assert.equal(extension.KHR_materials_volume.attenuationDistance, 5);
    await valid(bytes);
    material.anisotropy = 0.25;
    material.anisotropyRotation = 8.2;
    material.iridescence = 0.35;
    material.iridescenceThicknessRange = [150, 600];
    material.setUVTransform({ texCoord: 0, offset: [0.75, 0.875] }, 'thicknessMap');
    const changed = (await exportModel(source)).json.materials[0].extensions;
    assert.equal(changed.KHR_materials_anisotropy.anisotropyStrength, 0.25);
    assert.equal(
      changed.KHR_materials_anisotropy.anisotropyRotation,
      8.2,
      'live public rotations retain complete turns',
    );
    assert.equal(changed.KHR_materials_iridescence.iridescenceFactor, 0.35);
    assert.equal(changed.KHR_materials_iridescence.iridescenceThicknessMinimum, 150);
    assert.equal(changed.KHR_materials_iridescence.iridescenceThicknessMaximum, 600);
    assert.equal(changed.KHR_materials_volume.thicknessTexture.texCoord ?? 0, 0);
    assert.deepEqual(
      changed.KHR_materials_volume.thicknessTexture.extensions.KHR_texture_transform.offset,
      [0.75, 0.875],
    );
  }));

test('exportModel includes a physical map assigned before the first draw with its global UV defaults', () =>
  headlessModels(async () => {
    const material = new Material({ clearcoat: 1, uvTransform: { texCoord: 1, offset: [0.25, 0.5] } }),
      texture = pixel([41, 83, 167, 251]);
    material.sheenColor = [0.25, 0.5, 0.75];
    material.sheenColorMap = texture;
    material.specularColorMap = texture;
    const source = createMesh(await headless(), quad, material),
      bytes = await exportModel(source, { binary: true }),
      { json } = readGLB(bytes),
      extension = json.materials[0].extensions,
      sheen = extension.KHR_materials_sheen,
      specular = extension.KHR_materials_specular;
    assert.ok(
      sheen?.sheenColorTexture,
      'live map selects its extension even when the constructor did not name that family',
    );
    assert.deepEqual(sheen.sheenColorFactor, [0.25, 0.5, 0.75]);
    assert.equal(sheen.sheenColorTexture.texCoord, 1);
    assert.deepEqual(sheen.sheenColorTexture.extensions.KHR_texture_transform, { offset: [0.25, 0.5], scale: [1, 1] });
    assert.equal(specular.specularColorTexture.index, sheen.sheenColorTexture.index);
    assert.equal(json.textures.length, 1, 'late maps keep Texture identity deduplication');
    assert.notEqual(json.meshes[0].primitives[0].attributes.TEXCOORD_1, undefined, 'late all-zero UV1 remains present');
    await valid(bytes);
  }));

test('exportModel retains live volume edits on a material constructed with only a transmission map', () =>
  headlessModels(async () => {
    const material = new Material({ transmissionMap: pixel([51, 109, 173, 239]) }),
      source = createMesh(await headless(), quad, material);
    material.transmission = 0.7;
    material.thickness = 0.8;
    material.attenuationColor = [0.25, 0.5, 0.75];
    material.attenuationDistance = 5;
    const bytes = await exportModel(source, { binary: true }),
      { json } = readGLB(bytes),
      volume = json.materials[0].extensions.KHR_materials_volume,
      copy = await parseGLTFAsync(await headless(), bytes, { decoders: { materials: extendedMaterials } });
    assert.ok(volume, 'reserved transmission capability retains live volume values');
    assert.deepEqual(volume, { thicknessFactor: 0.8, attenuationDistance: 5, attenuationColor: [0.25, 0.5, 0.75] });
    assert.equal(copy.primitives[0].material.volume[0], 0.8);
    near(
      copy.primitives[0].material.volume.slice(1),
      [0.7578582833, 0.8705505633, 0.9440875113],
      'per-unit attenuation',
    );
    await valid(bytes);
  }));

for (const { family, options, map, values, expected } of [
  {
    family: 'clearcoat',
    options: { sheenRoughness: 0.4 },
    map: 'clearcoatMap',
    values: { clearcoat: 0.7, clearcoatRoughness: 0.2, clearcoatNormalScale: 0.45 },
    expected: { clearcoatFactor: 0.7, clearcoatRoughnessFactor: 0.2 },
  },
  {
    family: 'sheen',
    options: { clearcoat: 1 },
    map: 'sheenColorMap',
    values: { sheenColor: [0.25, 0.5, 0.75], sheenRoughness: 0.3 },
    expected: { sheenColorFactor: [0.25, 0.5, 0.75], sheenRoughnessFactor: 0.3 },
  },
  {
    family: 'specular',
    options: { clearcoat: 1 },
    map: 'specularColorMap',
    values: { specularColor: [0.25, 0.5, 0.75], specularIntensity: 0.6 },
    expected: { specularFactor: 0.6, specularColorFactor: [0.25, 0.5, 0.75] },
  },
])
  test(`exportModel retains live ${family} factors after a late physical map is cleared`, () =>
    headlessModels(async () => {
      const material = new Material(options),
        source = createMesh(await headless(), quad, material);
      material[map] = pixel([37, 79, 157, 251]);
      Object.assign(material, values);
      material[map] = null;
      const bytes = await exportModel(source, { binary: true }),
        { json } = readGLB(bytes),
        extension = json.materials[0].extensions[`KHR_materials_${family}`];
      assert.deepEqual(extension, expected, 'clearing a texture preserves the remaining live physical lobe');
      assert.equal(json.textures, undefined, 'cleared Texture is omitted');
      await valid(bytes);
    }));
