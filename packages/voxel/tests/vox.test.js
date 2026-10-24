import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BlockTypes, VoxelWorld } from '../dist/index.js';
import { parseVox, pasteVoxModel, voxBlockOptions, writeVox } from '../dist/vox.js';

const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// An independent encoder for hand-built fixtures, straight from MagicaVoxel-file-format-vox(-extension).txt:
// little-endian int32s, STRING = int32 size + bytes, DICT = int32 count + key/value STRINGs, chunk = id, N, M.
const i32 = (...values) => {
  const bytes = new Uint8Array(4 * values.length),
    view = new DataView(bytes.buffer);
  values.forEach((v, i) => view.setInt32(4 * i, v, true));
  return [...bytes];
};
const str = (s) => {
  const bytes = [...new TextEncoder().encode(s)];
  return [...i32(bytes.length), ...bytes];
};
const dict = (entries) => [...i32(entries.length), ...entries.flatMap(([k, v]) => [...str(k), ...str(v)])];
const ids = (id) => [...id].map((c) => c.charCodeAt(0));
const chunk = (id, content, children = []) => [
  ...ids(id),
  ...i32(content.length, children.length),
  ...content,
  ...children,
];
const vox = (version, ...chunks) => {
  const body = chunks.flat();
  return Uint8Array.from([...ids('VOX '), ...i32(version), ...ids('MAIN'), ...i32(0, body.length), ...body]);
};
const size = (x, y, z) => chunk('SIZE', i32(x, y, z));
const xyzi = (...voxels) => chunk('XYZI', [...i32(voxels.length), ...voxels.flat()]);
const rgba = (colour) => chunk('RGBA', Array.from({ length: 256 }, (_, k) => colour(k)).flat());
const ntrn = (id, attributes, child, layer, frames) =>
  chunk('nTRN', [...i32(id), ...dict(attributes), ...i32(child, -1, layer, frames.length), ...frames.flatMap(dict)]);
const ngrp = (id, attributes, children) =>
  chunk('nGRP', [...i32(id), ...dict(attributes), ...i32(children.length, ...children)]);
const nshp = (id, attributes, models) =>
  chunk('nSHP', [
    ...i32(id),
    ...dict(attributes),
    ...i32(models.length),
    ...models.flatMap(([m, a]) => [...i32(m), ...dict(a)]),
  ]);
const layr = (id, attributes) => chunk('LAYR', [...i32(id), ...dict(attributes), ...i32(-1)]);
const matl = (id, attributes) => chunk('MATL', [...i32(id), ...dict(attributes)]);
const fileColour = (k) => [k, 255 - k, (k * 7) & 255, 200];
const u32 = (palette, i) => new DataView(palette.buffer, palette.byteOffset).getUint32(4 * i, true);

// A version-200 file using every chunk the spec describes, plus kept ones (one with children).
const unknown = [chunk('NOTE', [...i32(1), ...str('red')]), chunk('ZZZZ', [1, 2, 3], chunk('ZZZY', [9]))];
const full = () =>
  vox(
    200,
    size(2, 3, 4),
    xyzi([0, 0, 0, 1], [1, 2, 3, 255]),
    size(3, 3, 3),
    xyzi([1, 1, 1, 7]),
    ntrn(0, [['_name', 'root']], 1, -1, [[]]),
    ngrp(1, [], [2, 4]),
    ntrn(
      2,
      [
        ['_name', 'a'],
        ['_hidden', '0'],
      ],
      3,
      0,
      [
        [
          ['_r', '105'],
          ['_t', '1 -2 3'],
          ['_f', '0'],
        ],
        [
          ['_t', '4 5 6'],
          ['_f', '10'],
        ],
      ],
    ),
    nshp(
      3,
      [],
      [
        [0, [['_f', '0']]],
        [1, [['_f', '10']]],
      ],
    ),
    ntrn(4, [], 5, 1, [[['_r', '4']]]),
    nshp(5, [], [[1, []]]),
    layr(0, [['_name', 'Base']]),
    layr(1, [
      ['_name', 'Off'],
      ['_hidden', '1'],
      ['_color', '255 0 0'],
    ]),
    rgba(fileColour),
    chunk(
      'rOBJ',
      dict([
        ['_type', '_setting'],
        ['_ground', '1'],
      ]),
    ),
    chunk('rCAM', [
      ...i32(0),
      ...dict([
        ['_mode', 'pers'],
        ['_fov', '45'],
      ]),
    ]),
    matl(1, [
      ['_type', '_metal'],
      ['_weight', '0.5'],
      ['_rough', '0.25'],
      ['_spec', '0.75'],
      ['_ior', '0.3'],
      ['_att', '0'],
      ['_flux', '2'],
      ['_plastic', '1'],
      ['_ldr', '0.1'],
    ]),
    matl(2, [
      ['_type', '_glass'],
      ['_weight', '1'],
    ]),
    chunk('IMAP', i32(...Array.from({ length: 256 }, (_, i) => 255 - i))),
    chunk('META', dict([['_ver', '1']])),
    ...unknown,
  );
const same = (a, b) => assert.deepEqual(Buffer.from(a).toString('hex'), Buffer.from(b).toString('hex'));

test('a version-150 file built from the spec parses with the palette off by one and writes back byte for byte', () => {
  const bytes = vox(150, size(2, 3, 4), xyzi([0, 0, 0, 1], [1, 2, 3, 255], [1, 0, 2, 7]), rgba(fileColour)),
    scene = parseVox(bytes);
  assert.equal(scene.version, 150);
  assert.deepEqual(scene.models[0].size, [2, 3, 4]);
  assert.deepEqual([...scene.models[0].voxels], [0, 0, 0, 1, 1, 2, 3, 255, 1, 0, 2, 7]);
  assert.notEqual(scene.models[0].voxels.buffer, bytes.buffer); // copied out of the file
  // File colour k is palette index k + 1; the 256th colour lands on index 0.
  assert.deepEqual([...scene.palette.subarray(4, 8)], fileColour(0));
  assert.deepEqual([...scene.palette.subarray(4 * 255, 4 * 256)], fileColour(254));
  assert.deepEqual([...scene.palette.subarray(0, 4)], fileColour(255));
  assert.deepEqual(scene.chunks, [{ id: 'SIZE' }, { id: 'RGBA' }]);
  assert.deepEqual([scene.nodes, scene.layers, scene.materials], [[], [], []]);
  same(writeVox(scene), bytes);
  // An ArrayBuffer, and a view into a larger buffer, read the same.
  const padded = new Uint8Array(bytes.length + 9);
  padded.set(bytes, 5);
  assert.deepEqual(parseVox(padded.subarray(5, 5 + bytes.length)), scene);
  assert.deepEqual(parseVox(bytes.slice().buffer), scene);
});

