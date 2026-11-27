// export3MF's package: compression, metadata, thumbnail, display properties, components, welded primitives and the mesh
// check, read back through `@margoengine/loaders`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse3MF, readZipDirectory, readZipEntry } from '@margoengine/loaders';
import { parse3MFMaterials } from '@margoengine/loaders/threemf-materials';
import { decodeImage } from '@margoengine/decoders/image';
import { export3MF } from '@margoengine/exporters/threemf';
import { exportMaterialGLB } from '@margoengine/exporters/materials';
import { png } from '../dist/png.js';

// A closed box of side 1 with its corner at the origin: 8 shared corners, faces outward.
const corners = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
const faces = [
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
];
const mesh = (indices = faces, extra = {}) => ({
  positions: new Float32Array(corners),
  normals: new Float32Array(corners.length),
  indices: new Uint32Array(indices),
  ...extra,
});
const part = async (file, name) => {
  const entry = readZipDirectory(file).find((e) => e.name === name);
  return entry && readZipEntry(file, entry);
};
const model = async (file) => new TextDecoder().decode(await part(file, '3D/3dmodel.model'));
const count = (text, pattern) => (text.match(pattern) ?? []).length;
/** The compression method of each local file header. */
const methods = (file) => {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength),
    out = {};
  for (let at = 0; view.getUint32(at, true) === 0x04034b50; ) {
    const size = view.getUint32(at + 18, true),
      length = view.getUint16(at + 26, true);
    out[new TextDecoder().decode(file.subarray(at + 30, at + 30 + length))] = view.getUint16(at + 8, true);
    at += 30 + length + size;
  }
  return out;
};
const reports = async (nodes, options = {}) => {
  const out = [];
  await export3MF({ nodes }, { ...options, onMeshCheck: (report) => out.push(report) });
  return out;
};

test('the package is deflated and reads back as the stored one does, the same bytes each time', async () => {
  const source = { nodes: [{ geometry: mesh() }] },
    packed = await export3MF(source),
    stored = await export3MF(source, { compress: false });
  assert.equal(methods(packed)['3D/3dmodel.model'], 8);
  assert.deepEqual([...new Set(Object.values(methods(stored)))], [0]);
  assert.ok(packed.length < stored.length, `${packed.length} < ${stored.length}`);
  assert.equal(await model(packed), await model(stored));
  assert.deepEqual([...(await export3MF(source))], [...packed]);
  assert.equal((await parse3MF(packed, { units: 'file' })).indices.length, 36);
});

test("metadata is written under the specification's names, vendor names in their own namespace", async () => {
  const file = await export3MF(
      { nodes: [{ geometry: mesh() }] },
      {
        title: 'Cube',
        metadata: {
          designer: 'A & B',
          licenseTerms: 'CC0',
          creationDate: '2026-11-27',
          custom: [{ namespace: 'https://example.com/print', name: 'Material', value: 'PLA', preserve: true }],
        },
      },
    ),
    text = await model(file),
    read = await parse3MF(file);
  assert.match(text, /xmlns:v1="https:\/\/example.com\/print"/);
  assert.match(text, /<metadata name="v1:Material" preserve="1">PLA<\/metadata>/);
  assert.equal(read.metadata.Title, 'Cube');
  assert.equal(read.metadata.Designer, 'A & B');
  assert.equal(read.metadata.LicenseTerms, 'CC0');
  assert.equal(read.metadata.CreationDate, '2026-11-27');
});

test('metadata the format would reject is refused', async () => {
  const source = { nodes: [{ geometry: mesh() }] },
    custom = (name, namespace = 'urn:a') => ({ custom: [{ namespace, name, value: 'x' }] });
  await assert.rejects(export3MF(source, { metadata: { author: 'x' } }), RangeError);
  await assert.rejects(export3MF(source, { metadata: { designer: 4 } }), TypeError);
  await assert.rejects(export3MF(source, { metadata: custom('a:b') }), RangeError);
  await assert.rejects(export3MF(source, { metadata: custom('a', '') }), RangeError);
  const twice = { custom: [...custom('a').custom, ...custom('a').custom] };
  await assert.rejects(export3MF(source, { metadata: twice }), RangeError);
});

