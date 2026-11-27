// export3MF's volume data, functions and level sets, by the 3MF Volumetric and Implicit Extensions specification
// (https://github.com/3MFConsortium/spec_volumetric), read back through `parse3MFVolumetric`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, crc32 } from 'node:zlib';
import { parse3MF, readZipDirectory, readZipEntry } from '@margoengine/loaders';
import { parse3MFVolumetric } from '@margoengine/loaders/threemf-volumetric';
import { export3MF } from '@margoengine/exporters/threemf';
import { encodeZIP } from '../dist/archive.js';

const corners = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
const faces = [
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
];
/** A box from (1, 2, 3) to (3, 6, 11). */
const box = {
  positions: new Float32Array(corners.map((v, i) => (i % 3 === 0 ? 1 + 2 * v : i % 3 === 1 ? 2 + 4 * v : 3 + 8 * v))),
  normals: new Float32Array(corners.length),
  indices: new Uint32Array(faces),
};
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length);
  out.write(type, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};
/** A greyscale 8-bit PNG. */
const png = (width, height, value = 0) => {
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width);
  head.writeUInt32BE(height, 4);
  head[8] = 8;
  const rows = Buffer.alloc((width + 1) * height, value);
  for (let y = 0; y < height; y++) rows[y * (width + 1)] = 0;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', head),
      chunk('IDAT', deflateSync(rows)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
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
const written = async (info, options = {}, node = {}) => {
  const file = await export3MF(
      { nodes: [{ name: 'block', geometry: box, ...node }] },
      { unit: 'meter', upAxis: 'z', objectInfo: () => info, ...options },
    ),
    all = await parts(file);
  return { file, all, text: all[ROOT] };
};

const stack = { name: 'mix', sheets: [png(3, 2, 10), png(3, 2, 200)] };
const sampler = { image: stack };
/** The specification's sphere example (implicit extension, chapter 3): length(pos) - radius. */
const sphere = {
  name: 'sphere',
  inputs: { pos: 'vector' },
  nodes: [
    { id: 'radius', op: 'constant', value: 1.5 },
    { id: 'Length_3', op: 'length', in: { A: 'inputs.pos' } },
    { id: 'Subtraction_4', op: 'subtraction', in: { A: 'Length_3.result', B: 'radius.value' } },
  ],
  outputs: { shape: 'Subtraction_4.result' },
};

test('volume data names image functions, and reads back', async () => {
  const volume = {
      color: { function: sampler },
      composite: [
        { name: 'PLA', color: '#ff0000', function: sampler, channel: 'red' },
        { name: 'TPU', color: '#0000ff', function: sampler, channel: 'alpha', fallback: 0.25 },
      ],
      properties: [{ namespace: 'https://example.com/heat', name: 'Temp', required: true, function: sampler }],
    },
    { file, all, text } = await written({ volume }),
    [model] = elements(text, 'model');
  assert.equal(model['xmlns:v'], 'http://schemas.3mf.io/3dmanufacturing/volumetric/2022/01');
  assert.equal(model['xmlns:i'], undefined);
  // Volume data alone changes no shape, so no reader needs the extension.
  assert.equal(model.requiredextensions, undefined);
  const [image] = elements(text, 'v:image3d'),
    [size] = elements(text, 'v:imagestack'),
    sheets = elements(text, 'v:imagesheet').map((s) => s.path);
  // Rows are the pictures' height and columns their width.
  assert.deepEqual(size, { rowcount: '2', columncount: '3', sheetcount: '2' });
  assert.deepEqual(sheets, ['/3D/volumetric/stack1/sheet0001.png', '/3D/volumetric/stack1/sheet0002.png']);
  for (const path of sheets) {
    assert.ok(all['3D/_rels/3dmodel.model.rels'].includes(`Target="${path}"`));
    assert.ok(all['[Content_Types].xml'].includes(`<Override PartName="${path}" ContentType="image/png"/>`));
  }
  assert.ok(
    all['3D/_rels/3dmodel.model.rels'].includes('http://schemas.microsoft.com/3dmanufacturing/2013/01/3dtexture'),
  );
  const functions = elements(text, 'v:functionfromimage3d');
  assert.equal(functions.length, 1, 'one function object is written once');
  assert.deepEqual(functions[0], {
    id: functions[0].id,
    image3did: image.id,
    valueoffset: '0',
    valuescale: '1',
    filter: 'linear',
    tilestyleu: 'wrap',
    tilestylev: 'wrap',
    tilestylew: 'wrap',
  });
  const [color] = elements(text, 'v:color'),
    mappings = elements(text, 'v:materialmapping'),
    [property] = elements(text, 'v:property'),
    [composite] = elements(text, 'v:composite'),
    [data] = elements(text, 'v:volumedata'),
    [mesh] = elements(text, 'mesh');
  // By default an image function spans the geometry's bounding box: x from 1 to 3 becomes 0 to 1, and so on.
  assert.equal(color.transform, '0.5 0 0 0 0.25 0 0 0 0.125 -0.5 -0.5 -0.375');
  assert.equal(color.channel, 'color');
  assert.deepEqual(
    mappings.map((m) => [m.channel, m.fallbackvalue]),
    [
      ['red', undefined],
      ['alpha', '0.25'],
    ],
  );
  assert.equal(property.required, 'true');
  assert.equal(property.name, 'vp0:Temp');
  assert.equal(model['xmlns:vp0'], 'https://example.com/heat');
  const bases = elements(text, 'basematerials').find((b) => b.id === composite.basematerialid);
  assert.ok(bases);
  assert.equal(mesh['v:volumeid'], data.id);
  const order = ['<v:image3d', '<v:functionfromimage3d', '<v:volumedata', '<object'].map((s) => text.indexOf(s));
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    'resources are defined before they are named',
  );

  const read = await parse3MFVolumetric(file, { units: 'file' });
  assert.equal(read.indices.length, 36);
  assert.equal(read.images[0].name, 'mix');
  assert.deepEqual([read.images[0].rows, read.images[0].columns], [2, 3]);
  assert.deepEqual(
    read.images[0].sheets.map((s) => [...s.data]),
    stack.sheets.map((s) => [...s]),
  );
  assert.equal(read.functions[0].kind, 'image');
  const [volumes] = read.volumes;
  assert.deepEqual(volumes.color.transform, [0.5, 0, 0, 0, 0.25, 0, 0, 0, 0.125, -0.5, -0.5, -0.375]);
  assert.equal(volumes.composite.mappings.length, 2);
  assert.deepEqual(
    volumes.properties.map((p) => [p.namespace, p.name, p.required]),
    [['https://example.com/heat', 'Temp', true]],
  );
  assert.deepEqual(
    read.objects.map((o) => [o.volumeId, o.instances.length]),
    [[volumes.id, 1]],
  );
  // A reader without the extension reads the mesh and passes the volume by.
  assert.equal((await parse3MF(file)).indices.length, 36);
});

