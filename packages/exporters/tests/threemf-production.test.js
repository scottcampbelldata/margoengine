// export3MF's production extension and parse3MF's reading of it, by the 3MF Production Extension specification
// (https://github.com/3MFConsortium/spec_production): UUIDs on the build, items, objects and components (chapter 4),
// the path attribute and one level of model parts (chapters 2 and 3), and alternative representations (4.2.2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse3MF, readZipDirectory, readZipEntry } from '@margoengine/loaders';
import { encodeZIP } from '../dist/archive.js';
import { export3MF } from '@margoengine/exporters/threemf';

const corners = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
const faces = [
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
];
const mesh = {
  positions: new Float32Array(corners),
  normals: new Float32Array(corners.length),
  indices: new Uint32Array(faces),
};
/** A tetrahedron: the coarse stand-in for the box. */
const coarse = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
  normals: new Float32Array(12),
  indices: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
};
const node = (name, x = 0) => ({ name, geometry: mesh, translation: [x, 0, 0] });
const UUID4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const numbered = ({ element, index }) => {
  const kind = ['build', 'item', 'object', 'component', 'alternative'].indexOf(element);
  return `${String(kind).padStart(8, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`;
};
const attributes = (tag) => Object.fromEntries([...tag.matchAll(/([\w:]+)="([^"]*)"/g)].map(([, k, v]) => [k, v]));
const elements = (text, name) =>
  [...text.matchAll(new RegExp(`<${name}((?: [^>]*?)?)/?>`, 'g'))].map((m) => attributes(m[1]));
const parts = async (file) => {
  const out = {};
  for (const entry of readZipDirectory(file))
    out[entry.name] = new TextDecoder().decode(await readZipEntry(file, entry));
  return out;
};
const ROOT = '3D/3dmodel.model';
const PRODUCTION = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';

test('every build, item, object and component has its own UUID, which reads back', async () => {
  const file = await export3MF({ nodes: [node('a'), node('b', 3)] }, { production: true, assembly: 'components' }),
    text = (await parts(file))[ROOT],
    [model] = elements(text, 'model'),
    given = ['build', 'item', 'object', 'component'].flatMap((name) => elements(text, name).map((e) => e['p:UUID']));
  assert.equal(model['xmlns:p'], PRODUCTION);
  // No model part refers to another, so nothing is required of the reader.
  assert.equal(model.requiredextensions, undefined);
  assert.equal(given.length, 1 + 1 + 2 + 2);
  for (const uuid of given) assert.match(uuid, UUID4);
  assert.equal(new Set(given).size, given.length);
  const read = await parse3MF(file);
  assert.equal(read.buildUUID, elements(text, 'build')[0]['p:UUID']);
  assert.deepEqual(
    read.groups.map((g) => g.itemUUID),
    Array(2).fill(elements(text, 'item')[0]['p:UUID']),
  );
  assert.deepEqual(
    read.groups.map((g) => g.componentUUID),
    elements(text, 'component').map((c) => c['p:UUID']),
  );
  // The two nodes share one mesh object, so both groups carry its UUID.
  assert.equal(read.groups[0].uuid, elements(text, 'object')[0]['p:UUID']);
  assert.equal(read.groups[0].modelPath, undefined);
});

test('UUIDs from the caller write the same bytes twice', async () => {
  const seen = [],
    options = {
      assembly: false,
      production: {
        uuid: (element) => {
          seen.push(`${element.element} ${element.index} ${element.name}`);
          return numbered(element);
        },
      },
    },
    scene = { nodes: [node('a'), node('b', 3)] },
    first = await export3MF(scene, options),
    second = await export3MF(scene, options);
  assert.deepEqual(first, second);
  assert.deepEqual(seen.slice(0, seen.length / 2), ['object 0 a', 'item 0 a', 'item 1 b', 'build 0 undefined']);
});

test('separate parts hold one object and its resources each, named by path from the root', async () => {
  const red = { name: 'Red', color: [1, 0, 0, 1] },
    blue = { name: 'Blue', color: [0, 0, 1, 1] },
    png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]),
    painted = {
      name: 'Painted',
      geometry: { ...mesh, uvs: new Float32Array(16) },
      material: { name: 'Print', baseColorTexture: { image: png, mimeType: 'image/png' } },
      translation: [6, 0, 0],
    },
    file = await export3MF(
      { nodes: [{ ...node('a'), material: red }, { ...node('b', 3), material: blue }, painted] },
      { assembly: false, displayProperties: false, production: { separateParts: true, uuid: numbered } },
    ),
    all = await parts(file),
    root = all[ROOT],
    [model] = elements(root, 'model'),
    items = elements(root, 'item'),
    models = items.map((item) => item['p:path']);
  assert.equal(model.requiredextensions, 'p');
  assert.equal(new Set(models).size, 3);
  // The root holds no object and refers to no resource of a part.
  assert.equal(elements(root, 'object').length, 0);
  assert.equal(elements(root, 'basematerials').length, 0);
  assert.match(all['3D/_rels/3dmodel.model.rels'], /3dmodel"/);
  for (const [i, path] of models.entries()) {
    assert.match(path, /^\/3D\/Objects\/object\d+\.model$/);
    assert.ok(all['3D/_rels/3dmodel.model.rels'].includes(`Target="${path}"`));
    const text = all[path.slice(1)],
      [object] = elements(text, 'object');
    assert.equal(object.id, items[i].objectid);
    // A referenced part's build is empty, and it defines every property its object names.
    assert.ok(text.includes('<build/>'));
    const defined = new Set([...text.matchAll(/<(?:m:\w+|basematerials) id="(\d+)"/g)].map((m) => m[1]));
    for (const [, pid] of text.matchAll(/ (?:pid|texid|matid)="(\d+)"/g)) assert.ok(defined.has(pid), pid);
    assert.equal(elements(text, 'basematerials').length, 1);
  }
  // Only the textured object's part relates to the image.
  const textured = models[2].slice(1).replace(/([^/]+)$/, '_rels/$1.rels');
  assert.match(all[textured], /Target="\/3D\/Textures\/texture1\.png"/);
  assert.ok(!all['3D/_rels/3dmodel.model.rels'].includes('Textures'));
  const read = await parse3MF(file);
  assert.deepEqual(
    read.groups.map((g) => g.modelPath),
    models,
  );
  assert.deepEqual(read.groups[0].color, [1, 0, 0, 1]);
  assert.deepEqual(read.groups[1].color, [0, 0, 1, 1]);
  assert.equal(read.groups[0].itemUUID, items[0]['p:UUID']);
  // Millimetres back to metres: the second box starts 3 m along X.
  assert.equal(read.positions[read.indices[read.groups[1].start] * 3] >= 3, true);
});

