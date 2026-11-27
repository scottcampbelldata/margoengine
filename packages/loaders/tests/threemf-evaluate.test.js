// parse3MFEvaluated on packages that mix the 3MF extensions, and the pieces it adds: a boolean whose base is another
// extension's shape (https://github.com/3MFConsortium/spec_booleans, chapter 2), beam lattices as triangles with their
// clipping and properties (spec_beamlattice, chapter 2), the volumetric beamlattice node, and volume colour on the
// surface, which a surface property overrides (spec_volumetric, section 5.2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse3MFBoolean } from '../dist/threemf-boolean.js';
import { parse3MFEvaluated } from '../dist/threemf-evaluate.js';
import { parse3MFVolumetric } from '../dist/threemf-volumetric.js';
import { box, closed, grey, meshXML, vertexXML, volume, zip } from './threemf-surface.js';

const NS = [
  'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"',
  'xmlns:v="http://schemas.3mf.io/3dmanufacturing/volumetric/2022/01"',
  'xmlns:i="http://schemas.3mf.io/3dmanufacturing/implicit/2023/12"',
  'xmlns:bo="http://schemas.3mf.io/3dmanufacturing/booleanoperations/2023/07"',
  'xmlns:b="http://schemas.microsoft.com/3dmanufacturing/beamlattice/2017/02"',
  'xmlns:d="http://schemas.3mf.io/3dmanufacturing/displacement/2023/10"',
].join(' ');
const file = { units: 'file' };
const near = (actual, expected, tolerance) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not ${expected} within ${tolerance}`);
const pack = (resources, items, extra = {}) =>
  zip({
    '3D/3dmodel.model': `<model unit="millimeter" ${NS} requiredextensions="v i bo b d"><resources>${resources}</resources><build>${items
      .map((id) => `<item objectid="${id}"/>`)
      .join('')}</build></model>`,
    ...extra,
  });
const object = (id, content, attributes = '') => `<object id="${id}" type="model" ${attributes}>${content}</object>`;
const solid = (id, low, high, attributes = '') => object(id, meshXML(box(low, high)), attributes);
const cut = (id, base, operand, operation = 'difference') =>
  object(
    id,
    `<bo:booleanshape objectid="${base}" operation="${operation}"><bo:boolean objectid="${operand}"/></bo:booleanshape>`,
  );

const port = (kind, name, ref) =>
  ref ? `<i:${kind}ref identifier="${name}" ref="${ref}"/>` : `<i:${kind} identifier="${name}"/>`;
const node = (op, id, inputs, outputs, attributes = '') =>
  `<i:${op} identifier="${id}" ${attributes}><i:in>${inputs.map((p) => port(...p)).join('')}</i:in><i:out>${outputs
    .map((p) => port(...p))
    .join('')}</i:out></i:${op}>`;
const implicit = (id, nodes, [type, name, ref]) =>
  `<i:implicitfunction id="${id}"><i:in>${port('vector', 'pos')}</i:in>${nodes}<i:out>${port(type, name, ref)}</i:out></i:implicitfunction>`;
/** length(pos) - radius. */
const ball = (id, radius) =>
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
    ['scalar', 'shape', 'd.result'],
  );
const levelSet = (id, fn, domain, attributes = '') =>
  object(id, `<v:levelset functionid="${fn}" channel="shape" meshid="${domain}" ${attributes}/>`);

/** A mesh object of the two points, a beam between them, and what the lattice says. */
const strut = (id, { from = [0, 0, 0], to = [10, 0, 0], lattice = '', beam = '', attributes = '', balls = '' } = {}) =>
  object(
    id,
    `<mesh><vertices>${vertexXML([from, to])}</vertices><triangles/><b:beamlattice radius="1" minlength="0.1" cap="butt" ${lattice}><b:beams><b:beam v1="0" v2="1" ${beam}/></b:beams>${balls}</b:beamlattice></mesh>`,
    attributes,
  );
/** The cross-section of a beam of radius 1 with 16 sides. */
const SECTION = 8 * Math.sin(Math.PI / 8);

/** The coordinates on `axis` of the corners of the triangles, in order. */
const sorted = (mesh, axis) => [...mesh.indices].map((v) => mesh.positions[v * 3 + axis]).sort((a, b) => a - b);

test('a boolean cuts a level set', async () => {
  const input = pack(
      ball(3, 4) +
        solid(8, [-5, -5, -5], [5, 5, 5]) +
        levelSet(9, 3, 8) +
        solid(7, [0, -9, -9], [9, 9, 9]) +
        cut(10, 9, 7),
      [10],
    ),
    read = await parse3MFEvaluated(input, { ...file, levelSetResolution: 24 });
  closed(read);
  near(volume(read), (2 / 3) * Math.PI * 64, 3);
  near(sorted(read, 0).at(-1), 0, 1e-5);
  assert.equal(read.shapes[0].operation, 'difference');
  assert.ok(read.shapes[0].base.mesh.indices.length > 100);
  await assert.rejects(parse3MFBoolean(input, file), { code: 'unsupported', message: /parse3MFEvaluated/ });
});

/** A cube of side 10 whose top is displaced up by 0.2 * 4 + 1 = 1.8 along +z. */
function displaced() {
  const cube = box([0, 0, 0], [10, 10, 10]),
    coords = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    triangles = cube.triangles
      .map(([a, b, c], t) => {
        const d = t === 2 ? ' did="22" d1="0" d2="1" d3="2"' : t === 3 ? ' did="22" d1="0" d2="2" d3="3"' : '';
        return `<d:triangle v1="${a}" v2="${b}" v3="${c}"${d}/>`;
      })
      .join('');
  return `<d:displacement2d id="20" path="/3D/Textures/map.png"/><d:normvectorgroup id="21"><d:normvector x="0" y="0" z="1"/></d:normvectorgroup><d:disp2dgroup id="22" dispid="20" nid="21" height="4" offset="1">${coords
    .map(([u, v]) => `<d:disp2dcoord u="${u}" v="${v}" n="0"/>`)
    .join('')}</d:disp2dgroup>${object(
    23,
    `<d:displacementmesh><d:vertices>${vertexXML(cube.vertices, 'd:')}</d:vertices><d:triangles>${triangles}</d:triangles></d:displacementmesh>`,
  )}`;
}
const map = {
  '3D/Textures/map.png': grey([
    [51, 51, 51, 51],
    [51, 51, 51, 51],
  ]),
};

test('a boolean cuts a displacement mesh', async () => {
  const input = pack(displaced() + solid(7, [4.3, -1, -1], [20, 20, 20]) + cut(10, 23, 7), [10], map),
    read = await parse3MFEvaluated(input, file);
  closed(read);
  near(volume(read), 4.3 * 10 * 11.8, 0.01);
  assert.equal(read.meshes.length, 0, 'the displacement mesh is built only through the boolean');
  await assert.rejects(parse3MFBoolean(input, file), { code: 'unsupported', message: /parse3MFEvaluated/ });
});

test('a lattice becomes triangles, and a boolean cuts it', async () => {
  const whole = await parse3MFEvaluated(pack(strut(4), [4]), file);
  closed(whole);
  near(volume(whole), SECTION * 10, 1e-3);
  assert.equal(whole.lattices[0].objectId, '4');
  assert.equal(whole.lattices[0].lattice.activeBeams.length, 1);
  const fine = await parse3MFEvaluated(pack(strut(4), [4]), { ...file, beamSegments: 128 });
  near(volume(fine), Math.PI * 10, 0.02);
  const halved = await parse3MFEvaluated(
    pack(strut(4) + solid(7, [4, -5, -5], [20, 5, 5]) + cut(10, 4, 7), [10]),
    file,
  );
  closed(halved);
  near(volume(halved), SECTION * 4, 1e-3);
  // A mesh with a lattice is the union of both: a cube of side 4 around the beam's start, cut away from x = 3.
  const joined = object(
      4,
      `<mesh><vertices>${vertexXML(box([-2, -2, -2], [2, 2, 2]).vertices)}${vertexXML([
        [0, 0, 0],
        [10, 0, 0],
      ])}</vertices><triangles>${box([-2, -2, -2], [2, 2, 2])
        .triangles.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`)
        .join(
          '',
        )}</triangles><b:beamlattice radius="1" minlength="0.1" cap="butt"><b:beams><b:beam v1="8" v2="9"/></b:beams></b:beamlattice></mesh>`,
    ),
    both = await parse3MFEvaluated(pack(joined + solid(7, [6, -5, -5], [20, 5, 5]) + cut(10, 4, 7), [10]), file);
  closed(both);
  near(volume(both), 64 + SECTION * 4, 1e-3);
});

