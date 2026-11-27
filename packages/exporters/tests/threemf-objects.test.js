// export3MF's object types and part numbers, by the 3MF Core Specification 1.4.0 (chapter 4, sections 3.4.3.1 and 4.1),
// read back through `@margoengine/loaders`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeZIP } from '../dist/archive.js';
import { parse3MF, readZipDirectory, readZipEntry } from '@margoengine/loaders';
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
const node = (name, x = 0) => ({ name, geometry: mesh, translation: [x, 0, 0] });
const xml = async (file) => {
  const entry = readZipDirectory(file).find((e) => e.name === '3D/3dmodel.model');
  return new TextDecoder().decode(await readZipEntry(file, entry));
};
const attributes = (tag) => Object.fromEntries([...tag.matchAll(/([\w:]+)="([^"]*)"/g)].map(([, k, v]) => [k, v]));
/** Every `<object>` with its components, and every build item and component. */
const document = async (file) => {
  const text = await xml(file),
    objects = [...text.matchAll(/<object ([^>]*)>(.*?)<\/object>/g)].map(([, head, body]) => ({
      ...attributes(head),
      components: [...body.matchAll(/<component ([^>]*)\/>/g)].map(([, c]) => attributes(c)),
    })),
    items = [...text.matchAll(/<item ([^>]*)\/>/g)].map(([, a]) => attributes(a));
  return { objects, items };
};
const exported = async (nodes, options = {}) => {
  const warnings = [],
    file = await export3MF({ nodes }, { onWarning: (w) => warnings.push(w.message), ...options });
  return { file, warnings, ...(await document(file)) };
};
const info = (byName) => (source) => byName[source.name];

test('a node gives its object a type and part numbers, which read back', async () => {
  const source = node('bracket'),
    seen = [],
    out = await exported([source], {
      objectInfo: (given) => {
        seen.push(given);
        return { partNumber: 'BR-7 <"a">\ttab\nline', itemPartNumber: 'ITEM-1' };
      },
    });
  assert.equal(seen.length, 1);
  assert.equal(seen[0], source);
  assert.equal(out.objects[0].type, 'model');
  assert.equal(out.items[0].partnumber, 'ITEM-1');
  const read = await parse3MF(out.file);
  // Tabs and line ends survive XML's attribute value normalisation.
  assert.equal(read.groups[0].partNumber, 'BR-7 <"a">\ttab\nline');
  assert.equal(read.groups[0].itemPartNumber, 'ITEM-1');
  assert.equal(read.groups[0].objectType, undefined);
  const named = await exported([source], { itemPartNumber: 'ITEM-2' });
  assert.equal(named.items[0].partnumber, 'ITEM-2');
});

test('with nothing given the file holds no part number and every object is a model', async () => {
  const out = await exported([node('a'), node('b', 3)]);
  assert.doesNotMatch(await xml(out.file), /partnumber/);
  assert.deepEqual(
    out.objects.map((o) => o.type),
    ['model'],
  );
  assert.deepEqual([...(await exported([node('a'), node('b', 3)], { objectInfo: () => ({}) })).file], [...out.file]);
});

test('an assembly holds a mesh for each type and part number under one object of components', async () => {
  const nodes = [node('left'), node('right', 3), node('prop', 6), node('tag', 9)],
    out = await exported(nodes, {
      title: 'Plate',
      itemPartNumber: 'KIT-1',
      objectInfo: info({
        prop: { type: 'support' },
        tag: { partNumber: 'TAG' },
      }),
    });
  assert.deepEqual(out.warnings, []);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].partnumber, 'KIT-1');
  const top = out.objects.find((o) => o.id === out.items[0].objectid);
  assert.equal(top.name, 'Plate');
  // An object of components takes no property (core specification chapter 4).
  assert.equal(top.pid, undefined);
  assert.equal(top.pindex, undefined);
  const meshes = top.components.map((c) => out.objects.find((o) => o.id === c.objectid));
  assert.deepEqual(
    meshes.map((o) => [o.name, o.type, o.partnumber]),
    [
      ['left', 'model', undefined],
      ['prop', 'support', undefined],
      ['tag', 'model', 'TAG'],
    ],
  );
  const read = await parse3MF(out.file, { units: 'file' });
  assert.equal(read.indices.length, 4 * 36);
  assert.deepEqual(
    read.groups.map((g) => [g.name, g.objectType, g.partNumber, g.count, g.itemPartNumber]),
    [
      ['left', undefined, undefined, 72, 'KIT-1'],
      ['prop', 'support', undefined, 36, 'KIT-1'],
      ['tag', undefined, 'TAG', 36, 'KIT-1'],
    ],
  );
});