test('a thumbnail is a package part with its relationship; other pictures are refused', async () => {
  const picture = await png({ width: 2, height: 2, data: new Uint8Array(16).fill(200) }, 2, false),
    source = { nodes: [{ geometry: mesh() }] },
    file = await export3MF(source, { thumbnail: picture }),
    rels = new TextDecoder().decode(await part(file, '_rels/.rels')),
    types = new TextDecoder().decode(await part(file, '[Content_Types].xml'));
  assert.deepEqual([...(await part(file, 'Metadata/thumbnail.png'))], [...picture]);
  assert.match(
    rels,
    /Target="\/Metadata\/thumbnail.png" Id="rel1" Type="http:\/\/schemas.openxmlformats.org\/package\/2006\/relationships\/metadata\/thumbnail"/,
  );
  assert.match(types, /Extension="png"/);
  // A JPEG's frame header says how many components it has: 3 passes, 4 (CMYK) is what the specification forbids.
  const jpeg = (components) =>
    Uint8Array.of(255, 216, 255, 224, 0, 4, 0, 0, 255, 255, 192, 0, 17, 8, 0, 1, 0, 1, components, 1, 17, 0, 255, 217);
  assert.ok(await part(await export3MF(source, { thumbnail: jpeg(3) }), 'Metadata/thumbnail.jpg'));
  await assert.rejects(export3MF(source, { thumbnail: jpeg(4) }), RangeError);
  await assert.rejects(export3MF(source, { thumbnail: Uint8Array.of(71, 73, 70) }), TypeError);
});

test('texture parts are declared as 3D textures, a thumbnail as the image it is', async () => {
  const image = await png({ width: 1, height: 1, data: new Uint8Array(4).fill(255) }, 1, false),
    geometry = mesh(faces, { uvs: new Float32Array(16) }),
    source = { nodes: [{ geometry, material: { baseColorTexture: { image, mimeType: 'image/png' } } }] },
    types = async (options) =>
      new TextDecoder().decode(await part(await export3MF(source, options), '[Content_Types].xml')),
    override =
      '<Override PartName="/3D/Textures/texture1.png" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodeltexture"/>';
  const bare = await types({});
  assert.ok(bare.includes(override), bare);
  assert.ok(!bare.includes('image/png'), 'no part is declared as a plain image without a thumbnail');
  const shown = await types({ thumbnail: image });
  assert.ok(shown.includes(override));
  assert.ok(shown.includes('<Default Extension="png" ContentType="image/png"/>'));
});

test('metalness and roughness are display properties, one entry for each base and colour', async () => {
  const colors = new Float32Array(corners.length).map((_, i) => (i % 5) / 4),
    file = await export3MF({
      nodes: [
        { geometry: mesh(), material: { name: 'Steel', color: [0.5, 0.5, 0.5], metalness: 1, roughness: 0.25 } },
        { translation: [2, 0, 0], geometry: mesh() },
        {
          translation: [4, 0, 0],
          geometry: mesh(faces, { colors, colorSize: 3 }),
          material: { name: 'Painted', roughness: 0.5 },
        },
      ],
    }),
    text = await model(file),
    [, baseDisplay] = text.match(/<basematerials id="1" displaypropertiesid="(\d+)">/),
    properties = (id) =>
      text.match(new RegExp(`<m:pbmetallicdisplayproperties id="${id}">(.*?)</m:pbmetallicdisplayproperties>`))[1];
  assert.equal(count(properties(baseDisplay), /<m:pbmetallic /g), count(text, /<base /g));
  assert.ok(
    properties(baseDisplay).startsWith(
      '<m:pbmetallic name="Steel" metallicness="1" roughness="0.25"/><m:pbmetallic name="Material" metallicness="0" roughness="1"/>',
    ),
  );
  assert.match(text, /<base name="Steel" displaycolor="#BCBCBC"\/>/);
  const [, group, display] = text.match(/<m:colorgroup id="(\d+)" displaypropertiesid="(\d+)">/),
    colours = text.match(new RegExp(`<m:colorgroup id="${group}"[^>]*>(.*?)</m:colorgroup>`))[1];
  assert.equal(
    count(properties(display), /<m:pbmetallic name="Painted" metallicness="0" roughness="0.5"\/>/g),
    count(colours, /<m:color /g),
  );
  // Every resource is defined before it is named (core specification section 3.4).
  assert.ok(text.indexOf(`<m:pbmetallicdisplayproperties id="${baseDisplay}"`) < text.indexOf('<basematerials'));
  assert.ok(text.indexOf(`<m:pbmetallicdisplayproperties id="${display}"`) < text.indexOf('<m:colorgroup'));
  assert.equal((await parse3MFMaterials(file)).indices.length, 108);
  const metal = { nodes: [{ geometry: mesh(), material: { metalness: 1 } }] };
  assert.ok(!(await model(await export3MF(metal, { displayProperties: false }))).includes('displayproperties'));
  assert.ok(!(await model(await export3MF({ nodes: [{ geometry: mesh() }] }))).includes('displayproperties'));
});