test("without an RGBA chunk the palette is MagicaVoxel's default, and none is written unless it changes", () => {
  const bytes = vox(150, size(1, 1, 1), xyzi([0, 0, 0, 2])),
    scene = parseVox(bytes);
  // Spot checks against the spec's default_palette table (0xAABBGGRR, entry i = palette index i).
  const expected = { 0: 0, 1: 0xffffffff, 2: 0xffccffff, 7: 0xffffccff, 215: 0xff330000, 216: 0xff0000ee };
  Object.assign(expected, { 225: 0xff000011, 226: 0xff00ee00, 236: 0xffee0000, 246: 0xffeeeeee, 255: 0xff111111 });
  for (const [i, v] of Object.entries(expected)) assert.equal(u32(scene.palette, Number(i)), v, `index ${i}`);
  same(writeVox(scene), bytes);
  scene.palette[8] = 1;
  const written = writeVox(scene);
  assert.equal(written.length, bytes.length + 1036);
  assert.equal(parseVox(written).palette[8], 1);
});

test('a version-150 animation keeps its PACK chunk', () => {
  const bytes = vox(150, chunk('PACK', i32(2)), size(1, 1, 1), xyzi([0, 0, 0, 1]), size(1, 1, 2), xyzi([0, 0, 1, 2])),
    scene = parseVox(bytes);
  assert.equal(scene.models.length, 2);
  same(writeVox(scene), bytes);
  scene.models.pop();
  assert.equal(parseVox(writeVox(scene)).models.length, 1); // PACK counts what is written
});

test('every chunk type decodes from a hand-built version-200 file and writes back byte for byte', () => {
  const bytes = full(),
    scene = parseVox(bytes),
    map = (entries) => new Map(entries);
  assert.equal(scene.version, 200);
  assert.deepEqual(
    scene.models.map((m) => [m.size, [...m.voxels]]),
    [
      [
        [2, 3, 4],
        [0, 0, 0, 1, 1, 2, 3, 255],
      ],
      [
        [3, 3, 3],
        [1, 1, 1, 7],
      ],
    ],
  );
  assert.deepEqual(scene.nodes, [
    {
      id: 0,
      type: 'transform',
      child: 1,
      layer: -1,
      name: 'root',
      attributes: map([['_name', 'root']]),
      frames: [{ attributes: map([]) }],
    },
    { id: 1, type: 'group', children: [2, 4], attributes: map([]) },
    {
      id: 2,
      type: 'transform',
      child: 3,
      layer: 0,
      name: 'a',
      hidden: false,
      attributes: map([
        ['_name', 'a'],
        ['_hidden', '0'],
      ]),
      frames: [
        // The spec's example: R = [0 1 0; 0 0 -1; -1 0 0] is byte 105.
        {
          rotation: [0, 1, 0, 0, 0, -1, -1, 0, 0],
          translation: [1, -2, 3],
          frame: 0,
          attributes: map([
            ['_r', '105'],
            ['_t', '1 -2 3'],
            ['_f', '0'],
          ]),
        },
        {
          translation: [4, 5, 6],
          frame: 10,
          attributes: map([
            ['_t', '4 5 6'],
            ['_f', '10'],
          ]),
        },
      ],
    },
    {
      id: 3,
      type: 'shape',
      attributes: map([]),
      models: [
        { model: 0, frame: 0, attributes: map([['_f', '0']]) },
        { model: 1, frame: 10, attributes: map([['_f', '10']]) },
      ],
    },
    {
      id: 4,
      type: 'transform',
      child: 5,
      layer: 1,
      attributes: map([]),
      frames: [{ rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], attributes: map([['_r', '4']]) }],
    },
    { id: 5, type: 'shape', attributes: map([]), models: [{ model: 1, attributes: map([]) }] },
  ]);
  assert.deepEqual(scene.layers, [
    { id: 0, name: 'Base', attributes: map([['_name', 'Base']]) },
    {
      id: 1,
      name: 'Off',
      hidden: true,
      attributes: map([
        ['_name', 'Off'],
        ['_hidden', '1'],
        ['_color', '255 0 0'],
      ]),
    },
  ]);
  const [metal, glass] = scene.materials;
  assert.deepEqual(
    { ...metal, attributes: undefined },
    {
      id: 1,
      type: 'metal',
      weight: 0.5,
      rough: 0.25,
      spec: 0.75,
      ior: 0.3,
      att: 0,
      flux: 2,
      plastic: 1,
      attributes: undefined,
    },
  );
  assert.equal(metal.attributes.get('_ldr'), '0.1');
  assert.deepEqual({ ...glass, attributes: undefined }, { id: 2, type: 'glass', weight: 1, attributes: undefined });
  assert.deepEqual(
    scene.chunks.map((c) => c.id),
    [
      'SIZE',
      'SIZE',
      'nTRN',
      'nGRP',
      'nTRN',
      'nSHP',
      'nTRN',
      'nSHP',
      'LAYR',
      'LAYR',
      'RGBA',
      'rOBJ',
      'rCAM',
      'MATL',
      'MATL',
      'IMAP',
      'META',
      'NOTE',
      'ZZZZ',
    ],
  );
  // Kept chunks hold their exact bytes, children included.
  const zzzz = scene.chunks.at(-1);
  assert.deepEqual([[...zzzz.content], [...zzzz.children]], [[1, 2, 3], chunk('ZZZY', [9])]);
  assert.deepEqual([...scene.chunks.at(-2).content], unknown[0].slice(12));
  same(writeVox(scene), bytes);
  // Removing kept chunks removes exactly their bytes.
  const tail = unknown.flat().length;
  scene.chunks.splice(-2);
  assert.equal(writeVox(scene).length, bytes.length - tail);
});