test('a clipping mesh keeps the lattice inside or outside it, and gives the cut its property', async () => {
  const colours =
      '<basematerials id="1"><base name="r" displaycolor="#FF0000"/><base name="g" displaycolor="#00FF00"/></basematerials>',
    clip = solid(2, [-3, -3, -3], [3, 3, 3], 'pid="1" pindex="1"');
  for (const [mode, length, low, high] of [
    ['inside', 3, 0, 3],
    ['outside', 7, 3, 10],
  ]) {
    const read = await parse3MFEvaluated(
      pack(
        colours +
          clip +
          strut(4, { lattice: `clippingmode="${mode}" clippingmesh="2"`, attributes: 'pid="1" pindex="0"' }),
        [4],
      ),
      file,
    );
    closed(read);
    near(volume(read), SECTION * length, 1e-3);
    near(sorted(read, 0)[0], low, 1e-5);
    near(sorted(read, 0).at(-1), high, 1e-5);
    assert.deepEqual(read.groups.map((g) => String(g.color)).sort(), ['0,1,0,1', '1,0,0,1'], mode);
  }
});

test('colours cut by a boolean stay between 0 and 1', async () => {
  // A frame of beams with a colour at each end of its diagonals, clipped by a box: the cut left channels of -6e-17.
  const corners = box([0, 0, 0], [10, 10, 10]).vertices,
    caps = ['butt', 'sphere', 'hemisphere'],
    edges = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [i, (i & 4) + ((i + 1) & 3)]),
    beams =
      edges.map(([a, b]) => `<b:beam v1="${a}" v2="${b}"/>`).join('') +
      corners
        .map((_, i) => {
          const ends = `cap1="${caps[i % 3]}" cap2="${caps[(i + 1) % 3]}"`;
          return `<b:beam v1="${i}" v2="8" r1="1.1" r2="0.25" p1="0" p2="1" ${ends}/>`;
        })
        .join(''),
    lattice = `<b:beamlattice radius="0.45" minlength="0.1" cap="sphere" clippingmode="inside" clippingmesh="2"><b:beams>${beams}</b:beams></b:beamlattice>`,
    frame = object(
      4,
      `<mesh><vertices>${vertexXML([...corners, [5, 5, 5]])}</vertices><triangles/>${lattice}</mesh>`,
      'pid="1" pindex="0"',
    ),
    colours = '<colorgroup id="1"><color color="#FF6A00"/><color color="#1466FF"/></colorgroup>',
    read = await parse3MFEvaluated(pack(colours + solid(2, [-3, -3, -3], [7.5, 13, 8]) + frame, [4]), file);
  assert.ok(read.colors.length > 100);
  assert.deepEqual(
    [...read.colors].filter((c) => !(c >= 0 && c <= 1)),
    [],
  );
});