test('a metallic-roughness map moves roughness to red and metalness to green', async () => {
  const uvs = new Float32Array(16).fill(0.5),
    picture = (pixels) => png({ width: 2, height: 1, data: new Uint8Array(pixels) }, 2, false),
    base = { image: await picture([255, 0, 0, 255, 0, 255, 0, 255]), mimeType: 'image/png' },
    // glTF: roughness in green, metalness in blue.
    map = { image: await picture([9, 40, 200, 255, 9, 220, 10, 255]), mimeType: 'image/png' },
    material = { baseColorTexture: base, metallicRoughnessTexture: map, metalness: 0.75, roughness: 0.5 },
    file = await export3MF({
      nodes: [
        { geometry: mesh(faces, { uvs }), material },
        { translation: [2, 0, 0], geometry: mesh(faces, { uvs }), material: { baseColorTexture: base, metalness: 1 } },
      ],
    }),
    text = await model(file),
    properties = [...text.matchAll(/<m:pbmetallictexturedisplayproperties ([^>]*)\/>/g)].map(([, attributes]) =>
      Object.fromEntries([...attributes.matchAll(/(\w+)="([^"]*)"/g)].map(([, name, value]) => [name, value])),
    );
  assert.deepEqual(
    properties.map((p) => [p.name, p.metallicfactor, p.roughnessfactor]),
    [
      ['Material', '0.75', '0.5'],
      ['Material', '1', '1'],
    ],
  );
  for (const p of properties) {
    assert.equal(p.metallictextureid, p.roughnesstextureid, 'one image for both values');
    assert.ok(text.includes(`displaypropertiesid="${p.id}"`));
  }
  const imageOf = async (id) => {
    const [, path] = text.match(new RegExp(`<m:texture2d id="${id}" path="/([^"]+)" contenttype="image/png"/>`));
    return [...(await decodeImage(await part(file, path))).data];
  };
  assert.deepEqual(await imageOf(properties[0].metallictextureid), [40, 200, 0, 255, 220, 10, 0, 255]);
  assert.deepEqual(await imageOf(properties[1].metallictextureid), [255, 255, 255, 255], 'factors take a white map');
});

test('a metallic-roughness map on other coordinates is left out with a warning', async () => {
  const uvs = new Float32Array(16).fill(0.5),
    image = await png({ width: 1, height: 1, data: new Uint8Array([1, 2, 3, 255]) }, 1, false),
    warnings = [],
    material = {
      baseColorTexture: { image, mimeType: 'image/png' },
      metallicRoughnessTexture: { image, mimeType: 'image/png', wrapS: 'clamp' },
    },
    file = await export3MF(
      { nodes: [{ geometry: mesh(faces, { uvs }), material }] },
      { onWarning: (w) => warnings.push(w.code) },
    );
  assert.deepEqual(warnings, ['unsupported']);
  assert.ok(!(await model(file)).includes('pbmetallictexture'));
});

test("'components' stores a repeated part once and keeps one build item", async () => {
  const shared = mesh(),
    nodes = [0, 2, 4].map((x) => ({ translation: [x, 0, 0], geometry: shared })),
    file = await export3MF({ nodes }, { assembly: 'components', title: 'Row', upAxis: 'z', unit: 'meter' }),
    text = await model(file);
  assert.equal(count(text, /<mesh>/g), 1);
  assert.equal(count(text, /<component objectid="\d+" transform="[^"]+"\/>/g), 3);
  assert.equal(count(text, /<item /g), 1);
  // An object of components names no property.
  assert.match(text, /<object id="\d+" type="model" name="Row"><components>/);
  const read = await parse3MF(file, { units: 'file' }),
    xs = read.positions.filter((_, i) => i % 3 === 0);
  assert.equal(read.indices.length, 108);
  assert.deepEqual([Math.min(...xs), Math.max(...xs)], [0, 5]);
  const single = await model(await export3MF({ nodes: [nodes[0]] }, { assembly: 'components' }));
  assert.equal(count(single, /<component /g), 0);
  await assert.rejects(export3MF({ nodes }, { assembly: 'parts' }), RangeError);
});

test("a node's primitives are one mesh: a solid split between two materials stays closed", async () => {
  const geometry = mesh(),
    half = (from) => ({ ...geometry, indices: new Uint32Array(faces.slice(from, from + 18)) }),
    split = [
      {
        name: 'Two tone',
        primitives: [
          { geometry: half(0), material: { color: [1, 0, 0] } },
          { geometry: half(18), material: { color: [0, 0, 1] } },
        ],
      },
    ];
  for (const assembly of [true, false, 'components']) {
    assert.deepEqual(await reports(split, { assembly }), [
      { name: 'Two tone', openEdges: 0, nonManifoldEdges: 0, flippedEdges: 0, insideOut: false },
    ]);
    const text = await model(await export3MF({ nodes: split }, { assembly }));
    assert.equal(count(text, /<object /g), 1);
    assert.equal(count(text, /<vertex /g), 8);
    assert.equal(count(text, /<triangle [^>]*pid="1" p1="1"/g), 6, 'the second primitive keeps its material');
  }
  // Two primitives that are each solid and share a corner stay two shells.
  const moved = { ...geometry, positions: geometry.positions.map((v) => v + 1) },
    touching = [{ primitives: [{ geometry }, { geometry: moved }] }],
    [report] = await reports(touching);
  assert.equal(report.nonManifoldEdges + report.openEdges, 0);
  assert.equal(count(await model(await export3MF({ nodes: touching })), /<vertex /g), 16);
});

test('the mesh check counts holes, flipped and shared edges and a mesh turned inside out', async () => {
  const check = async (indices) => (await reports([{ geometry: mesh(indices) }]))[0],
    clean = { openEdges: 0, nonManifoldEdges: 0, flippedEdges: 0, insideOut: false };
  assert.deepEqual(await check(faces), clean);
  assert.deepEqual(await check(faces.slice(3)), { ...clean, openEdges: 3 });
  assert.deepEqual(await check([faces[0], faces[2], faces[1], ...faces.slice(3)]), { ...clean, flippedEdges: 3 });
  assert.deepEqual(await check([...faces, faces[0], faces[1], faces[2]]), { ...clean, nonManifoldEdges: 3 });
  const inward = faces.map((_, i) => faces[i - (i % 3) + [0, 2, 1][i % 3]]);
  assert.deepEqual(await check(inward), { ...clean, insideOut: true });
});

test('one image shared through many texture records is one part of the package', async () => {
  const uvs = new Float32Array(16).fill(0.5),
    image = await png({ width: 1, height: 1, data: new Uint8Array([1, 2, 3, 255]) }, 1, false),
    nodes = [0, 2, 4].map((x) => ({
      translation: [x, 0, 0],
      geometry: mesh(faces, { uvs }),
      material: {
        name: `Material ${x}`,
        metalness: 1,
        baseColorTexture: { image, mimeType: 'image/png' },
        metallicRoughnessTexture: { image, mimeType: 'image/png' },
      },
    })),
    file = await export3MF({ nodes }),
    parts = readZipDirectory(file).filter((e) => e.name.startsWith('3D/Textures/'));
  assert.equal(parts.length, 2, 'the base colour image and the display map made from it');
  assert.equal(count(await model(file), /<m:texture2d /g), 2);
  const clamped = { ...nodes[1], material: { baseColorTexture: { image, mimeType: 'image/png', wrapS: 'clamp' } } };
  assert.equal(count(await model(await export3MF({ nodes: [nodes[0], clamped] })), /<m:texture2d [^>]*tilestyleu/g), 2);
});

test('metalness, roughness and their map read back through parse3MFMaterials', async () => {
  const flat = await parse3MFMaterials(
    await export3MF({
      nodes: [
        { geometry: mesh(), material: { name: 'Steel', metalness: 1, roughness: 0.25 } },
        { geometry: mesh(), material: { name: 'Painted', color: [1, 0, 0, 1], metalness: 0, roughness: 0.5 } },
      ],
    }),
  );
  assert.deepEqual(
    flat.groups.map(({ metallic }) => [metallic.name, metallic.metalness, metallic.roughness]),
    [
      ['Steel', 1, 0.25],
      ['Painted', 0, 0.5],
    ],
  );
  const picture = async (data) => ({
    image: await png({ width: 2, height: 1, data: new Uint8Array(data) }, 2, false),
    mimeType: 'image/png',
  });
  const material = {
    baseColorTexture: await picture([255, 255, 255, 255, 255, 255, 255, 255]),
    // glTF layout: roughness in green, metalness in blue.
    metallicRoughnessTexture: await picture([0, 40, 200, 255, 0, 220, 10, 255]),
    metalness: 0.75,
    roughness: 0.5,
  };
  const geometry = mesh(faces, { uvs: new Float32Array(16) });
  for (const color of [
    [1, 1, 1, 1],
    [0.5, 0.25, 0.125, 1],
  ]) {
    const read = await parse3MFMaterials(await export3MF({ nodes: [{ geometry, material: { ...material, color } }] }));
    const { metallic, layers } = read.groups[0];
    assert.equal(!!layers, color[0] !== 1, 'a tint makes a stack');
    assert.deepEqual([metallic.metalness, metallic.roughness], [0.75, 0.5]);
    assert.equal(metallic.metalnessTexture, metallic.roughnessTexture);
    assert.equal(metallic.layer, layers ? 1 : undefined);
    // One resource for both values: roughness in red, metalness in green.
    const image = await decodeImage(read.textures[metallic.roughnessTexture].data);
    assert.deepEqual([...image.data], [40, 200, 0, 255, 220, 10, 0, 255]);
  }
});

const linear = (value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
const close = (actual, expected, within, label) => {
  assert.equal(actual.length, expected.length, label);
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) <= within, `${label}: ${actual} against ${expected}`));
};
// One material of each kind, as data scenes and exportMaterialGLB describe them.
const GOLD = {
    name: 'Gold',
    roughness: 0.25,
    extensions: { KHR_materials_specular: { specularColorFactor: [1, 0.5, 0.25], specularFactor: 0.5 } },
  },
  WATER = { name: 'Water', roughness: 0.1, ior: 1.33 },
  GEM = { name: 'Gem', ior: 0, extensions: { KHR_materials_specular: { specularColorFactor: [0.6, 0.5, 0.2] } } },
  GLASS = {
    name: 'Glass',
    roughness: 0.05,
    transmission: 1,
    extensions: {
      KHR_materials_volume: { thicknessFactor: 1, attenuationColor: [0.5, 0.8, 0], attenuationDistance: 0.25 },
      KHR_materials_dispersion: { dispersion: 0.4 },
    },
  },
  STEEL = { name: 'Steel', metalness: 1, roughness: 0.5 };