test('the rotation byte: all 48 signed permutations (24 of them rotations) encode per the spec and decode back', () => {
  const perms = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ],
    cases = [];
  for (const p of perms)
    for (let signs = 0; signs < 8; signs++) {
      const m = Array(9).fill(0);
      for (let row = 0; row < 3; row++) m[3 * row + p[row]] = signs & (1 << row) ? -1 : 1;
      // bits 0-1 row 0's column, 2-3 row 1's, 4-6 the row signs (1 = negative)
      cases.push({ m, byte: p[0] | (p[1] << 2) | (signs << 4) });
    }
  const det = (m) =>
    m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  assert.equal(cases.filter((c) => det(c.m) === 1).length, 24);
  const scene = {
    version: 200,
    models: [{ size: [1, 1, 1], voxels: Uint8Array.of(0, 0, 0, 1) }],
    palette: new Uint8Array(1024),
    materials: [],
    layers: [],
    nodes: [
      { id: 0, type: 'group', children: cases.map((_, i) => 1 + 2 * i) },
      ...cases.flatMap(({ m }, i) => [
        { id: 1 + 2 * i, type: 'transform', child: 2 + 2 * i, layer: -1, frames: [{ rotation: m }] },
        { id: 2 + 2 * i, type: 'shape', models: [{ model: 0 }] },
      ]),
    ],
  };
  const back = parseVox(writeVox(scene)).nodes.filter((n) => n.type === 'transform');
  cases.forEach(({ m, byte }, i) => {
    assert.deepEqual(back[i].frames[0].rotation, m);
    assert.equal(back[i].frames[0].attributes.get('_r'), String(byte));
  });
  // The other 7-bit values are not signed permutations; bit 7 is unused and kept as stored.
  const valid = new Set(cases.map((c) => c.byte)),
    file = (r) =>
      vox(200, size(1, 1, 1), xyzi([0, 0, 0, 1]), ntrn(0, [], 1, -1, [[['_r', r]]]), nshp(1, [], [[0, []]]));
  for (let byte = 0; byte < 128; byte++)
    if (!valid.has(byte)) assert.throws(() => parseVox(file(String(byte))), /attribute _r/);
  for (const r of ['256', '-1', '1.5', 'x']) assert.throws(() => parseVox(file(r)), RangeError);
  const high = file(String(105 | 128));
  assert.deepEqual(parseVox(high).nodes[0].frames[0].rotation, cases.find((c) => c.byte === 105).m);
  same(writeVox(parseVox(high)), high);
  scene.nodes[1].frames[0].rotation = [1, 0, 0, 0, 1, 0, 1, 0, 0];
  assert.throws(() => writeVox(scene), /signed permutation/);
});

test('attributes keep their stored text and order; a changed typed field rewrites only its own key', () => {
  const bytes = vox(
      200,
      size(1, 1, 1),
      xyzi([0, 0, 0, 1]),
      ntrn(0, [['_hidden', '2']], 1, -1, [
        [
          ['_t', ' 1  2 3'],
          ['_x', 'keep'],
          ['_r', '4.0'],
        ],
      ]),
      nshp(1, [], [[0, []]]),
      matl(1, [
        ['_rough', '0.50'],
        ['_type', 'diffuse'],
        ['_d', '0.05'],
      ]),
    ),
    scene = parseVox(bytes),
    [node] = scene.nodes,
    frame = node.frames[0];
  assert.equal(node.hidden, true);
  assert.deepEqual(frame.translation, [1, 2, 3]);
  assert.deepEqual([scene.materials[0].rough, scene.materials[0].type], [0.5, 'diffuse']);
  same(writeVox(scene), bytes);
  frame.translation = [7, 8, 9];
  frame.rotation = undefined;
  frame.frame = 3;
  scene.materials[0].rough = 0.75;
  node.name = 'n';
  const back = parseVox(writeVox(scene));
  assert.deepEqual(
    [...back.nodes[0].frames[0].attributes],
    [
      ['_t', '7 8 9'],
      ['_x', 'keep'],
      ['_f', '3'],
    ],
  );
  assert.deepEqual(
    [...back.nodes[0].attributes],
    [
      ['_hidden', '2'],
      ['_name', 'n'],
    ],
  );
  assert.deepEqual(
    [...back.materials[0].attributes],
    [
      ['_rough', '0.75'],
      ['_type', 'diffuse'],
      ['_d', '0.05'],
    ],
  );
  // Text is UTF-8; a name that is not is read as windows-1252 rather than rejected.
  const named = vox(150, layr(0, [['_name', '日本']]));
  assert.equal(parseVox(named).layers[0].name, '日本');
  same(writeVox(parseVox(named)), named);
  const latin = vox(150, chunk('LAYR', [...i32(0, 1), ...str('_name'), ...i32(1), 0xe9, ...i32(-1)]));
  assert.equal(parseVox(latin).layers[0].name, 'é');
});

test('a new scene writes in canonical order, and items added to a parsed scene follow the last of their kind', () => {
  const model = { size: [2, 2, 2], voxels: Uint8Array.of(1, 1, 1, 3) },
    scene = {
      version: 200,
      models: [model, model],
      palette: new Uint8Array(1024).fill(9),
      materials: [{ id: 3, type: 'emit', flux: 1.5 }],
      layers: [{ id: 0, name: 'L' }],
      nodes: [
        { id: 0, type: 'transform', child: 1, layer: -1, frames: [{}] },
        { id: 1, type: 'group', children: [2] },
        { id: 2, type: 'transform', child: 3, layer: 0, frames: [{ translation: [0, 0, 1] }] },
        { id: 3, type: 'shape', models: [{ model: 1 }] },
      ],
    },
    back = parseVox(writeVox(scene));
  assert.deepEqual(
    back.chunks.map((c) => c.id),
    ['SIZE', 'SIZE', 'nTRN', 'nGRP', 'nTRN', 'nSHP', 'LAYR', 'RGBA', 'MATL'],
  );
  assert.deepEqual(back.palette, scene.palette);
  assert.deepEqual([back.materials[0].type, back.materials[0].flux], ['emit', 1.5]);
  assert.deepEqual(back.nodes[2].frames[0].translation, [0, 0, 1]);
  const old = parseVox(vox(150, size(1, 1, 1), xyzi([0, 0, 0, 1]), rgba(fileColour), chunk('NOTE', i32(0))));
  old.models.push(model);
  old.layers.push({ id: 4 });
  assert.deepEqual(
    parseVox(writeVox(old)).chunks.map((c) => c.id),
    ['SIZE', 'SIZE', 'RGBA', 'NOTE', 'LAYR'],
  );
});