test('a merged assembly in separate parts places each mesh by path from its object of components', async () => {
  const file = await export3MF(
      { nodes: [node('model'), node('prop', 3)] },
      {
        production: { separateParts: true },
        objectInfo: (source) => (source.name === 'prop' ? { type: 'support' } : undefined),
      },
    ),
    root = (await parts(file))[ROOT],
    components = elements(root, 'component');
  assert.equal(components.length, 2);
  for (const component of components) assert.match(component['p:path'], /^\/3D\/Objects\//);
  const read = await parse3MF(file);
  assert.equal(read.indices.length, 72);
  assert.deepEqual(
    read.groups.map((g) => g.objectType),
    [undefined, 'support'],
  );
});

test('an alternative stands in for its object by resolution', async () => {
  const file = await export3MF(
      { nodes: [node('part', 2)] },
      {
        unit: 'meter',
        upAxis: 'z',
        production: { separateParts: true, uuid: numbered },
        objectInfo: () => ({
          modelResolution: 'fullres',
          alternatives: [{ node: { name: 'coarse', geometry: coarse }, resolution: 'lowres' }],
        }),
      },
    ),
    all = await parts(file),
    root = all[ROOT],
    [model] = elements(root, 'model'),
    [alternative] = elements(root, 'pa:alternative'),
    [object] = elements(root, 'object');
  assert.equal(model['xmlns:pa'], 'http://schemas.microsoft.com/3dmanufacturing/production/alternatives/2021/04');
  // The object with alternatives stays in the root part, as only the root may name another part.
  assert.equal(object['pa:modelresolution'], 'fullres');
  assert.equal(object['p:path'], undefined);
  assert.equal(alternative.modelresolution, 'lowres');
  assert.equal(alternative.UUID, numbered({ element: 'alternative', index: 0 }));
  assert.match(alternative.path, /^\/3D\/Objects\//);
  assert.equal(model.requiredextensions, 'p pa');
  const full = await parse3MF(file, { units: 'file' });
  assert.equal(full.indices.length, 36);
  assert.equal(full.groups[0].alternativeUUID, undefined);
  const low = await parse3MF(file, { units: 'file', modelResolution: 'lowres' });
  assert.equal(low.indices.length, 12);
  assert.equal(low.groups[0].uuid, object['p:UUID']);
  assert.equal(low.groups[0].alternativeUUID, alternative.UUID);
  assert.equal(low.groups[0].modelPath, alternative.path);
  // The alternative is placed by the item as the object is: 2 along X.
  assert.equal(Math.min(...low.positions.filter((_, i) => i % 3 === 0)), 2);
  // No obfuscated representation: the object's own mesh.
  assert.equal((await parse3MF(file, { modelResolution: 'obfuscated' })).indices.length, 36);
});

test('alternatives in the root part keep a mirrored node outward', async () => {
  const volume = ({ positions, indices }) => {
    let sum = 0;
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => positions.subarray(indices[i + k] * 3, indices[i + k] * 3 + 3));
      sum +=
        a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    }
    return sum / 6;
  };
  for (const own of [
    [1, 1, 1],
    [-1, 1, 1],
  ]) {
    const file = await export3MF(
        { nodes: [{ ...node('part'), scale: [-1, 1, 1] }] },
        {
          unit: 'meter',
          upAxis: 'z',
          production: true,
          objectInfo: () => ({
            alternatives: [{ node: { geometry: coarse, scale: own }, resolution: 'lowres' }],
          }),
        },
      ),
      low = await parse3MF(file, { units: 'file', modelResolution: 'lowres' });
    assert.ok(Math.abs(volume(low) - 1 / 6) < 1e-6, `${own}: ${volume(low)}`);
  }
});