const KINDS = [GOLD, WATER, GEM, GLASS, STEEL];
const row = () => KINDS.map((material, i) => ({ translation: [2 * i, 0, 0], geometry: mesh(), material }));
const WATER_F0 = (0.33 / 2.33) ** 2;
// KHR_materials_ior and _specular: reflectance at normal incidence.
const REFLECTANCE = {
  Gold: [0.02, 0.01, 0.005],
  Water: [WATER_F0, WATER_F0, WATER_F0],
  Gem: [0.6, 0.5, 0.2],
};
// Beer-Lambert per metre; black is written as 2^-16.
const ATTENUATION = [0.5, 0.8, 2 ** -16].map((c) => -Math.log(c) / 0.25);
const checkKinds = (groups) => {
  const named = Object.fromEntries(
    groups.map((group) => [(group.specular ?? group.translucent ?? group.metallic)?.name, group]),
  );
  for (const [name, reflectance] of Object.entries(REFLECTANCE)) {
    const { specular, metallic, translucent } = named[name];
    assert.ok(!metallic && !translucent, name);
    // The colour is written as 8-bit sRGB.
    close(specular.specularColor.map(linear), reflectance, 0.005, name);
  }
  assert.deepEqual(
    ['Gold', 'Water', 'Gem'].map((name) => named[name].specular.glossiness),
    [0.75, 0.9, 0],
  );
  close(named.Glass.translucent.attenuation, ATTENUATION, 1e-4, 'attenuation per metre');
  close(named.Glass.translucent.refractiveIndex, [1.495, 1.5, 1.505], 1e-6, 'dispersion 0.4 at index 1.5');
  assert.equal(named.Glass.translucent.roughness, 0.05);
  assert.deepEqual([named.Steel.metallic.metalness, named.Steel.metallic.roughness], [1, 0.5]);
};