test('writeVox rejects scenes parseVox would reject, and bytes for chunks it encodes itself', () => {
  const base = () => parseVox(full());
  const broken = [
    [(s) => (s.version = 1.5), RangeError],
    [(s) => (s.palette = new Uint8Array(4)), TypeError],
    [(s) => (s.models[0].size = [0, 1, 1]), RangeError],
    [(s) => (s.models[0].voxels = Uint8Array.of(5, 0, 0, 1)), RangeError],
    [(s) => (s.models[0].voxels = Uint8Array.of(0, 0, 0, 0)), RangeError],
    [(s) => (s.models[0].voxels = [0, 0, 0, 1]), TypeError],
    [(s) => (s.nodes[1].children = [2, 2]), RangeError],
    [(s) => (s.nodes[1].children = [3]), RangeError],
    [(s) => (s.nodes[3].models[0].model = 9), RangeError],
    [(s) => (s.nodes[2].frames = []), TypeError],
    [(s) => (s.nodes[2].frames[0].translation = [0.5, 0, 0]), RangeError],
    [(s) => (s.nodes[2].name = 5), TypeError],
    [(s) => (s.nodes[0].type = 'light'), TypeError],
    [(s) => (s.nodes[5].id = 0), RangeError],
    [(s) => (s.materials[0].rough = Number.NaN), RangeError],
    [(s) => (s.layers[0].attributes = { _name: 'x' }), TypeError],
    [(s) => s.chunks.push({ id: 'MATL', content: new Uint8Array(4) }), TypeError],
    [(s) => s.chunks.push({ id: 'XYZI' }), TypeError],
    [(s) => s.chunks.push({ id: 'TOOLONG' }), TypeError],
    [(s) => s.chunks.push({ id: 'RGBA' }), RangeError],
  ];
  for (const [i, [edit, type]] of broken.entries()) {
    const scene = base();
    edit(scene);
    assert.throws(() => writeVox(scene), type, `case ${i}`);
  }
  assert.throws(() => writeVox(null), TypeError);
});

const named = (error) =>
  (error instanceof RangeError && /^Vox file /.test(error.message)) ||
  (error instanceof TypeError && /^Bytes are not a \.vox file/.test(error.message));

test('malformed files throw a RangeError (TypeError when not a .vox file) naming the problem', () => {
  const m = [size(1, 1, 1), xyzi([0, 0, 0, 1])],
    tree = (nodes) => vox(200, ...m, ...nodes);
  const cases = [
    ['VOX header', Uint8Array.from([...ids('VOXX'), ...i32(150, 0, 0, 0)]), /not a \.vox file/],
    ['empty', new Uint8Array(0), /not a \.vox file/],
    ['trailing byte', Uint8Array.from([...vox(150, ...m), 0]), /MAIN chunk declares/],
    [
      'MAIN content',
      Uint8Array.from([...ids('VOX '), ...i32(150), ...ids('MAIN'), ...i32(4, 0), 0, 0, 0, 0]),
      /MAIN chunk has content/,
    ],
    ['size 0', vox(150, size(0, 1, 1), xyzi()), /not 1-256/],
    ['size 257', vox(150, size(257, 1, 1), xyzi()), /not 1-256/],
    ['voxel outside', vox(150, size(2, 2, 2), xyzi([0, 2, 0, 1])), /outside/],
    ['palette index 0', vox(150, size(2, 2, 2), xyzi([0, 0, 0, 0])), /palette index 0/],
    ['XYZI count', vox(150, size(1, 1, 1), chunk('XYZI', [...i32(2), 0, 0, 0, 1])), /4 \+ 4 per voxel/],
    ['XYZI first', vox(150, xyzi([0, 0, 0, 1])), /without a SIZE/],
    ['SIZE alone', vox(150, size(1, 1, 1)), /not followed by its XYZI/],
    ['SIZE extra', vox(150, chunk('SIZE', i32(1, 1, 1, 1)), xyzi()), /extra bytes/],
    ['negative size', vox(150, [...ids('NOTE'), ...i32(-4, 0)]), /truncated/],
    ['past parent', vox(150, [...ids('NOTE'), ...i32(100, 0)]), /truncated/],
    ['nested MAIN', vox(150, chunk('MAIN', [])), /second MAIN/],
    ['children', vox(150, chunk('RGBA', Array(1024).fill(0), chunk('NOTE', []))), /child chunks/],
    ['two RGBA', vox(150, rgba(fileColour), rgba(fileColour)), /second RGBA/],
    ['two PACK', vox(150, chunk('PACK', i32(1)), chunk('PACK', i32(1)), ...m), /second PACK/],
    ['PACK count', vox(150, chunk('PACK', i32(3)), ...m), /PACK counts 3/],
    ['huge dict', vox(200, chunk('LAYR', [...i32(0, 0x7fffffff), ...i32(-1)])), /more than its bytes hold/],
    ['negative string', vox(200, chunk('LAYR', [...i32(0, 1, -5, 0, 0)])), /string of -5/],
    [
      'duplicate key',
      vox(
        200,
        layr(0, [
          ['_name', 'a'],
          ['_name', 'b'],
        ]),
      ),
      /twice/,
    ],
    ['LAYR extra', vox(200, chunk('LAYR', [...i32(0), ...dict([]), ...i32(-1, 0)])), /after its content/],
    ['zero frames', tree([ntrn(0, [], 1, -1, []), nshp(1, [], [[0, []]])]), /0 frames/],
    ['zero models', tree([nshp(0, [], [])]), /0 models/],
    ['bad _t', tree([ntrn(0, [], 1, -1, [[['_t', '1 2']]]), nshp(1, [], [[0, []]])]), /attribute _t/],
    ['bad _f', tree([ntrn(0, [], 1, -1, [[['_f', '-1']]]), nshp(1, [], [[0, []]])]), /attribute _f/],
    ['bad float', vox(200, matl(1, [['_rough', 'nan']])), /attribute _rough/],
    ['duplicate id', tree([nshp(0, [], [[0, []]]), nshp(0, [], [[0, []]])]), /two nodes with id 0/],
    ['dangling child', tree([ntrn(0, [], 7, -1, [[]])]), /child 7/],
    [
      'transform child',
      tree([ntrn(0, [], 1, -1, [[]]), ntrn(1, [], 2, -1, [[]]), nshp(2, [], [[0, []]])]),
      /not a group or shape/,
    ],
    ['group child', tree([ngrp(0, [], [1]), nshp(1, [], [[0, []]])]), /not a transform/],
    [
      'two parents',
      tree([ngrp(0, [], [2]), ngrp(1, [], [2]), ntrn(2, [], 3, -1, [[]]), nshp(3, [], [[0, []]])]),
      /two parents/,
    ],
    ['cycle', tree([ntrn(0, [], 1, -1, [[]]), ngrp(1, [], [0])]), /cycle/],
    ['model index', tree([nshp(0, [], [[1, []]])]), /model 1 of 1/],
  ];
  for (const [name, bytes, message] of cases)
    assert.throws(
      () => parseVox(bytes),
      (e) => named(e) && message.test(e.message),
      name,
    );
  assert.throws(() => parseVox('VOX '), TypeError);
  assert.throws(() => parseVox(new Int8Array(20)), TypeError);
});

