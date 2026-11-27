// export3MF's boolean shapes, by the 3MF Boolean Operations Extension specification
// (https://github.com/3MFConsortium/spec_booleans), read back through `parse3MFBoolean`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse3MF, readZipDirectory, readZipEntry } from '@margoengine/loaders';
import { parse3MFBoolean } from '@margoengine/loaders/threemf-boolean';
import { export3MF } from '@margoengine/exporters/threemf';
import { encodeZIP } from '../dist/archive.js';

const corners = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
const faces = [
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
];
const box = {
  positions: new Float32Array(corners),
  normals: new Float32Array(corners.length),
  indices: new Uint32Array(faces),
};
const attributes = (tag) => Object.fromEntries([...tag.matchAll(/([\w:]+)="([^"]*)"/g)].map(([, k, v]) => [k, v]));
const elements = (text, name) =>
  [...text.matchAll(new RegExp(`<${name}((?: [^>]*?)?)/?>`, 'g'))].map((m) => attributes(m[1]));
const ROOT = '3D/3dmodel.model';
const rootText = async (file) => {
  const entry = readZipDirectory(file).find((e) => e.name === ROOT);
  return new TextDecoder().decode(await readZipEntry(file, entry));
};
const moved = (x) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
const drill = { name: 'drill', geometry: box, matrix: moved(0.5) };
const clip = { name: 'clip', geometry: box, matrix: moved(-0.5) };

test('boolean steps chain shapes over the node mesh and its operands, which read back', async () => {
  const file = await export3MF(
      { nodes: [{ name: 'part', geometry: box }] },
      {
        unit: 'meter',
        upAxis: 'z',
        production: { separateParts: true },
        objectInfo: () => ({
          partNumber: 'P-1',
          boolean: [{ operation: 'intersection', operands: [clip] }, { operands: [drill, clip] }],
        }),
      },
    ),
    text = await rootText(file),
    [model] = elements(text, 'model'),
    objects = elements(text, 'object'),
    shapes = elements(text, 'bo:booleanshape'),
    operands = elements(text, 'bo:boolean'),
    [item] = elements(text, 'item');
  assert.equal(model['xmlns:bo'], 'http://schemas.3mf.io/3dmanufacturing/booleanoperations/2023/07');
  assert.ok(model.requiredextensions.split(' ').includes('bo'));
  // The base, the clip, the first shape, the drill, then the second shape; the clip is written once.
  assert.equal(objects.length, 5);
  const [base, clipped, first, drilled, second] = objects;
  assert.deepEqual(
    shapes.map((s) => [s.objectid, s.operation]),
    [
      [base.id, 'intersection'],
      [first.id, 'union'],
    ],
  );
  assert.deepEqual(
    operands.map((o) => o.objectid),
    [clipped.id, drilled.id, clipped.id],
  );
  for (const shape of [first, second]) assert.equal(shape.pid ?? shape.pindex, undefined, 'a shape takes no property');
  assert.ok(base.pid);
  assert.deepEqual(
    objects.map((o) => o.partnumber),
    [undefined, undefined, undefined, undefined, 'P-1'],
  );
  assert.equal(item.objectid, second.id);
  assert.ok(text.includes('<vertex x="1.5" y="1" z="1"/>'), 'an operand is baked where its node places it');

  await assert.rejects(parse3MF(file), { code: 'unsupported', message: /parse3MFBoolean/ });
  const read = await parse3MFBoolean(file, { units: 'file' });
  assert.equal(read.indices.length, 0);
  assert.deepEqual(
    read.shapes.map((s) => [s.objectId, s.operation, s.base.objectId, s.operands.length, s.instances.length]),
    [
      [first.id, 'intersection', base.id, 1, 0],
      [second.id, 'union', first.id, 2, 1],
    ],
  );
  assert.equal(read.shapes[0].base.mesh.indices.length, 36);
  assert.equal(read.shapes[1].base.mesh, undefined);
});

test('boolean shapes the specification rules out are refused by the writer', async () => {
  const write = (info, options = {}) =>
    export3MF({ nodes: [{ geometry: box }] }, { objectInfo: () => info, ...options });
  const steps = { operands: [drill] };
  await assert.rejects(write({ boolean: { operation: 'xor', operands: [drill] } }), { message: /operation/ });
  await assert.rejects(write({ boolean: { operands: [] } }), { message: /operand/ });
  await assert.rejects(write({ boolean: steps, type: 'support' }), { message: /model object/ });
  await assert.rejects(write({ boolean: steps, alternatives: [{ node: drill }] }, { production: true }), {
    message: /alternatives/,
  });
  const two = { nodes: [0, 1].map(() => ({ geometry: box })) };
  await assert.rejects(export3MF(two, { objectInfo: () => ({ boolean: steps }) }), { message: /own object/ });
});

const cube =
  '<mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>' +
  '<vertex x="0" y="0" z="1"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/>' +
  '<triangle v1="1" v2="2" v3="3"/><triangle v1="0" v2="3" v3="2"/></triangles></mesh>';
/** The specification's example (appendix D), its elided meshes filled with a tetrahedron. */
const resources =
  '<basematerials id="2"><base name="Red" displaycolor="#FF0000"/><base name="Green" displaycolor="#00FF00"/>' +
  '<base name="Blue" displaycolor="#0000FF"/></basematerials>' +
  `<object id="3" type="model" name="Cube" pid="2" pindex="0">${cube}</object>` +
  `<object id="4" type="model" name="Sphere" pid="2" pindex="2">${cube}</object>` +
  `<object id="5" type="model" name="Cylinder" pid="2" pindex="1">${cube}</object>` +
  '<object id="6" type="model" name="Intersected"><bo:booleanshape objectid="3" operation="intersection" ' +
  'transform="0.0741111 0 0 0 0.0741111 0 0 0 0.0741111 2.91124 -0.400453 1.60607">' +
  '<bo:boolean objectid="4" transform="0.0741111 0 0 0 0.0741111 0 0 0 0.0741111 2.91124 -0.400453 1.60607"/>' +
  '</bo:booleanshape></object>' +
  '<object id="10" type="model" name="Full part"><bo:booleanshape objectid="6" operation="difference">' +
  '<bo:boolean objectid="5" transform="0.0271726 0 0 0 0 0.0271726 0 -0.0680034 0 4.15442 3.58836 5.23705"/>' +
  '<bo:boolean objectid="5" transform="0.0272014 0 0 0 0.0272012 0 0 0 0.0680035 4.05357 6.33412 3.71548"/>' +
  '<bo:boolean objectid="5" transform="0 0 -0.0272013 0 0.0272013 0 0.0680032 0 0 5.05103 6.32914 3.35287"/>' +
  '</bo:booleanshape></object>';
const packaged = (body) =>
  encodeZIP([
    {
      name: ROOT,
      data: new TextEncoder().encode(
        '<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ' +
          'xmlns:bo="http://schemas.3mf.io/3dmanufacturing/booleanoperations/2023/07" requiredextensions="bo" ' +
          `unit="millimeter"><resources>${body}</resources><build>` +
          '<item objectid="10" transform="25.4 0 0 0 25.4 0 0 0 25.4 0 0 0"/></build></model>',
      ),
    },
  ]);

test("the specification's example reads, and broken shapes are refused", async () => {
  const read = await parse3MFBoolean(await packaged(resources), { units: 'file' }),
    [intersected, full] = read.shapes;
  assert.equal(intersected.name, 'Intersected');
  assert.equal(intersected.operation, 'intersection');
  assert.equal(intersected.base.transform[9], 2.91124);
  assert.equal(full.operands.length, 3);
  assert.equal(full.operands[0].transform[7], -0.0680034);
  assert.deepEqual([...full.instances[0]], [25.4, 0, 0, 0, 25.4, 0, 0, 0, 25.4, 0, 0, 0]);
  const broken = [
    [resources.replace('operation="difference"', 'operation="xor"'), /unknown operation/],
    [resources.replace('<bo:booleanshape objectid="6"', '<bo:booleanshape objectid="10"'), /not defined before/],
    [resources.replace('<bo:boolean objectid="5"', '<bo:boolean objectid="6"'), /plain triangle mesh/],
    [resources.replace('name="Full part"', 'name="Full part" pid="2" pindex="0"'), /no pid or pindex/],
    [resources.replace('id="5" type="model"', 'id="5" type="support"'), /model shape/],
  ];
  for (const [body, message] of broken) await assert.rejects(parse3MFBoolean(await packaged(body)), { message });
});