test('specular, translucent and metallic materials each take a base material group and read back', async () => {
  for (const assembly of [true, false, 'components']) {
    const file = await export3MF({ nodes: row() }, { assembly }),
      text = await model(file),
      groups = [...text.matchAll(/<basematerials id="(\d+)" displaypropertiesid="(\d+)">/g)];
    assert.equal(groups.length, 3, 'one group for each kind of display properties');
    // Every resource is defined before it is named (core specification section 3.4).
    for (const [named, , display] of groups) {
      const defined = text.search(new RegExp(`displayproperties id="${display}"`));
      assert.ok(defined >= 0 && defined < text.indexOf(named), named);
    }
    assert.equal(count(text, /<m:pbspecular /g), 3);
    assert.equal(count(text, /<m:translucent /g), 1);
    checkKinds((await parse3MFMaterials(file)).groups);
  }
  const plain = await model(await export3MF({ nodes: row() }, { displayProperties: false }));
  assert.ok(!plain.includes('displayproperties'));
  assert.equal(count(plain, /<basematerials /g), 1);
});

test('a GLB keeps its transmission, volume, index of refraction and specular colour into 3MF', async () => {
  const glb = exportMaterialGLB({ nodes: row() });
  checkKinds((await parse3MFMaterials(await export3MF(glb))).groups);
});