test('truncation at every byte of a full file throws a named error, also with MAIN resized to match', () => {
  const bytes = full();
  let whole = 0;
  for (let n = 0; n < bytes.length; n++) {
    assert.throws(() => parseVox(bytes.subarray(0, n)), named, `truncated to ${n} of ${bytes.length}`);
    if (n < 20) continue;
    // MAIN claiming exactly what is left reaches the chunk-level checks; a cut at a chunk boundary may still parse.
    const cut = bytes.slice(0, n);
    new DataView(cut.buffer).setInt32(16, n - 20, true);
    try {
      same(writeVox(parseVox(cut)), cut);
      whole++;
    } catch (error) {
      assert.ok(named(error), `resized to ${n}: ${error.name}: ${error.message}`);
    }
  }
  assert.ok(whole >= 3, `${whole} cuts at chunk boundaries parsed`);
});

test('seeded corruption throws only named errors, and whatever parses writes back to a fixed point', () => {
  const next = random(11),
    seed = full(),
    interesting = [0, 1, -1, 0x7fffffff, -0x80000000, 255, 256, 1024, 4];
  let parsed = 0;
  for (let n = 0; n < 4000; n++) {
    const bytes = seed.slice(),
      at = Math.floor(next() * bytes.length);
    const edits = 1 + Math.floor(next() * 3);
    for (let k = 0; k < edits; k++) {
      const p = Math.floor(next() * bytes.length);
      if (next() < 0.5) bytes[p] = Math.floor(next() * 256);
      else if (p + 4 <= bytes.length)
        new DataView(bytes.buffer).setInt32(p - (p % 4), interesting[Math.floor(next() * interesting.length)], true);
    }
    const input = next() < 0.2 ? bytes.subarray(0, at) : bytes;
    let scene;
    try {
      scene = parseVox(input);
    } catch (error) {
      assert.ok(named(error), `input ${n}: ${error.name}: ${error.message}`);
      continue;
    }
    parsed++;
    const once = writeVox(scene);
    same(writeVox(parseVox(once)), once);
  }
  assert.ok(parsed > 50, `${parsed} corrupted inputs parsed`); // some corruption hits values, not structure
});

// Cells a scene's shapes cover, by brute force in continuous MagicaVoxel space: voxel centre v + 0.5 - size / 2
// through each transform (R p + t), the cell containing it, then z-up to y-up (x, z, -1 - y).
function oracle(scene) {
  const byId = new Map(scene.nodes.map((n) => [n.id, n])),
    cells = [],
    apply = (m, t, p) => [0, 1, 2].map((i) => m[3 * i] * p[0] + m[3 * i + 1] * p[1] + m[3 * i + 2] * p[2] + t[i]);
  const walk = (id, chain) => {
    const node = byId.get(id);
    if (node.hidden) return;
    if (node.type === 'transform') {
      if (scene.layers.find((l) => l.id === node.layer)?.hidden) return;
      walk(node.child, [...chain, node.frames[0]]);
    } else if (node.type === 'group') for (const c of node.children) walk(c, chain);
    else {
      const model = scene.models[node.models[0].model],
        place = (v) => {
          let p = v.map((c, a) => c + 0.5 - model.size[a] / 2);
          for (let k = chain.length; k--; )
            p = apply(chain[k].rotation ?? [1, 0, 0, 0, 1, 0, 0, 0, 1], chain[k].translation ?? [0, 0, 0], p);
          const c = p.map(Math.floor);
          return [c[0], c[2], -1 - c[1]];
        };
      const box = [];
      for (let x = 0; x < model.size[0]; x++)
        for (let y = 0; y < model.size[1]; y++) for (let z = 0; z < model.size[2]; z++) box.push(place([x, y, z]));
      const v = model.voxels,
        voxels = [];
      for (let i = 0; i < v.length; i += 4) voxels.push([...place([v[i], v[i + 1], v[i + 2]]), v[i + 3]]);
      cells.push({ box, voxels });
    }
  };
  walk(0, []);
  const min = [0, 1, 2].map((a) => Math.min(...cells.flatMap((c) => c.box.map((p) => p[a]))));
  return { min, voxels: cells.flatMap((c) => c.voxels) };
}