test('what the extension would reject is refused', async () => {
  const scene = { nodes: [node('a'), node('b', 3)] },
    refused = (options, type = RangeError) => assert.rejects(export3MF(scene, options), type),
    alternatives = [{ node: { geometry: coarse } }];
  await refused({ production: 'yes' }, TypeError);
  await refused({ production: { uuid: () => 'nonsense' } });
  await refused({ production: { uuid: () => '00000000-0000-4000-8000-000000000000' } });
  await refused({ production: { uuid: () => '00000000-0000-4000-8000-00000000000A' } });
  await refused({ assembly: false, objectInfo: () => ({ alternatives }) });
  await refused({ production: true, objectInfo: () => ({ alternatives }) });
  await refused({ production: true, assembly: false, objectInfo: () => ({ modelResolution: 'high' }) });
  await refused({
    production: true,
    assembly: false,
    objectInfo: () => ({ alternatives: [{ node: { geometry: coarse }, resolution: 'high' }] }),
  });
});

/** A package of model parts written by hand. */
const packed = (models) =>
  encodeZIP(
    Object.entries(models).map(([name, body]) => ({ name, data: new TextEncoder().encode(body) })),
    {},
  );
const tetra =
  '<mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>' +
  '<vertex x="0" y="0" z="1"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/>' +
  '<triangle v1="0" v2="1" v3="3"/><triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/></triangles></mesh>';
const model = (resources, build, prefix = 'p') =>
  `<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:${prefix}="${PRODUCTION}">` +
  `<resources>${resources}</resources><build>${build}</build></model>`;

test('the reader follows the namespace, whatever prefix a file gives it', async () => {
  const file = await packed({
      [ROOT]: model(
        '<object id="2"><components><component objectid="1" prod:path="/3D/other.model" prod:UUID="c"/></components></object>',
        '<item objectid="2" prod:UUID="i"/>',
        'prod',
      ),
      // The other part's own build is ignored, so what it names need not exist.
      '3D/other.model': model(
        `<object id="1" prod:UUID="o">${tetra}</object>`,
        '<item objectid="9" prod:path="/3D/missing.model"/>',
        'prod',
      ),
    }),
    read = await parse3MF(file);
  assert.equal(read.indices.length, 12);
  assert.deepEqual(
    [read.groups[0].itemUUID, read.groups[0].componentUUID, read.groups[0].uuid, read.groups[0].modelPath],
    ['i', 'c', 'o', '/3D/other.model'],
  );
});

test('the reader refuses a path outside the root part and alternatives of an alternative', async () => {
  const nested = await packed({
    [ROOT]: model('', '<item objectid="2" p:path="/3D/a.model"/>'),
    '3D/a.model': model(
      '<object id="2"><components><component objectid="1" p:path="/3D/b.model"/></components></object>',
      '',
    ),
    '3D/b.model': model(`<object id="1">${tetra}</object>`, ''),
  });
  await assert.rejects(parse3MF(nested), /only the root model part/);
  const chained = await packed({
    [ROOT]: model(
      `<object id="1">${tetra}</object>` +
        `<object id="2">${tetra}<alternatives><alternative objectid="1"/></alternatives></object>` +
        `<object id="3">${tetra}<alternatives><alternative objectid="2"/></alternatives></object>`,
      '<item objectid="3"/>',
    ),
  });
  await assert.rejects(parse3MF(chained), /alternatives of its own/);
});