test('colours and textures reach a translucent material through multiproperties over its white base', async () => {
  const colors = new Float32Array(24).fill(0.5),
    image = await png({ width: 1, height: 1, data: new Uint8Array([200, 100, 50, 255]) }, 1, false),
    texture = { image, mimeType: 'image/png' },
    uvs = new Float32Array(16);
  for (const [geometry, material] of [
    [mesh(faces, { colors, colorSize: 3 }), GLASS],
    [mesh(faces, { uvs }), { ...GLASS, baseColorTexture: texture }],
    [mesh(faces, { uvs }), { ...GLASS, color: [0.5, 0.5, 0.5], baseColorTexture: texture }],
  ]) {
    const file = await export3MF({ nodes: [{ geometry, material }] }),
      text = await model(file);
    // Section 7.5.1: neither a colour group nor a texture group may take translucent display properties.
    assert.ok(!/<m:(colorgroup|texture2dgroup)[^>]*displaypropertiesid/.test(text), text);
    assert.match(text, /<base name="Glass" displaycolor="#FFFFFF"\/>/);
    const read = await parse3MFMaterials(file);
    assert.equal(read.groups.length, 1);
    assert.equal(read.groups[0].translucent.name, 'Glass');
    assert.equal(read.groups[0].translucent.layer, 0);
    assert.equal(read.groups[0].texture, material.baseColorTexture ? 0 : undefined);
    // Linear 0.5 is sRGB 0.7354, multiplied over the white base.
    if (!material.baseColorTexture || material.color)
      close([...read.colors.slice(0, 3)], [0.7354, 0.7354, 0.7354], 0.004, 'the tint over the white base');
  }
});