test('pasteVoxModel: a bare model pastes z up with its box corner at the cell given', () => {
  const blocks = new BlockTypes(),
    stone = blocks.define('stone'),
    dirt = blocks.define('dirt'),
    world = new VoxelWorld({ blocks }),
    model = { size: [3, 4, 5], voxels: Uint8Array.of(0, 0, 0, 1, 2, 3, 4, 2, 1, 2, 0, 3) },
    mapping = Object.assign(Array(256).fill(0), { 1: stone, 2: dirt });
  assert.equal(pasteVoxModel(world, model, [10, -20, 30], mapping), 2);
  // MagicaVoxel (x, y, z) -> world (x, z, size.y - 1 - y) from the corner.
  assert.equal(world.getBlock(10, -20, 33), stone);
  assert.equal(world.getBlock(12, -16, 30), dirt);
  assert.equal(world.getBlock(11, -20, 31), 0); // index 3 maps to 0: skipped
  assert.equal(pasteVoxModel(world, model, [10, -20, 30], mapping), 0);
  assert.throws(() => pasteVoxModel(world, model, [0, 0, 0]), TypeError);
  assert.throws(() => pasteVoxModel(world, model, [0, 0, 0], { 1: 99, length: 256 }), RangeError);
  assert.throws(() => pasteVoxModel({}, model, [0, 0, 0], mapping), TypeError);
  assert.throws(() => pasteVoxModel(world, model, [0.5, 0, 0], mapping), RangeError);
  assert.throws(
    () => pasteVoxModel(world, { size: [1, 1, 1], voxels: Uint8Array.of(1, 0, 0, 1) }, [0, 0, 0], mapping),
    RangeError,
  );
});

test("pasteVoxModel: a scene's colours become vox:rrggbb block types, reused on the next paste", () => {
  const scene = parseVox(vox(150, size(2, 1, 1), xyzi([0, 0, 0, 1], [1, 0, 0, 2]), rgba(fileColour))),
    blocks = new BlockTypes(),
    world = new VoxelWorld({ blocks });
  assert.equal(pasteVoxModel(world, scene, [0, 0, 0]), 2);
  const red = blocks.id('vox:00ff00'), // file colour 0 = palette index 1
    other = blocks.id('vox:01fe07');
  assert.deepEqual([world.getBlock(0, 0, 0), world.getBlock(1, 0, 0)], [red, other]);
  assert.deepEqual(blocks.get(red).color, [0, 1, 0]);
  const types = blocks.table.length;
  pasteVoxModel(world, scene, [5, 0, 0]);
  assert.equal(blocks.table.length, types);
  // A failed check writes and defines nothing.
  const fresh = new VoxelWorld({ blocks: new BlockTypes(), maxY: 10 });
  assert.throws(() => pasteVoxModel(fresh, scene, [0, 11, 0]), RangeError);
  assert.equal(fresh.blocks.table.length, 1);
  assert.equal(fresh.dirty.size, 0);
});

test('pasteVoxModel: metal, glass, emit and media materials become block options; diffuse stays plain', () => {
  const scene = parseVox(
      vox(
        200,
        size(4, 1, 1),
        xyzi([0, 0, 0, 1], [1, 0, 0, 2], [2, 0, 0, 3], [3, 0, 0, 4]),
        rgba(fileColour),
        matl(1, [
          ['_type', '_metal'],
          ['_weight', '0.5'],
          ['_rough', '0.25'],
        ]),
        matl(2, [
          ['_type', '_glass'],
          ['_weight', '1'],
          ['_alpha', '0.6'],
        ]),
        matl(3, [
          ['_type', '_emit'],
          ['_weight', '0.5'],
          ['_flux', '2'],
        ]),
        matl(4, [['_type', '_diffuse']]),
      ),
    ),
    blocks = new BlockTypes(),
    world = new VoxelWorld({ blocks });
  assert.equal(pasteVoxModel(world, scene, [0, 0, 0]), 4);
  const [metal, glass, emit, plain] = [0, 1, 2, 3].map((x) => blocks.get(world.getBlock(x, 0, 0)));
  assert.equal(metal.name, 'vox:00ff00:roughness=0.25:metalness=0.5');
  assert.deepEqual([metal.metalness, metal.roughness, metal.layer], [0.5, 0.25, 'opaque']);
  assert.deepEqual([glass.layer, glass.transmission], ['translucent', 0.6]);
  assert.equal(emit.emissive, 1.5);
  assert.equal(plain.name, 'vox:03fc15');
  assert.deepEqual(voxBlockOptions({ id: 5, type: 'media', weight: 0.4 }), { layer: 'translucent', scatter: 0.4 });
  assert.deepEqual(
    voxBlockOptions({ id: 5, type: 'blend', weight: 0.3 }),
    { metalness: 0.3 },
    'blend: no glass without _trans',
  );
});

