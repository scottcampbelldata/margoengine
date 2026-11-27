// export3MF's composite materials, by the 3MF Materials and Properties Extension 1.2.1, chapter 4: a mixture of base
// materials in a `compositematerials` group, whose rows give each constituent's fraction. Read back through
// `@margoengine/loaders`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse3MF, readZipDirectory, readZipEntry } from '@margoengine/loaders';
import { parse3MFLattice } from '@margoengine/loaders/threemf-lattice';
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
const red = { name: 'PLA red', color: '#ff0000' };
const white = { name: 'PLA white', color: '#FFFFFF' };
const clear = { name: 'PLA clear', color: '#00FF0080' };
const attributes = (tag) => Object.fromEntries([...tag.matchAll(/([\w:]+)="([^"]*)"/g)].map(([, k, v]) => [k, v]));
const elements = (text, name) =>
  [...text.matchAll(new RegExp(`<${name} ([^>]*?)/?>`, 'g'))].map((m) => attributes(m[1]));
const exported = async (nodes, options = {}) => {
  const warnings = [],
    file = await export3MF({ nodes }, { onWarning: (w) => warnings.push(w.message), ...options }),
    entry = readZipDirectory(file).find((e) => e.name === '3D/3dmodel.model'),
    text = new TextDecoder().decode(await readZipEntry(file, entry));
  return { file, text, warnings };
};

test('one mixture for a node is a composite of its base materials, which reads back', async () => {
  const { file, text, warnings } = await exported([node('block')], {
    objectInfo: () => ({ composite: { materials: [red, white], ratios: [0.5, 0.5] } }),
  });
  assert.deepEqual(warnings, []);
  const [group] = elements(text, 'm:compositematerials'),
    [object] = elements(text, 'object'),
    bases = elements(text, 'basematerials');
  // The constituents are the only base materials: the glTF material leaves no unused group.
  assert.equal(bases.length, 1);
  assert.equal(group.matid, bases[0].id);
  assert.equal(group.matindices, '0 1');
  assert.deepEqual(elements(text, 'base'), [
    { name: 'PLA red', displaycolor: '#FF0000' },
    { name: 'PLA white', displaycolor: '#FFFFFF' },
  ]);
  assert.deepEqual(elements(text, 'm:composite'), [{ values: '0.5 0.5' }]);
  assert.equal(object.pid, group.id);
  assert.equal(object.pindex, '0');
  // Resources are defined before they are referred to (core specification).
  assert.ok(text.indexOf('<basematerials') < text.indexOf('<m:compositematerials'));
  assert.ok(text.indexOf('<m:compositematerials') < text.indexOf('<object'));
  const native = await parse3MFLattice(file),
    read = native.propertyResources.find((r) => r.kind === 'compositematerials');
  assert.deepEqual([...read.materialIndices], [0, 1]);
  assert.deepEqual([...read.weights[0]], [0.5, 0.5]);
  assert.equal(native.objects[0].pid, group.id);
  // Display colours mix in linear light (section 1.2): half red and half white is linear (1, 0.5, 0.5).
  const half = (1.055 * 0.5 ** (1 / 2.4) - 0.055) * 255;
  assert.equal(Math.round(half), 188);
  const { groups } = await parse3MF(file);
  assert.equal(groups.length, 1);
  const { color } = (await parse3MFLattice(file)).groups[0];
  assert.ok(Math.abs(color[0] - 1) < 1e-6);
  assert.ok(Math.abs(color[1] - half / 255) < 1e-6);
  assert.ok(Math.abs(color[2] - half / 255) < 1e-6);
});

test('fractions need not sum to 1: a reader divides each by their sum, and alpha mixes too', async () => {
  const { file, text } = await exported([node('block')], {
    objectInfo: () => ({ composite: { materials: [red, white, clear], ratios: [1, 1, 0.5] } }),
  });
  assert.equal(elements(text, 'm:composite')[0].values, '1 1 0.5');
  assert.equal(elements(text, 'm:compositematerials')[0].matindices, '0 1 2');
  const native = await parse3MFLattice(file),
    [weights] = native.propertyResources.find((r) => r.kind === 'compositematerials').weights;
  assert.deepEqual([...weights], [0.4, 0.4, 0.2]);
  // Alpha is linear already: 0.4 + 0.4 + 0.2 x 128/255.
  assert.ok(Math.abs(native.groups[0].color[3] - (0.8 + (0.2 * 128) / 255)) < 1e-6);
});

test('a graded mixture gives each triangle corner the fractions at its vertex', async () => {
  const seen = [];
  const { file, text, warnings } = await exported([node('graded', 5)], {
    unit: 'meter',
    upAxis: 'z',
    objectInfo: () => ({
      composite: {
        materials: [red, white],
        ratios: (position) => {
          seen.push(position);
          // The geometry's own coordinates, so the node's translation does not reach them.
          assert.ok(position[0] >= 0 && position[0] <= 1);
          return [1 - position[2] * 0.75, position[2] * 0.75];
        },
      },
    }),
  });
  assert.deepEqual(warnings, []);
  assert.ok(seen.length >= 8);
  const rows = elements(text, 'm:composite').map((row) => row.values),
    [group] = elements(text, 'm:compositematerials'),
    [object] = elements(text, 'object'),
    vertices = elements(text, 'vertex'),
    triangles = elements(text, 'triangle');
  assert.deepEqual([...rows].sort(), ['0.25 0.75', '1 0']);
  assert.equal(object.pid, group.id);
  assert.equal(triangles.length, 12);
  for (const triangle of triangles) {
    const used = [triangle.p1, triangle.p2 ?? triangle.p1, triangle.p3 ?? triangle.p1];
    [triangle.v1, triangle.v2, triangle.v3].forEach((v, corner) => {
      assert.equal(triangle.pid, group.id);
      assert.equal(rows[used[corner]], vertices[v].z === '1' ? '0.25 0.75' : '1 0');
    });
  }
  const read = await parse3MFLattice(file);
  assert.equal(read.propertyResources.find((r) => r.kind === 'compositematerials').weights.length, 2);
});

test('nodes of the same constituents share their group, and equal mixtures share an object', async () => {
  const mixes = { a: [1, 0], b: [0, 1], c: [1, 0] };
  const { text } = await exported([node('a'), node('b', 2), node('c', 4)], {
    assembly: false,
    objectInfo: (source) => ({ composite: { materials: [red, white], ratios: mixes[source.name] } }),
  });
  assert.equal(elements(text, 'm:compositematerials').length, 1);
  assert.deepEqual(elements(text, 'm:composite'), [{ values: '1 0' }, { values: '0 1' }]);
  const objects = elements(text, 'object'),
    items = elements(text, 'item');
  assert.deepEqual(
    objects.map((o) => o.pindex),
    ['0', '1'],
  );
  assert.deepEqual(
    items.map((i) => i.objectid),
    [objects[0].id, objects[1].id, objects[0].id],
  );
});

test('a merged assembly keeps each part its own material, mixture or not', async () => {
  const { file, text } = await exported([node('plain'), node('mixed', 3)], {
    objectInfo: (source) =>
      source.name === 'mixed' ? { composite: { materials: [red, white], ratios: [0.25, 0.75] } } : undefined,
  });
  const [group] = elements(text, 'm:compositematerials'),
    [object] = elements(text, 'object'),
    triangles = elements(text, 'triangle');
  assert.equal(elements(text, 'object').length, 1);
  assert.equal(elements(text, 'basematerials').length, 2);
  assert.notEqual(object.pid, group.id);
  assert.equal(triangles.filter((t) => t.pid === group.id).length, 12);
  assert.equal(triangles.filter((t) => t.pid === undefined).length, 12);
  assert.equal((await parse3MFLattice(file)).groups.length, 2);
});

test('a mixture replaces vertex colours, with a warning', async () => {
  const colored = { ...mesh, colors: new Float32Array(corners.length).fill(0.5) };
  const { text, warnings } = await exported([{ name: 'colored', geometry: colored }], {
    objectInfo: () => ({ composite: { materials: [red, white], ratios: [1, 0] } }),
  });
  assert.equal(elements(text, 'm:colorgroup').length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /mixture alone/);
});

test('mixtures the format would reject are refused', async () => {
  const refused = (composite, type) =>
    assert.rejects(export3MF({ nodes: [node('block')] }, { objectInfo: () => ({ composite }) }), type);
  await refused({ materials: [red], ratios: [1] }, RangeError);
  await refused({ materials: [red, { name: '', color: '#000000' }], ratios: [1, 0] }, TypeError);
  await refused({ materials: [red, { name: 'x', color: 'red' }], ratios: [1, 0] }, RangeError);
  await refused({ materials: [red, white], ratios: [1] }, RangeError);
  await refused({ materials: [red, white], ratios: [1.5, 0] }, RangeError);
  await refused({ materials: [red, white], ratios: [-0.1, 1] }, RangeError);
  await refused({ materials: [red, white], ratios: [0, 0] }, RangeError);
  await refused({ materials: [red, white], ratios: [Number.NaN, 1] }, RangeError);
  await refused({ materials: [red, white], ratios: () => [2, 0] }, RangeError);
});