test('a beam takes the colour of its ends along its axis, a base material for all of it', async () => {
  const gradient = await parse3MFEvaluated(
    pack(
      '<colorgroup id="1"><color color="#FF0000"/><color color="#0000FF"/></colorgroup>' +
        strut(4, { attributes: 'pid="1" pindex="0"', beam: 'p1="0" p2="1"' }),
      [4],
    ),
    file,
  );
  assert.ok(gradient.colors);
  for (let v = 0; v < gradient.positions.length; v += 3) {
    const s = gradient.positions[v] / 10;
    near(gradient.colors[v], 1 - s, 1e-5);
    near(gradient.colors[v + 2], s, 1e-5);
  }
  const material = await parse3MFEvaluated(
    pack(
      '<basematerials id="1"><base name="r" displaycolor="#FF0000"/><base name="b" displaycolor="#0000FF"/></basematerials>' +
        strut(4, { attributes: 'pid="1" pindex="0"', beam: 'p1="0" p2="1"' }),
      [4],
    ),
    file,
  );
  assert.equal(material.colors, undefined);
  assert.deepEqual(
    material.groups.map((g) => String(g.color)),
    ['1,0,0,1'],
  );
});

/** The signed distance to the lattice of object 4, clipped as it says. */
const latticeDistance = (id) =>
  implicit(
    id,
    node('constresourceid', 'which', [], [['resourceid', 'value']], 'value="4"') +
      node(
        'beamlattice',
        'far',
        [
          ['vector', 'pos', 'inputs.pos'],
          ['resource', 'beamlattice', 'which.value'],
        ],
        [['scalar', 'distance']],
        'accuraterange="2"',
      ),
    ['scalar', 'shape', 'far.distance'],
  );