test('pasteVoxModel: scene transforms, groups and hidden nodes match a brute-force oracle', () => {
  const next = random(5),
    perms = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ],
    rotation = () => {
      const p = perms[Math.floor(next() * 6)],
        m = Array(9).fill(0);
      for (let row = 0; row < 3; row++) m[3 * row + p[row]] = next() < 0.5 ? -1 : 1;
      return m;
    },
    int = (n) => Math.floor(next() * n);
  for (let trial = 0; trial < 40; trial++) {
    const models = Array.from({ length: 3 }, () => {
      const s = [1 + int(6), 1 + int(6), 1 + int(6)],
        voxels = [];
      for (let k = int(20); k--; ) voxels.push(int(s[0]), int(s[1]), int(s[2]), 1 + int(5));
      return { size: s, voxels: Uint8Array.from(voxels) };
    });
    const frame = () => ({
      rotation: next() < 0.8 ? rotation() : undefined,
      translation: [int(21) - 10, int(21) - 10, int(21) - 10],
    });
    // root T0 -> G1 -> { T2 -> S3, T4 -> G5 -> { T6 -> S7, T8 (hidden layer) -> S9 } }
    const scene = {
      version: 200,
      models,
      palette: new Uint8Array(1024),
      materials: [],
      layers: [{ id: 0 }, { id: 1, hidden: true }],
      chunks: undefined,
      nodes: [
        { id: 0, type: 'transform', child: 1, layer: -1, frames: [frame()] },
        { id: 1, type: 'group', children: [2, 4] },
        { id: 2, type: 'transform', child: 3, layer: 0, frames: [frame(), frame()] },
        { id: 3, type: 'shape', models: [{ model: int(3) }, { model: 0, frame: 1 }] },
        { id: 4, type: 'transform', child: 5, layer: 0, frames: [frame()], hidden: trial % 5 === 4 },
        { id: 5, type: 'group', children: [6, 8] },
        { id: 6, type: 'transform', child: 7, layer: 0, frames: [frame()] },
        { id: 7, type: 'shape', models: [{ model: int(3) }] },
        { id: 8, type: 'transform', child: 9, layer: 1, frames: [frame()] },
        { id: 9, type: 'shape', models: [{ model: int(3) }] },
      ],
    };
    const blocks = new BlockTypes();
    for (let i = 1; i <= 5; i++) blocks.define(`c${i}`);
    const world = new VoxelWorld({ blocks }),
      at = [int(100) - 50, int(100) - 50, int(100) - 50],
      expected = new Map(),
      { min, voxels } = oracle(scene);
    for (const [x, y, z, index] of voxels)
      expected.set(`${x - min[0] + at[0]},${y - min[1] + at[1]},${z - min[2] + at[2]}`, index);
    pasteVoxModel(
      world,
      parseVox(writeVox(scene)),
      at,
      Array.from({ length: 256 }, (_, i) => (i <= 5 ? i : 0)),
    );
    for (const [key, index] of expected) {
      const [x, y, z] = key.split(',').map(Number);
      assert.equal(world.getBlock(x, y, z), index, `trial ${trial} cell ${key}`);
    }
    let count = 0;
    for (const key of world.dirty) {
      const [cx, cy, cz] = key.split(',').map(Number),
        chunk = world.getChunk(cx, cy, cz);
      for (let i = 0; i < 32768; i++) if (chunk.get(i & 31, i >> 10, (i >> 5) & 31)) count++;
    }
    assert.equal(count, expected.size, `trial ${trial}: no cells beyond the oracle's`);
  }
});

// What pasting must do, voxel by voxel: one setBlock each, in file order (pasteVoxModel batches by chunk).
function pasteBySetBlock(world, cells, mapping) {
  let changed = 0;
  for (const [x, y, z, index] of cells) {
    const state = mapping[index];
    if (state && world.setBlock(x, y, z, state) !== state) changed++;
  }
  return changed;
}
// A world with the same random blocks for both sides of a comparison, every event recorded per cell.
function comparedWorld(seed) {
  const next = random(seed),
    int = (n) => Math.floor(next() * n),
    blocks = new BlockTypes();
  for (let i = 1; i <= 6; i++) blocks.define(`c${i}`);
  const world = new VoxelWorld({ blocks, minY: -300, maxY: 300 }),
    edits = [];
  for (let k = 3000; k--; ) edits.push(int(180) - 90, int(180) - 90, int(180) - 90, int(7));
  world.setBlocks(edits);
  world.addChunk(9, 9, 9);
  world.dirty.clear();
  const changes = new Map(),
    added = [];
  let stale = 0;
  world.onChange((x, y, z, state, previous) => {
    if (world.getBlock(x, y, z) !== state) stale++; // each call sees its own cell written, as setBlock's do
    const key = `${x},${y},${z}`;
    changes.set(key, [...(changes.get(key) ?? []), previous, state]);
  });
  world.onChunk((cx, cy, cz, chunk) => added.push(`${cx},${cy},${cz} ${chunk ? 'added' : 'removed'}`));
  added.length = 0;
  const result = () => {
    const cells = [];
    for (const key of [...new Set([...world.dirty, ...added.map((a) => a.split(' ')[0])])].sort()) {
      const [cx, cy, cz] = key.split(',').map(Number),
        chunk = world.getChunk(cx, cy, cz);
      for (let i = 0; chunk && i < 32768; i++) cells.push(chunk.get(i & 31, i >> 10, (i >> 5) & 31));
    }
    return {
      dirty: [...world.dirty].sort(),
      added: added.sort(),
      changes: [...changes].sort(),
      cells,
      stale,
    };
  };
  return { world, result };
}

test('pasteVoxModel: batching by chunk changes what one setBlock per voxel would (cells, dirty, onChange per cell)', () => {
  const next = random(17),
    int = (n) => Math.floor(next() * n),
    mapping = Array.from({ length: 256 }, (_, i) => (i ? i % 7 : 0)); // index 7 maps to 0: skipped
  let changed = 0;
  for (let trial = 0; trial < 24; trial++) {
    const models = Array.from({ length: trial % 2 ? 1 : 3 }, () => {
      const s = trial % 2 ? [1 + int(70), 1 + int(70), 1 + int(70)] : [1 + int(24), 1 + int(24), 1 + int(24)],
        voxels = [];
      // Random cells (some twice, so order matters), and a dense run that fills whole chunk rows.
      for (let k = int(trial % 2 ? 20000 : 4000); k--; ) voxels.push(int(s[0]), int(s[1]), int(s[2]), 1 + int(7));
      for (let k = 0; k < s[0] * s[1] && k < 3000; k++) voxels.push(k % s[0], Math.floor(k / s[0]), 0, 1 + (k % 3));
      return { size: s, voxels: Uint8Array.from(voxels) };
    });
    const frame = () => ({ translation: [int(41) - 20, int(41) - 20, int(41) - 20] }),
      scene = {
        version: 200,
        models,
        palette: new Uint8Array(1024),
        materials: [],
        layers: [{ id: 0 }],
        chunks: undefined,
        nodes: [
          { id: 0, type: 'transform', child: 1, layer: -1, frames: [{}] },
          { id: 1, type: 'group', children: [2, 4, 6] },
          { id: 2, type: 'transform', child: 3, layer: 0, frames: [frame()] },
          { id: 3, type: 'shape', models: [{ model: 0 }] },
          {
            id: 4,
            type: 'transform',
            child: 5,
            layer: 0,
            frames: [{ ...frame(), rotation: [0, 1, 0, -1, 0, 0, 0, 0, 1] }],
          },
          { id: 5, type: 'shape', models: [{ model: 1 }] },
          { id: 6, type: 'transform', child: 7, layer: 0, frames: [frame()] },
          { id: 7, type: 'shape', models: [{ model: 2 }] },
        ],
      },
      at = [int(100) - 50, int(100) - 50, int(100) - 50];
    let cells;
    if (trial % 2) {
      const [model] = models,
        v = model.voxels;
      cells = [];
      for (let i = 0; i < v.length; i += 4)
        cells.push([at[0] + v[i], at[1] + v[i + 2], at[2] + model.size[1] - 1 - v[i + 1], v[i + 3]]);
    } else {
      const { min, voxels } = oracle(scene);
      cells = voxels.map(([x, y, z, index]) => [x - min[0] + at[0], y - min[1] + at[1], z - min[2] + at[2], index]);
    }
    const batched = comparedWorld(trial),
      single = comparedWorld(trial),
      count = pasteVoxModel(batched.world, trial % 2 ? models[0] : scene, at, mapping);
    assert.equal(count, pasteBySetBlock(single.world, cells, mapping), `trial ${trial}: changed cells`);
    const a = batched.result(),
      b = single.result();
    assert.equal(a.stale, 0, `trial ${trial}: an onChange call saw its cell unwritten`);
    for (const key of ['dirty', 'added', 'changes', 'cells'])
      assert.deepEqual(a[key], b[key], `trial ${trial}: ${key}`);
    changed += count;
  }
  assert.ok(changed > 100000, `${changed} cells changed`);
});

