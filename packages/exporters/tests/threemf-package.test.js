// export3MF's package: compression, metadata, thumbnail, display properties, components, welded primitives and the mesh
// check, read back through `@margoengine/loaders`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse3MF, readZipDirectory, readZipEntry } from '@margoengine/loaders';
import { parse3MFMaterials } from '@margoengine/loaders/threemf-materials';
import { decodeImage } from '@margoengine/decoders/image';
import { export3MF } from '@margoengine/exporters/threemf';
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