test('nodes of one type and part number share one mesh and one item', async () => {
  const out = await exported([node('a'), node('b', 3)], {
    title: 'Pair',
    objectInfo: () => ({ type: 'surface', partNumber: 'S' }),
  });
  assert.equal(out.objects.length, 1);
  assert.deepEqual([out.objects[0].type, out.objects[0].partnumber, out.objects[0].name], ['surface', 'S', 'Pair']);
  assert.equal(out.items.length, 1);
});

test('an other object stays among the resources, out of the build, and is not read as geometry', async () => {
  for (const assembly of [true, 'components', false]) {
    const out = await exported([node('part'), node('jig', 3)], {
      assembly,
      objectInfo: info({ jig: { type: 'other', partNumber: 'JIG' } }),
    });
    const jig = out.objects.find((o) => o.type === 'other');
    assert.equal(jig.partnumber, 'JIG', String(assembly));
    const referenced = [
      ...out.items.map((i) => i.objectid),
      ...out.objects.flatMap((o) => o.components.map((c) => c.objectid)),
    ];
    assert.ok(!referenced.includes(jig.id), String(assembly));
    assert.equal((await parse3MF(out.file)).indices.length, 36);
  }
  await assert.rejects(exported([node('jig')], { objectInfo: () => ({ type: 'other' }) }), RangeError);
});

test('objects with different types or part numbers are not shared', async () => {
  const out = await exported([node('a'), node('b', 3), node('c', 6)], {
    assembly: false,
    objectInfo: info({
      a: { itemPartNumber: 'I-A' },
      b: { itemPartNumber: 'I-B' },
      c: { partNumber: 'C' },
    }),
  });
  assert.equal(out.objects.length, 2);
  assert.equal(out.items.length, 3);
  assert.equal(out.items[0].objectid, out.items[1].objectid);
  assert.deepEqual(
    out.items.map((i) => i.partnumber),
    ['I-A', 'I-B', undefined],
  );
});

test('support outside an assembly with its model is written, with a warning', async () => {
  const objectInfo = info({ prop: { type: 'support' }, tree: { type: 'solidsupport' } });
  for (const [nodes, assembly, warned] of [
    [[node('part'), node('prop', 3)], true, 0],
    [[node('part'), node('tree', 3)], 'components', 0],
    [[node('part'), node('prop', 3)], false, 1],
    [[node('prop')], true, 1],
    [[node('prop'), node('tree', 3)], true, 1],
    [[node('prop'), node('tree', 3)], 'components', 1],
  ]) {
    const out = await exported(nodes, { assembly, objectInfo });
    assert.equal(out.warnings.length, warned, `${nodes.map((n) => n.name)} ${assembly}`);
    if (warned) assert.match(out.warnings[0], /support/);
  }
});

test('values the format would reject are refused', async () => {
  const one = [node('a')],
    two = [node('a'), node('b', 3)];
  for (const [nodes, options, kind] of [
    [one, { objectInfo: 'support' }, TypeError],
    [one, { objectInfo: () => ({ type: 'solid' }) }, RangeError],
    [one, { objectInfo: () => ({ partNumber: 7 }) }, TypeError],
    [one, { objectInfo: () => ({ partNumber: '' }) }, TypeError],
    [one, { itemPartNumber: 3 }, TypeError],
    [one, { itemPartNumber: 'x', objectInfo: () => ({ itemPartNumber: 'y' }) }, RangeError],
    [two, { itemPartNumber: 'x', assembly: false }, RangeError],
    [two, { objectInfo: () => ({ itemPartNumber: 'y' }) }, RangeError],
    [two, { assembly: 'components', objectInfo: () => ({ itemPartNumber: 'y' }) }, RangeError],
    [two, { assembly: false, objectInfo: () => ({ type: 'other', itemPartNumber: 'y' }) }, RangeError],
  ])
    await assert.rejects(export3MF({ nodes }, options), kind, JSON.stringify(options));
});

test('the reader keeps an other mesh out however it is reached, and ignores the type of an object of components', async () => {
  // Core 3MF: `other` MUST NOT be reached from the build, directly or through components; the type of an object of
  // components is ignored.
  const triangle = (id, type) =>
      `<object id="${id}" type="${type}"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>`,
    package3MF = (body, items) =>
      encodeZIP([
        {
          name: '3D/3dmodel.model',
          data: new TextEncoder().encode(
            `<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${body}</resources><build>${items}</build></model>`,
          ),
        },
      ]);
  const nested = await package3MF(
    `${triangle(1, 'model')}${triangle(2, 'other')}<object id="3" type="other"><components><component objectid="1"/><component objectid="2"/></components></object>`,
    '<item objectid="3"/><item objectid="2"/>',
  );
  const read = await parse3MF(nested);
  assert.equal(read.indices.length, 3);
  assert.deepEqual(
    read.groups.map((g) => g.objectId),
    ['1'],
  );
});
