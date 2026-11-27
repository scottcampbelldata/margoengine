// parse3MFVolumetric's level sets and function graphs against the 3MF Volumetric and Implicit Extensions specification
// (https://github.com/3MFConsortium/spec_volumetric): inside is below zero within the domain mesh (chapter 4), image
// stacks sample by their voxel centres, tiles and filters (sections 2.2 and 3.2), and the native nodes (implicit
// chapter 5) with undefined results taking the fallback value (6.2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse3MFVolumetric } from '../dist/threemf-volumetric.js';
import { compileField } from '../dist/threemf-functions.js';
import { box, closed, grey, meshXML, volume, zip } from './threemf-surface.js';

const NS =
  'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:v="http://schemas.3mf.io/3dmanufacturing/volumetric/2022/01" xmlns:i="http://schemas.3mf.io/3dmanufacturing/implicit/2023/12"';
const file = { units: 'file' };
const near = (actual, expected, tolerance) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not ${expected} within ${tolerance}`);

const port = (kind, name, ref) =>
  ref ? `<i:${kind}ref identifier="${name}" ref="${ref}"/>` : `<i:${kind} identifier="${name}"/>`;
const node = (op, id, inputs, outputs, attributes = '') =>
  `<i:${op} identifier="${id}" ${attributes}><i:in>${inputs.map((p) => port(...p)).join('')}</i:in><i:out>${outputs
    .map((p) => port(...p))
    .join('')}</i:out></i:${op}>`;
const implicit = (id, nodes, result, inputs = [['vector', 'pos']]) =>
  `<i:implicitfunction id="${id}"><i:in>${inputs.map((p) => port(...p)).join('')}</i:in>${nodes}<i:out>${port('scalar', 'shape', result)}</i:out></i:implicitfunction>`;
/** length(pos) - radius. */
const sphere = (id, radius) =>
  implicit(
    id,
    node('length', 'far', [['vector', 'A', 'inputs.pos']], [['scalar', 'result']]) +
      node('constant', 'r', [], [['scalar', 'value']], `value="${radius}"`) +
      node(
        'subtraction',
        'd',
        [
          ['scalar', 'A', 'far.result'],
          ['scalar', 'B', 'r.value'],
        ],
        [['scalar', 'result']],
      ),
    'd.result',
  );

/** A package of functions and one built level set over the domain mesh. */
function pack(
  resources,
  { domain = box([-5, -5, -5], [5, 5, 5]), attributes = '', fn = 3, channel = 'shape' } = {},
  extra = {},
) {
  const xml = `<model unit="millimeter" ${NS} requiredextensions="v i"><resources>${resources}<object id="8" type="model">${meshXML(
    domain,
  )}</object><object id="9" type="model"><v:levelset functionid="${fn}" channel="${channel}" meshid="8" ${attributes}/></object></resources><build><item objectid="9"/></build></model>`;
  return zip({ '3D/3dmodel.model': xml, ...extra });
}

test('a level set is the surface where its function is zero, inside below zero', async () => {
  const read = await parse3MFVolumetric(pack(sphere(3, 4)), file),
    [object] = read.objects;
  closed(read);
  near(volume(read), (4 / 3) * Math.PI * 4 ** 3, 1);
  for (let v = 0; v < read.positions.length; v += 3) near(Math.hypot(...read.positions.subarray(v, v + 3)), 4, 1e-3);
  // 64 cells along the 10 mm domain, rounded down to a power of two.
  assert.equal(object.levelSet.cellSize, 0.125);
  assert.equal(object.levelSet.unresolved, false);
  const coarse = await parse3MFVolumetric(pack(sphere(3, 4)), { ...file, levelSetResolution: 8 });
  assert.ok(coarse.indices.length < read.indices.length / 8);
  closed(coarse);
  const fine = await parse3MFVolumetric(pack(sphere(3, 4), { attributes: 'minfeaturesize="0.1"' }), file);
  assert.equal(fine.objects[0].levelSet.cellSize, 0.03125);
  closed(fine);
  const unmeshed = await parse3MFVolumetric(pack(sphere(3, 4)), { ...file, meshLevelSets: false });
  assert.equal(unmeshed.indices.length, 0);
  await assert.rejects(parse3MFVolumetric(pack(sphere(3, 4)), { maxTriangles: 100 }), { code: 'limit' });
  await assert.rejects(parse3MFVolumetric(pack(sphere(3, 4)), { levelSetResolution: 1 }), { code: 'range' });
});

test('the domain mesh or its box cuts the surface, and the transform leads to function coordinates', async () => {
  // Everything is inside: the domain itself comes out. A tetrahedron of legs 8, then its box.
  const everywhere = implicit(3, node('constant', 'c', [], [['scalar', 'value']], 'value="-1"'), 'c.value'),
    tetrahedron = {
      vertices: [
        [0, 0, 0],
        [8, 0, 0],
        [0, 8, 0],
        [0, 0, 8],
      ],
      triangles: [
        [0, 2, 1],
        [0, 1, 3],
        [1, 2, 3],
        [0, 3, 2],
      ],
    },
    cut = await parse3MFVolumetric(pack(everywhere, { domain: tetrahedron }), file),
    boxed = await parse3MFVolumetric(
      pack(everywhere, { domain: tetrahedron, attributes: 'meshbboxonly="true"' }),
      file,
    );
  closed(cut);
  closed(boxed);
  near(volume(cut), 512 / 6, 1.5);
  near(volume(boxed), 512, 1);
  // The function sees T * p: a sphere of radius 2 at the function's origin sits at object x = -1, scaled by one half.
  const moved = await parse3MFVolumetric(
    pack(sphere(3, 2), { attributes: 'transform="2 0 0 0 2 0 0 0 2 2 0 0"' }),
    file,
  );
  near(volume(moved), (4 / 3) * Math.PI, 0.1);
  for (let v = 0; v < moved.positions.length; v += 3) {
    const [x, y, z] = moved.positions.subarray(v, v + 3);
    near(Math.hypot(x + 1, y, z), 1, 1e-2);
  }
});

test('an image stack samples with u along columns, v up the rows and w along sheets', async () => {
  const stack = (sheets) =>
      `<v:image3d id="1"><v:imagestack rowcount="2" columncount="2" sheetcount="2">${sheets
        .map((_, i) => `<v:imagesheet path="/3D/volumetric/s${i}.png"/>`)
        .join(
          '',
        )}</v:imagestack></v:image3d><v:functionfromimage3d id="3" image3did="1" tilestyleu="clamp" tilestylev="clamp" tilestylew="clamp" valuescale="10" valueoffset="-5"/>`,
    dark = [
      [0, 0],
      [0, 0],
    ],
    light = [
      [255, 255],
      [255, 255],
    ],
    columns = [
      [0, 255],
      [0, 255],
    ],
    rows = [
      [255, 255],
      [0, 0],
    ];
  // Object -5..5 to texture 0..1.
  const attributes = 'transform="0.1 0 0 0 0.1 0 0 0 0.1 0.5 0.5 0.5"';
  for (const [sheets, axis] of [
    [[columns, columns], 0],
    [[rows, rows], 1],
    [[dark, light], 2],
  ]) {
    const files = Object.fromEntries(sheets.map((s, i) => [`3D/volumetric/s${i}.png`, grey(s)])),
      read = await parse3MFVolumetric(pack(stack(sheets), { attributes, channel: 'red' }, files), file);
    closed(read);
    // The value crosses 5 / 10 halfway between the voxel centres: the half of the box below zero on that axis.
    near(volume(read), 500, 2);
    let low = Infinity,
      high = -Infinity;
    for (let v = 0; v < read.positions.length; v += 3) {
      low = Math.min(low, read.positions[v + axis]);
      high = Math.max(high, read.positions[v + axis]);
    }
    near(low, -5, 0.2);
    near(high, 0, 1e-3);
  }
});

test('a mesh node gives the signed distance and an undefined value takes the fallback', async () => {
  // distance(pos, cube of side 4) - 1: the cube grown by one, its edges and corners rounded.
  const grown = implicit(
      3,
      node('constresourceid', 'which', [], [['resourceid', 'value']], 'value="7"') +
        node(
          'mesh',
          'far',
          [
            ['vector', 'pos', 'inputs.pos'],
            ['resource', 'mesh', 'which.value'],
          ],
          [['scalar', 'distance']],
        ) +
        node('constant', 'r', [], [['scalar', 'value']], 'value="1"') +
        node(
          'subtraction',
          'd',
          [
            ['scalar', 'A', 'far.distance'],
            ['scalar', 'B', 'r.value'],
          ],
          [['scalar', 'result']],
        ),
      'd.result',
    ),
    cube = `<object id="7" type="model">${meshXML(box([-2, -2, -2], [2, 2, 2]))}</object>`,
    read = await parse3MFVolumetric(pack(cube + grown), file);
  closed(read);
  near(volume(read), 64 + 6 * 16 + 3 * Math.PI * 4 + (4 / 3) * Math.PI, 1);
  // sqrt(x) is undefined for x below zero: with fallback 1 that half is outside, and inside where sqrt(x) - 1 < 0.
  const root = implicit(
    3,
    node('decomposevector', 'p', [['vector', 'A', 'inputs.pos']], [['scalar', 'x']]) +
      node('sqrt', 's', [['scalar', 'A', 'p.x']], [['scalar', 'result']]) +
      node('constant', 'one', [], [['scalar', 'value']], 'value="1"') +
      node(
        'subtraction',
        'd',
        [
          ['scalar', 'A', 's.result'],
          ['scalar', 'B', 'one.value'],
        ],
        [['scalar', 'result']],
      ),
    'd.result',
  );
  const slab = await parse3MFVolumetric(pack(root, { attributes: 'fallbackvalue="1"' }), file);
  near(volume(slab), 100, 3);
  await assert.rejects(
    parse3MFVolumetric(pack(implicit(3, node('beamlattice', 'b', [], [['scalar', 'distance']]), 'b.distance')), file),
    { code: 'unsupported' },
  );
});

/** A function object as the reader returns it, from `[op, id, { input: ref }, { output: type }, attributes]`. */
const graph = (id, inputs, nodes, outputs) => ({
  id,
  kind: 'implicit',
  inputs: Object.entries(inputs).map(([name, type]) => ({ name, type })),
  nodes: nodes.map(([op, name, from = {}, to = { result: 'scalar' }, attributes = {}]) => ({
    id: name,
    op,
    attributes,
    inputs: Object.entries(from).map(([n, ref]) => ({ name: n, type: 'scalar', ref })),
    outputs: Object.entries(to).map(([n, type]) => ({ name: n, type })),
  })),
  outputs: Object.entries(outputs).map(([name, ref]) => ({ name, type: 'scalar', ref })),
});
const evaluate = (functions, id, inputs) => {
  const scope = { functions: new Map(functions.map((f) => [f.id, f])) },
    buffers = new Map(Object.entries(inputs).map(([k, v]) => [k, Float64Array.from(v)])),
    program = compileField(scope, id, buffers);
  program.run();
  return Object.fromEntries([...program.outputs].map(([k, v]) => [k, [...v]]));
};
const vector = { vector: 'vector' },
  matrix = { matrix: 'matrix' },
  value = { value: 'scalar' };

test('native nodes compute what the specification names', () => {
  const binary = (op) => [op, op, { A: 'inputs.a', B: 'inputs.b' }];
  const names = ['fmod', 'mod', 'atan2', 'min', 'max', 'pow', 'division', 'multiplication'];
  const two = graph(
    '1',
    { a: 'scalar', b: 'scalar' },
    [...names.map(binary), ['select', 'pick', { A: 'inputs.a', B: 'inputs.b', C: 'min.result', D: 'max.result' }]],
    Object.fromEntries([...names, 'pick'].map((n) => [n, `${n}.result`])),
  );
  const r = evaluate([two], '1', { a: [-7], b: [3] });
  // fmod truncates and keeps the dividend's sign; mod floors.
  assert.deepEqual(
    [r.fmod, r.mod, r.min, r.max, r.multiplication, r.pick].map((v) => v[0]),
    [-1, 2, -7, 3, -21, -7],
  );
  near(r.pow[0], -343, 1e-9);
  near(r.atan2[0], Math.atan2(-7, 3), 1e-12);
  assert.ok(Number.isNaN(evaluate([two], '1', { a: [1], b: [0] }).division[0]), 'a division by zero is undefined');
  assert.ok(Number.isNaN(evaluate([two], '1', { a: [NaN], b: [0] }).pow[0]));
  const columns = graph(
    '2',
    { pos: 'vector' },
    [
      ['constvec', 'x', {}, vector, { x: '0', y: '2', z: '0' }],
      ['constvec', 'y', {}, vector, { x: '-2', y: '0', z: '0' }],
      ['constvec', 'z', {}, vector, { x: '0', y: '0', z: '4' }],
      ['constvec', 't', {}, vector, { x: '1', y: '2', z: '3' }],
      ['matrixfromcolumns', 'm', { A: 'x.vector', B: 'y.vector', C: 'z.vector', D: 't.vector' }, matrix],
      ['matrixvectormultiplication', 'moved', { A: 'm.matrix', B: 'inputs.pos' }, { result: 'vector' }],
      ['inverse', 'i', { A: 'm.matrix' }, { result: 'matrix' }],
      ['matrixvectormultiplication', 'back', { A: 'i.result', B: 'moved.result' }, { result: 'vector' }],
      ['transpose', 'tr', { A: 'm.matrix' }, { result: 'matrix' }],
      ['matrixfromrows', 'rows', { A: 'x.vector', B: 'y.vector', C: 'z.vector', D: 't.vector' }, matrix],
      ['matrixvectormultiplication', 'row', { A: 'rows.matrix', B: 'inputs.pos' }, { result: 'vector' }],
      ['cross', 'c', { A: 'x.vector', B: 'y.vector' }, { result: 'vector' }],
      ['dot', 'dt', { A: 't.vector', B: 'inputs.pos' }],
    ],
    {
      moved: 'moved.result',
      back: 'back.result',
      row: 'row.result',
      tr: 'tr.result',
      cross: 'c.result',
      dot: 'dt.result',
    },
  );
  const m = evaluate([columns], '2', { pos: [1, 1, 1] });
  assert.deepEqual(m.moved, [-1, 4, 7]);
  m.back.forEach((v) => near(v, 1, 1e-12));
  // The fourth column of a matrix from rows is (0, 0, 0, 1).
  assert.deepEqual(m.row, [2, -2, 4]);
  assert.deepEqual(m.tr.slice(0, 8), [0, 2, 0, 0, -2, 0, 0, 0]);
  assert.deepEqual([m.cross.map((v) => v + 0), m.dot], [[0, 0, 4], [6]]);
});

test('called functions, gradients and normalized distances differentiate by central differences', () => {
  // f(pos, k) = k |pos|^2, called, differentiated and normalized.
  const f = graph(
      '1',
      { pos: 'vector', k: 'scalar' },
      [
        ['dot', 'q', { A: 'inputs.pos', B: 'inputs.pos' }],
        ['multiplication', 'm', { A: 'q.result', B: 'inputs.k' }],
      ],
      { f: 'm.result' },
    ),
    g = graph(
      '2',
      { pos: 'vector' },
      [
        ['constresourceid', 'id', {}, { value: 'resourceid' }, { value: '1' }],
        ['constant', 'k', {}, value, { value: '2' }],
        ['constant', 'h', {}, value, { value: '0.001' }],
        ['functioncall', 'call', { functionID: 'id.value', pos: 'inputs.pos', k: 'k.value' }, { f: 'scalar' }],
        [
          'functiongradient',
          'grad',
          { functionID: 'id.value', pos: 'inputs.pos', k: 'k.value', step: 'h.value' },
          { vector: 'vector', gradient: 'vector', magnitude: 'scalar' },
          { scalaroutput: 'f', vectorinput: 'pos' },
        ],
        [
          'normalizedistance',
          'n',
          { functionID: 'id.value', pos: 'inputs.pos', k: 'k.value', step: 'h.value' },
          { result: 'scalar' },
          { scalaroutput: 'f', vectorinput: 'pos' },
        ],
      ],
      {
        call: 'call.f',
        gradient: 'grad.gradient',
        direction: 'grad.vector',
        magnitude: 'grad.magnitude',
        normalized: 'n.result',
      },
    );
  const r = evaluate([f, g], '2', { pos: [3, 0, 4] });
  assert.equal(r.call[0], 50);
  [12, 0, 16].forEach((v, i) => near(r.gradient[i], v, 1e-6));
  [0.6, 0, 0.8].forEach((v, i) => near(r.direction[i], v, 1e-6));
  near(r.magnitude[0], 20, 1e-6);
  near(r.normalized[0], 2.5, 1e-6);
  const loop = graph(
    '1',
    { pos: 'vector' },
    [
      ['constresourceid', 'id', {}, { value: 'resourceid' }, { value: '2' }],
      ['functioncall', 'call', { functionID: 'id.value', pos: 'inputs.pos' }, { call: 'scalar' }],
    ],
    {},
  );
  assert.throws(() => evaluate([loop, g], '1', { pos: [0, 0, 0] }), /calls itself|without its|has no/);
});