test('benchmark: parse, write and paste a 1M-voxel model (printed)', (t) => {
  const next = random(2),
    voxels = new Uint8Array(4 << 20);
  for (let i = 0; i < voxels.length; i += 4)
    voxels.set([next() * 256, next() * 256, next() * 256, 1 + next() * 255], i);
  const scene = {
    version: 200,
    models: [{ size: [256, 256, 256], voxels }],
    palette: new Uint8Array(1024),
    materials: [],
    nodes: [],
    layers: [],
  };
  let start = performance.now();
  const bytes = writeVox(scene);
  const write = performance.now() - start;
  start = performance.now();
  const back = parseVox(bytes);
  const parse = performance.now() - start;
  t.diagnostic(
    `1,048,576 voxels (${(bytes.length / 2 ** 20).toFixed(1)} MiB): write ${write.toFixed(1)} ms, parse ${parse.toFixed(1)} ms`,
  );
  // Pasting, best of 3, against one setBlock per voxel: random cells, and the tree.vox fixture tiled 2,635 times.
  const mapping = Uint32Array.from({ length: 256 }, (_, i) => (i ? 1 + (i % 8) : 0)),
    world = () => {
      const blocks = new BlockTypes();
      for (let i = 1; i <= 8; i++) blocks.define(`b${i}`);
      return new VoxelWorld({ blocks });
    },
    best = (run) => {
      let ms = Infinity,
        w,
        changed;
      for (let r = 0; r < 3; r++) {
        w = world();
        const begin = performance.now();
        changed = run(w);
        ms = Math.min(ms, performance.now() - begin);
      }
      return { ms, w, changed };
    },
    tiles = 2635,
    source = parseVox(new Uint8Array(readFileSync(new URL('./fixtures/tree.vox', import.meta.url)))),
    [model] = source.models,
    [, sizeY] = model.size,
    step = Math.max(model.size[0], sizeY),
    tile = (k) => [step * (k % 52), step * Math.floor(k / 52), 0],
    lastRow = step * Math.floor((tiles - 1) / 52),
    tiled = {
      ...source,
      nodes: [
        { id: 0, type: 'transform', child: 1, layer: -1, frames: [{}] },
        { id: 1, type: 'group', children: Array.from({ length: tiles }, (_, k) => 2 + 2 * k) },
        ...Array.from({ length: tiles }, (_, k) => [
          { id: 2 + 2 * k, type: 'transform', child: 3 + 2 * k, layer: 0, frames: [{ translation: tile(k) }] },
          { id: 3 + 2 * k, type: 'shape', models: [{ model: 0 }] },
        ]).flat(),
      ],
      layers: [{ id: 0 }],
    };
  // The model (size s) centred on translation t: MagicaVoxel cell c = t + v - h, h = floor(s / 2), becomes world
  // (c0, c2, -1 - c1); the pasted box's minimum corner, (-h0, -h2, -1 - (lastRow + s1 - 1 - h1)), goes to the origin,
  // so cell v of the tile at (tx, ty) lands at (tx + v0, v2, lastRow + s1 - 1 - ty - v1).
  const modelCells = [],
    randomCells = [];
  for (let k = 0; k < tiles; k++) {
    const [tx, ty] = tile(k),
      v = model.voxels;
    for (let i = 0; i < v.length; i += 4)
      modelCells.push([tx + v[i], v[i + 2], lastRow + sizeY - 1 - ty - v[i + 1], v[i + 3]]);
  }
  for (let i = 0; i < voxels.length; i += 4)
    randomCells.push([voxels[i], voxels[i + 2], 255 - voxels[i + 1], voxels[i + 3]]);
  for (const [name, target, cells] of [
    ['random cells in a 256^3 box', back.models[0], randomCells],
    [`tree.vox x ${tiles} (${(tiles * model.voxels.length) / 4} voxels)`, tiled, modelCells],
  ]) {
    const batched = best((w) => pasteVoxModel(w, target, [0, 0, 0], mapping)),
      single = best((w) => pasteBySetBlock(w, cells, mapping));
    assert.equal(batched.changed, single.changed, name);
    for (let i = 0; i < cells.length; i += 997)
      assert.equal(batched.w.getBlock(...cells[i].slice(0, 3)), single.w.getBlock(...cells[i].slice(0, 3)), name);
    t.diagnostic(`paste ${name}: ${batched.ms.toFixed(0)} ms (one setBlock per voxel: ${single.ms.toFixed(0)} ms)`);
  }
});