test('specular materials with colours and maps are written as specular display properties', async () => {
  const uvs = new Float32Array(16).fill(0.5),
    texture = async (pixels) => ({
      image: await png({ width: 2, height: 1, data: new Uint8Array(pixels) }, 2, false),
      mimeType: 'image/png',
    }),
    base = await texture([255, 0, 0, 255, 0, 255, 0, 255]),
    rough = await texture([0, 100, 0, 255, 0, 200, 0, 255]),
    tinted = await texture([250, 128, 64, 255, 32, 16, 8, 255]),
    colors = new Float32Array(24).map((_, i) => (i % 5) / 4),
    mapped = {
      name: 'Lacquer',
      roughness: 0.5,
      baseColorTexture: base,
      metallicRoughnessTexture: rough,
      extensions: { KHR_materials_specular: { specularColorTexture: { texture: tinted } } },
    },
    file = await export3MF({
      nodes: [
        { geometry: mesh(faces, { uvs }), material: mapped },
        { translation: [2, 0, 0], geometry: mesh(faces, { uvs }), material: { ...WATER, baseColorTexture: base } },
        { translation: [4, 0, 0], geometry: mesh(faces, { colors, colorSize: 3 }), material: GOLD },
      ],
    }),
    text = await model(file),
    properties = [...text.matchAll(/<m:pbspeculartexturedisplayproperties ([^>]*)\/>/g)].map(([, attributes]) =>
      Object.fromEntries([...attributes.matchAll(/(\w+)="([^"]*)"/g)].map(([, name, value]) => [name, value])),
    ),
    imageOf = async (id) => {
      const [, path] = text.match(new RegExp(`<m:texture2d id="${id}" path="/([^"]+)" contenttype="image/png"/>`));
      return [...(await decodeImage(await part(file, path))).data];
    };
  assert.deepEqual(
    properties.map((p) => [p.name, p.glossinessfactor]),
    [
      ['Lacquer', '1'],
      ['Water', '0.9'],
    ],
  );
  // The maps name no sampling: it is the base colour texture's (section 7.3).
  assert.deepEqual(await imageOf(properties[0].speculartextureid), [250, 128, 64, 255, 32, 16, 8, 255]);
  // 1 - 0.5 x 100 / 255 and 1 - 0.5 x 200 / 255, as bytes.
  assert.deepEqual(await imageOf(properties[0].glossinesstextureid), [205, 205, 205, 255, 155, 155, 155, 255]);
  assert.equal(properties[1].speculartextureid, properties[1].glossinesstextureid);
  assert.deepEqual(await imageOf(properties[1].speculartextureid), [255, 255, 255, 255]);
  const [, display] = text.match(/<m:colorgroup id="\d+" displaypropertiesid="(\d+)">/),
    entries = text.match(
      new RegExp(`<m:pbspeculardisplayproperties id="${display}">(.*?)</m:pbspeculardisplayproperties>`),
    )[1];
  assert.equal(count(entries, /<m:pbspecular name="Gold" /g), count(entries, /<m:pbspecular /g));
  assert.ok(count(entries, /<m:pbspecular /g) > 1);
  const read = await parse3MFMaterials(file),
    kinds = read.groups.map((group) =>
      JSON.stringify([group.specular?.name, group.specular?.specularTexture !== undefined, !!group.metallic]),
    );
  // The coloured box splits by colour; each of its groups is Gold's.
  assert.deepEqual(
    [...new Set(kinds)].map((kind) => JSON.parse(kind)),
    [
      ['Lacquer', true, false],
      ['Water', true, false],
      ['Gold', false, false],
    ],
  );
});

test('what 3MF cannot hold is warned about: partial transmission, a strength map and a map elsewhere', async () => {
  const image = await png({ width: 1, height: 1, data: new Uint8Array(4).fill(255) }, 1, false),
    texture = { image, mimeType: 'image/png' },
    written = async (material) => {
      const warnings = [],
        file = await export3MF(
          { nodes: [{ geometry: mesh(faces, { uvs: new Float32Array(16) }), material }] },
          { onWarning: (warning) => warnings.push(warning.message) },
        );
      return { warnings, group: (await parse3MFMaterials(file)).groups[0] };
    };
  const mostly = await written({ transmission: 0.75 }),
    barely = await written({ transmission: 0.25, roughness: 0.5 });
  assert.ok(mostly.group.translucent && mostly.warnings.length === 1, mostly.warnings.join());
  assert.ok(barely.group.metallic && !barely.group.translucent && barely.warnings.length === 1);
  // A metal passes no light, whatever its transmission says.
  assert.ok((await written({ transmission: 1, metalness: 1 })).group.metallic);
  const strength = await written({ extensions: { KHR_materials_specular: { specularTexture: { texture } } } });
  assert.match(strength.warnings.join(), /strength map/);
  const elsewhere = await written({
    baseColorTexture: texture,
    extensions: { KHR_materials_specular: { specularColorTexture: { texture: { ...texture, wrapS: 'clamp' } } } },
  });
  assert.match(elsewhere.warnings.join(), /specular colour map/);
  await assert.rejects(
    written({ extensions: { KHR_materials_specular: { specularColorFactor: [1, -1, 1] } } }),
    RangeError,
  );
});