test('a level set meshes the signed distance to a beam lattice', async () => {
  const domain = solid(8, [-3, -3, -3], [13, 3, 3]),
    input = pack(
      strut(4, { lattice: '', beam: 'cap1="sphere" cap2="sphere"' }) + latticeDistance(3) + domain + levelSet(9, 3, 8),
      [9],
    ),
    read = await parse3MFVolumetric(input, { ...file, levelSetResolution: 128 });
  closed(read);
  near(volume(read), Math.PI * 10 + (4 / 3) * Math.PI, 0.4);
  // A clipping mesh cuts the distance too.
  const clipped = await parse3MFVolumetric(
    pack(
      solid(2, [-9, -9, -9], [5, 9, 9]) +
        strut(4, { lattice: 'clippingmode="inside" clippingmesh="2"' }) +
        latticeDistance(3) +
        domain +
        levelSet(9, 3, 8),
      [9],
    ),
    { ...file, levelSetResolution: 128 },
  );
  near(volume(clipped), Math.PI * 5, 0.4);
  await assert.rejects(
    parse3MFVolumetric(pack(solid(4, [0, 0, 0], [1, 1, 1]) + latticeDistance(3) + domain + levelSet(9, 3, 8), [9])),
    {
      code: 'syntax',
      message: /lattice object 4/,
    },
  );
});

/** pos / 10 as a colour. */
const ramp = (id) =>
  implicit(
    id,
    node('constvec', 'tenth', [], [['vector', 'vector']], 'x="0.1" y="0.1" z="0.1"') +
      node(
        'multiplication',
        'c',
        [
          ['vector', 'A', 'inputs.pos'],
          ['vector', 'B', 'tenth.vector'],
        ],
        [['vector', 'result']],
      ),
    ['vector', 'color', 'c.result'],
  );
const volumeData = (id, fn, attributes = '') =>
  `<v:volumedata id="${id}"><v:color functionid="${fn}" channel="color" ${attributes}/></v:volumedata>`;
const encoded = (c) => {
  const x = Math.min(1, Math.max(0, c));
  return x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055;
};
/** A cube of side 10 filled with `volume` 5; triangles 2 and 3 (its top) are painted green by the surface. */
function filled(paint = false, attributes = '') {
  const cube = box([0, 0, 0], [10, 10, 10]);
  return `<basematerials id="1"><base name="g" displaycolor="#00FF00"/></basematerials>${ramp(3)}${volumeData(5, 3, attributes)}${object(
    4,
    `<mesh v:volumeid="5"><vertices>${vertexXML(cube.vertices)}</vertices><triangles>${cube.triangles
      .map(
        ([a, b, c], t) =>
          `<triangle v1="${a}" v2="${b}" v3="${c}"${paint && (t === 2 || t === 3) ? ' pid="1" p1="0"' : ''}/>`,
      )
      .join('')}</triangles></mesh>`,
  )}`;
}

