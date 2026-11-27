// export3MF's beam lattices, by the 3MF Beam Lattice Extension specification
// (https://github.com/3MFConsortium/spec_beamlattice), read back through `parse3MFLattice`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readZipDirectory, readZipEntry } from '@margoengine/loaders';
import { parse3MFLattice } from '@margoengine/loaders/threemf-lattice';
import { export3MF } from '@margoengine/exporters/threemf';

const corners = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
const faces = [
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
];
const box = {
  positions: new Float32Array(corners),
  normals: new Float32Array(corners.length),
  indices: new Uint32Array(faces),
};
/** A node of a lattice alone: vertices and no triangle. */
const empty = { positions: new Float32Array(3), indices: new Uint32Array() };
/** Three struts from one corner. */
const frame = {
  positions: [0, 0, 0, 0.01, 0, 0, 0, 0.02, 0, 0, 0, 0.03],
  beams: [
    { v1: 0, v2: 1 },
    { v1: 0, v2: 2, r1: 0.002 },
    { v1: 0, v2: 3, r2: 0.0005, cap1: 'butt', cap2: 'hemisphere' },
  ],
  radius: 0.001,
};
const attributes = (tag) => Object.fromEntries([...tag.matchAll(/([\w:]+)="([^"]*)"/g)].map(([, k, v]) => [k, v]));
const elements = (text, name) =>
  [...text.matchAll(new RegExp(`<${name}((?: [^>]*?)?)/?>`, 'g'))].map((m) => attributes(m[1]));
const document = async (file) => {
  const entry = readZipDirectory(file).find((e) => e.name === '3D/3dmodel.model');
  return new TextDecoder().decode(await readZipEntry(file, entry));
};
const written = async (lattice, options = {}, geometry = empty) => {
  const warnings = [],
    file = await export3MF(
      { nodes: [{ name: 'frame', geometry }] },
      { upAxis: 'z', onWarning: (w) => warnings.push(w.message), objectInfo: () => ({ lattice }), ...options },
    );
  return { file, text: await document(file), warnings, read: await parse3MFLattice(file) };
};
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('a lattice with no triangles is an object of beams, which reads back in file units', async () => {
  const { text, read, warnings } = await written(frame),
    [model] = elements(text, 'model'),
    [lattice] = elements(text, 'b:beamlattice');
  assert.deepEqual(warnings, []);
  assert.equal(model['xmlns:b'], 'http://schemas.microsoft.com/3dmanufacturing/beamlattice/2017/02');
  assert.equal(model.requiredextensions, 'b');
  assert.equal(model['xmlns:b2'], undefined);
  assert.equal(elements(text, 'triangle').length, 0);
  // Metres to millimetres, with the specification's defaults: sphere caps, no balls, r2 following r1.
  assert.deepEqual([lattice.radius, lattice.minlength, lattice.cap], ['1', '0.0001', 'sphere']);
  const [object] = read.objects,
    { beams, ballMode, clippingMode } = object.lattice;
  assert.deepEqual([...object.vertices], [0, 0, 0, 10, 0, 0, 0, 20, 0, 0, 0, 30].map(Math.fround));
  assert.equal(ballMode, 'none');
  assert.equal(clippingMode, 'none');
  assert.deepEqual(
    beams.map((b) => [b.v1, b.v2, b.r1, b.r2, b.cap1, b.cap2]),
    [
      [0, 1, 1, 1, 'sphere', 'sphere'],
      [0, 2, 2, 2, 'sphere', 'sphere'],
      [0, 3, 1, 0.5, 'butt', 'hemisphere'],
    ],
  );
  // A second radius takes a first one in the file.
  assert.equal(elements(text, 'b:beam')[2].r1, '1');
  assert.equal(read.instances.length, 1);
});

test('lattice points follow the mesh vertices, and balls, sets and colours read back', async () => {
  const { text, read } = await written(
      {
        ...frame,
        beams: [{ v1: 0, v2: 1, color: ['#ff0000', '#0000FF'] }, { v1: 0, v2: 2, color: '#00FF00' }, frame.beams[2]],
        ballMode: 'mixed',
        ballRadius: 0.002,
        balls: [{ vertex: 0, radius: 0.004, color: '#FF0000' }, { vertex: 1 }],
        sets: [{ name: 'struts <1>', identifier: 'S1', beams: [0, 2], balls: [1] }],
      },
      {},
      box,
    ),
    [model] = elements(text, 'model'),
    [group] = elements(text, 'm:colorgroup'),
    [object] = read.objects,
    { beams, balls, sets, effectiveBalls } = object.lattice;
  assert.equal(model.requiredextensions, 'b b2');
  assert.equal(object.triangles.length, 36);
  assert.equal(object.vertices.length / 3, 12);
  assert.deepEqual(
    elements(text, 'm:color').map((c) => c.color),
    ['#FF0000', '#0000FF', '#00FF00'],
  );
  assert.deepEqual(
    beams.map((b) => [b.v1, b.v2]),
    [
      [8, 9],
      [8, 10],
      [8, 11],
    ],
  );
  assert.deepEqual(
    beams.slice(0, 2).map((b) => [b.pid, b.p1, b.p2]),
    [
      [group.id, 0, 1],
      [group.id, 2, 2],
    ],
  );
  assert.deepEqual(
    balls.map((b) => [b.vertex, b.radius, b.property]),
    [
      [8, 4, 0],
      // A ball without a colour takes the object's own property (section 2.1).
      [9, 2, 0],
    ],
  );
  assert.equal(effectiveBalls.length, 2);
  assert.deepEqual(
    [sets[0].name, sets[0].identifier, [...sets[0].beams], [...sets[0].balls]],
    ['struts <1>', 'S1', [0, 2], [1]],
  );
  // The colour group comes before the object that names it.
  assert.ok(text.indexOf('<m:colorgroup') < text.indexOf('<object'));
});

test("ballmode 'all' puts a ball at every beam end", async () => {
  const { read } = await written({ ...frame, ballMode: 'all', ballRadius: 0.0015 });
  const { effectiveBalls, balls } = read.objects[0].lattice;
  assert.equal(balls.length, 0);
  assert.equal(effectiveBalls.length, 4);
  for (const ball of effectiveBalls) close(ball.radius, 1.5);
});

test('clipping and representation meshes are earlier objects of the same part, outside the build', async () => {
  const { text, read } = await written(
      {
        ...frame,
        clipping: { mode: 'inside', mesh: { name: 'envelope', geometry: box, scale: [0.02, 0.02, 0.02] } },
        representation: { name: 'preview', geometry: box, scale: [0.01, 0.02, 0.03] },
      },
      { production: { separateParts: true } },
    ),
    objects = elements(text, 'object'),
    [lattice] = elements(text, 'b:beamlattice'),
    [model] = elements(text, 'model');
  assert.deepEqual(
    objects.map((o) => o.name),
    ['envelope', 'preview', 'frame'],
  );
  assert.equal(lattice.clippingmode, 'inside');
  assert.equal(lattice.clippingmesh, objects[0].id);
  assert.equal(lattice.representationmesh, objects[1].id);
  // The lattice stays in the root part with the meshes it names, so no part refers to another.
  assert.equal(model.requiredextensions, 'b');
  assert.deepEqual(
    elements(text, 'item').map((i) => i.objectid),
    [objects[2].id],
  );
  assert.equal(read.instances.length, 1);
  assert.equal(Math.max(...read.objects[0].vertices), 20);
});

test('a mirrored node mirrors its lattice, and nodes of one lattice share its object', async () => {
  const lattice = frame,
    file = await export3MF(
      {
        nodes: [
          { name: 'a', geometry: empty },
          { name: 'b', geometry: empty, translation: [1, 0, 0] },
          { name: 'c', geometry: empty, scale: [-1, 1, 1] },
        ],
      },
      { upAxis: 'z', assembly: false, objectInfo: () => ({ lattice }) },
    ),
    read = await parse3MFLattice(file);
  assert.equal(read.objects.length, 2);
  assert.equal(read.instances.length, 3);
  assert.equal(read.instances[0].object, read.instances[1].object);
  assert.deepEqual([...read.objects[1].vertices].slice(3, 6), [-10, 0, 0]);
});

test('lattices the extension would reject are refused', async () => {
  const refused = (lattice, options = {}) => assert.rejects(written(lattice, options), RangeError);
  await refused({ ...frame, beams: [] });
  await refused({ ...frame, beams: [{ v1: 0, v2: 4 }] });
  await refused({ ...frame, beams: [{ v1: 1, v2: 1 }] });
  await refused({ ...frame, positions: [0, 0, 0, 0, 0, 0], beams: [{ v1: 0, v2: 1 }] });
  await refused({ ...frame, radius: 0 });
  await refused({ ...frame, beams: [{ v1: 0, v2: 1, r1: -1 }] });
  await refused({ ...frame, cap: 'flat' });
  await refused({ ...frame, ballMode: 'all' });
  await refused({ ...frame, balls: [{ vertex: 0 }] });
  await refused({ ...frame, ballRadius: 1, balls: [{ vertex: 0 }, { vertex: 0 }] });
  await refused({ ...frame, beams: [{ v1: 0, v2: 1 }], ballRadius: 1, balls: [{ vertex: 2 }] });
  await refused({ ...frame, sets: [{ beams: [3] }] });
  await refused({ ...frame, sets: [{ identifier: 'a' }, { identifier: 'a' }] });
  await refused({ ...frame, beams: [{ v1: 0, v2: 1, color: 'red' }] });
  await refused({ ...frame, clipping: { mode: 'both', mesh: { geometry: box } } });
  await refused(frame, { objectInfo: () => ({ type: 'support', lattice: frame }) });
  await assert.rejects(
    export3MF({ nodes: [{ geometry: empty }, { geometry: box }] }, { objectInfo: () => ({ lattice: frame }) }),
    RangeError,
  );
});