test('function transforms take the object frame back to the geometry, turned and mirrored', async () => {
  const volume = { color: { function: sampler } },
    { text } = await written(
      { volume },
      { upAxis: 'y', unit: 'millimeter' },
      { matrix: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], assembly: false },
    ),
    m = elements(text, 'v:color')[0].transform.split(' ').map(Number),
    vertices = elements(text, 'vertex').map((v) => [Number(v.x), Number(v.y), Number(v.z)]);
  // Every vertex of the file must sample a corner of the unit cube.
  for (const [x, y, z] of vertices)
    for (let k = 0; k < 3; k++) {
      const uvw = x * m[k] + y * m[3 + k] + z * m[6 + k] + m[9 + k];
      assert.ok(Math.abs(uvw - Math.round(uvw)) < 1e-5 && uvw > -1e-5 && uvw < 1 + 1e-5, `${uvw}`);
    }
});

test('a level set bounds an implicit function inside its mesh, and requires the extensions', async () => {
  const { file, text } = await written({ levelSet: { function: sphere, boundingBoxOnly: true } }),
    [model] = elements(text, 'model'),
    [levelSet] = elements(text, 'v:levelset'),
    objects = elements(text, 'object'),
    [item] = elements(text, 'item');
  assert.equal(model['xmlns:i'], 'http://schemas.3mf.io/3dmanufacturing/implicit/2023/12');
  assert.equal(model.requiredextensions, 'v i');
  assert.equal(objects.length, 2);
  assert.equal(levelSet.meshid, objects[0].id);
  assert.equal(item.objectid, objects[1].id);
  assert.equal(levelSet.channel, 'shape');
  assert.equal(levelSet.meshbboxonly, 'true');
  assert.equal(levelSet.transform, undefined, 'a metre file of a Z-up scene samples the geometry coordinates');
  assert.ok(
    text.includes(
      '<i:length identifier="Length_3"><i:in><i:vectorref identifier="A" ref="inputs.pos"/></i:in>' +
        '<i:out><i:scalar identifier="result"/></i:out></i:length>',
    ),
  );
  assert.ok(text.includes('<i:constant identifier="radius" value="1.5"><i:out><i:scalar identifier="value"/></i:out>'));
  assert.ok(text.includes('<i:out><i:scalarref identifier="shape" ref="Subtraction_4.result"/></i:out>'));

  await assert.rejects(parse3MF(file), { code: 'unsupported', message: /parse3MFVolumetric/ });
  const read = await parse3MFVolumetric(file, { units: 'file' }),
    [f] = read.functions,
    [object] = read.objects;
  assert.equal(read.indices.length, 0);
  assert.deepEqual(f.inputs, [{ name: 'pos', type: 'vector' }]);
  assert.deepEqual(
    f.nodes.map((n) => [n.id, n.op]),
    [
      ['radius', 'constant'],
      ['Length_3', 'length'],
      ['Subtraction_4', 'subtraction'],
    ],
  );
  assert.deepEqual(f.nodes[0].attributes, { value: '1.5' });
  assert.deepEqual(f.outputs, [{ name: 'shape', type: 'scalar', ref: 'Subtraction_4.result' }]);
  assert.equal(object.levelSet.functionId, f.id);
  assert.equal(object.levelSet.boundingBoxOnly, true);
  assert.equal(object.levelSet.domain.indices.length, 36);
  assert.deepEqual([...object.instances[0]], [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
});

test('functions name meshes and other functions, defined first and in function coordinates', async () => {
  const outer = {
      nodes: [
        { id: 'shape', op: 'constresourceid', value: { name: 'cutter', geometry: box } },
        { id: 'near', op: 'mesh', in: { pos: 'inputs.pos', mesh: 'shape.value' } },
        { id: 'ball', op: 'constresourceid', value: sphere },
        { id: 'call', op: 'functioncall', in: { functionID: 'ball.value', pos: 'inputs.pos' } },
        { id: 'step', op: 'constant', value: 0.001 },
        {
          id: 'slope',
          op: 'functiongradient',
          scalarOutput: 'shape',
          vectorInput: 'pos',
          in: { functionID: 'ball.value', step: 'step.value', pos: 'inputs.pos' },
        },
        { id: 'both', op: 'max', in: { A: 'near.distance', B: 'call.shape' } },
        { id: 'unit', op: 'constmat', value: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
        { id: 'moved', op: 'matvecmultiplication', in: { A: 'unit.matrix', B: 'slope.vector' } },
        { id: 'size', op: 'length', in: { A: 'moved.result' } },
      ],
      outputs: { shape: 'both.result', size: 'size.result' },
    },
    { file, text } = await written({ levelSet: { function: outer, channel: 'shape' } }, { unit: 'millimeter' }),
    [model] = elements(text, 'model'),
    objects = elements(text, 'object'),
    resources = elements(text, 'i:constresourceid'),
    functions = elements(text, 'i:implicitfunction');
  assert.equal(model.requiredextensions, 'v i');
  assert.equal(resources[0].value, objects[0].id);
  assert.equal(resources[1].value, functions[0].id);
  assert.ok(text.indexOf('<object') < text.indexOf('<i:implicitfunction'), 'the mesh comes before its function');
  // The function's mesh keeps its own coordinates in a millimetre file; the domain mesh is in millimetres.
  assert.ok(text.slice(0, text.indexOf('<i:implicitfunction')).includes('<vertex x="3" y="6" z="11"/>'));
  assert.ok(text.includes('<vertex x="3000" y="6000" z="11000"/>'));
  assert.ok(text.includes('scalaroutput="shape" vectorinput="pos"'));
  assert.ok(text.includes('<i:resourceref identifier="functionID" ref="ball.value"/>'));
  const read = await parse3MFVolumetric(file);
  assert.equal(read.functions.length, 2);
  assert.deepEqual(
    read.functions[1].nodes.find((n) => n.op === 'functiongradient').outputs.map((o) => o.name),
    ['vector', 'gradient', 'magnitude'],
  );
});

test('graphs and fields the specification rules out are refused', async () => {
  const graph = (nodes, outputs = { shape: 'a.value' }) => ({ levelSet: { function: { nodes, outputs } } }),
    a = { id: 'a', op: 'constant', value: 1 },
    self = { nodes: [], outputs: { shape: 'me.value' } };
  self.nodes.push({ id: 'me', op: 'constresourceid', value: self });
  const bad = [
    [graph([{ ...a, op: 'warp' }]), /no implicit node/],
    [
      graph([
        { id: 'a', op: 'sin', in: { A: 'b.value' } },
        { ...a, id: 'b' },
      ]),
      /earlier node/,
    ],
    [graph([a, { id: 'b', op: 'length', in: { A: 'a.value' } }]), /vector input A/],
    [graph([a, a]), /used twice/],
    [graph([{ ...a, id: 'inputs' }]), /reserved/],
    [graph([a, { id: 'b', op: 'addition', in: { A: 'a.value', B: 'inputs.pos' } }]), /input B/],
    [graph([a], { shape: 'inputs.pos' }), /scalar output/],
    [{ levelSet: { function: self } }, /call themselves/],
    [{ volume: {} }, /color, a composite or a property/],
    [{ volume: { color: { function: sphere } } }, /vector output/],
    [{ volume: { color: { function: { image: { sheets: [png(2, 2), png(3, 2)] } } } } }, /share one size/],
    [{ volume: { color: { function: { image: { sheets: [new Uint8Array(40)] } } } } }, /PNG bytes/],
  ];
  for (const [info, message] of bad) await assert.rejects(written(info), { message });
  const two = { nodes: [0, 1].map((i) => ({ name: `n${i}`, geometry: box })) };
  await assert.rejects(export3MF(two, { objectInfo: () => ({ volume: { color: { function: sampler } } }) }), {
    message: /node's own object/,
  });
});

/** A package of a hand-written root model part. */
const packaged = (resources, build, extra = []) =>
  encodeZIP([
    {
      name: ROOT,
      data: new TextEncoder().encode(
        '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ' +
          'xmlns:v="http://schemas.3mf.io/3dmanufacturing/volumetric/2022/01" ' +
          'xmlns:i="http://schemas.3mf.io/3dmanufacturing/implicit/2023/12">' +
          `<resources>${resources}</resources><build>${build}</build></model>`,
      ),
    },
    ...extra,
  ]);
const tetrahedron =
  '<mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>' +
  '<vertex x="0" y="0" z="1"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/>' +
  '<triangle v1="1" v2="2" v3="3"/><triangle v1="0" v2="3" v3="2"/></triangles></mesh>';

test("the specification's example reads, and broken references are refused", async () => {
  // Chapter 2.2's example, with the property name qualified as chapter 5.2.4 requires.
  const resources =
      '<v:image3d id="2"><v:imagestack rowcount="2" columncount="3" sheetcount="1">' +
      '<v:imagesheet path="/volume/layer_01.png"/></v:imagestack></v:image3d>' +
      '<v:functionfromimage3d id="3" displayname="function from image3d" image3did="2" valueoffset="0" ' +
      'valuescale="1400" tilestyleu="wrap" tilestylev="clamp" tilestylew="mirror" filter="linear"/>' +
      '<v:volumedata id="4"><v:property name="v:Temp" transform="0.01 0 0 0 0.01 0 0 0 0.01 0.5 0.5 0.5" ' +
      'functionid="3" channel="red"/></v:volumedata>' +
      // A volumeid without the prefix, as the example writes it.
      `<object id="5">${tetrahedron.replace('<mesh>', '<mesh volumeid="4">')}</object>`,
    sheet = [{ name: 'volume/layer_01.png', data: png(3, 2) }],
    read = await parse3MFVolumetric(await packaged(resources, '<item objectid="5"/>', sheet));
  assert.deepEqual(read.functions[0].tile, ['wrap', 'clamp', 'mirror']);
  assert.equal(read.functions[0].scale, 1400);
  assert.equal(read.volumes[0].properties[0].required, false);
  assert.equal(read.objects[0].volumeId, '4');
  // The instance is in the result's units, metres.
  assert.deepEqual([...read.objects[0].instances[0]], [0.001, 0, 0, 0, 0.001, 0, 0, 0, 0.001, 0, 0, 0]);
  const broken = [
    [resources.replace('image3did="2"', 'image3did="9"'), /not defined before/],
    [resources.replace('functionid="3"', 'functionid="9"'), /not defined/],
    [resources.replace('channel="red"', 'channel="heat"'), /no .* output heat/],
    [resources.replace('sheetcount="1"', 'sheetcount="2"'), /sheetcount/],
    [resources.replace('volumeid="4"', 'volumeid="3"'), /not defined before its mesh/],
    [
      resources +
        '<i:implicitfunction id="7"><i:in/><i:sin identifier="a"><i:in><i:scalarref identifier="A" ref="b.result"/>' +
        '</i:in><i:out><i:scalar identifier="result"/></i:out></i:sin><i:out/></i:implicitfunction>',
      /not an earlier scalar output/,
    ],
  ];
  for (const [text, message] of broken)
    await assert.rejects(parse3MFVolumetric(await packaged(text, '<item objectid="5"/>', sheet)), { message });
  await assert.rejects(parse3MFVolumetric(await packaged(resources, '<item objectid="5"/>')), { message: /missing/ });
});