test('volume colour is sampled onto the triangles, linear values read as sRGB', async () => {
  const read = await parse3MFVolumetric(pack(filled(), [4]), { ...file, colorResolution: 8 }),
    [one] = read.objects;
  closed(read);
  near(volume(read), 1000, 1e-3);
  for (let v = 0; v < read.positions.length; v++) near(read.colors[v], encoded(read.positions[v] / 10), 1e-5);
  // No side longer than the spacing.
  assert.equal(one.colorSpacing, 1.25);
  assert.equal(one.colorUnresolved, false);
  for (let t = 0; t < read.indices.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const [a, b] = [0, 1].map((s) => read.positions.subarray(read.indices[t + ((k + s) % 3)] * 3).slice(0, 3));
      assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= 1.25 + 1e-6);
    }
  const fine = await parse3MFVolumetric(pack(filled(false, 'minfeaturesize="1"'), [4]), {
    ...file,
    colorResolution: 1,
  });
  assert.equal(fine.objects[0].colorSpacing, 0.5);
  // A rod 500 times as long as it is wide: its colour asks for finer spacing than 512 samples along it.
  const rod = `${ramp(3)}${volumeData(5, 3, 'minfeaturesize="0.001"')}${object(
      4,
      meshXML(box([0, 0, 0], [10, 0.02, 0.02])).replace('<mesh>', '<mesh v:volumeid="5">'),
    )}`,
    coarse = await parse3MFVolumetric(pack(rod, [4]), { ...file, colorResolution: 1 });
  assert.equal(coarse.objects[0].colorSpacing, 10 / 512);
  assert.equal(coarse.objects[0].colorUnresolved, true);
  const plain = await parse3MFVolumetric(pack(filled(), [4]), { ...file, sampleColors: false });
  assert.equal(plain.indices.length, 36);
  assert.equal(plain.colors, undefined);
  await assert.rejects(parse3MFVolumetric(pack(filled(), [4]), { maxTriangles: 100 }), { code: 'limit' });
  await assert.rejects(parse3MFVolumetric(pack(filled(), [4]), { colorResolution: 0 }), { code: 'range' });
});

test('a surface property stays above the volume colour, and a boolean keeps the sampled colours', async () => {
  const read = await parse3MFVolumetric(pack(filled(true), [4]), { ...file, colorResolution: 4 });
  closed(read);
  let top = 0;
  for (let t = 0; t < read.indices.length; t += 3) {
    const corners = [0, 1, 2].map((k) => read.indices[t + k]);
    if (!corners.every((v) => read.positions[v * 3 + 2] === 10)) continue;
    top++;
    for (const v of corners) assert.deepEqual([...read.colors.subarray(v * 3, v * 3 + 3)], [0, 1, 0]);
  }
  assert.ok(top >= 32);
  // The base moves and turns before the cut; its colour moves with it. The cut face comes from an operand with no
  // property, so it shows the volume colour of the base that fills the result.
  const moved = object(
      10,
      '<bo:booleanshape objectid="4" operation="difference" transform="0 1 0 -1 0 0 0 0 1 12 0 0"><bo:boolean objectid="7"/></bo:booleanshape>',
    ),
    halved = await parse3MFEvaluated(pack(filled() + solid(7, [7, -1, -1], [20, 20, 20]) + moved, [10]), {
      ...file,
      colorResolution: 4,
    });
  closed(halved);
  near(volume(halved), 500, 1e-3);
  assert.equal(halved.groups.length, 1);
  near(sorted(halved, 0).at(-1), 7, 1e-6);
  for (let v = 0; v < halved.positions.length; v += 3) {
    const [x, y, z] = halved.positions.subarray(v, v + 3),
      // The point before the turn: x' = 12 - y, y' = x.
      before = [y, 12 - x, z];
    for (let k = 0; k < 3; k++) near(halved.colors[v + k], encoded(before[k] / 10), 1e-5);
  }
});

test('one package of every kind evaluates in one call', async () => {
  const ordered =
    ball(3, 4) + solid(8, [-5, -5, -5], [5, 5, 5]) + ramp(31) + volumeData(5, 31) + levelSet(9, 3, 8, 'volumeid="5"');
  const read = await parse3MFEvaluated(
    pack(ordered + displaced() + strut(4, { from: [20, 0, 0], to: [30, 0, 0] }), [9, 23, 4], map),
    { ...file, colorResolution: 16, samplesPerTexel: 1 },
  );
  assert.deepEqual([...new Set(read.groups.map((g) => g.objectId))].sort(), ['23', '4', '9']);
  near(volume(read), (4 / 3) * Math.PI * 64 + 1180 + SECTION * 10, 1.5);
  assert.equal(read.objects[0].volumeId, '5');
  assert.equal(read.meshes[0].objectId, '23');
  assert.ok(read.colors);
});
