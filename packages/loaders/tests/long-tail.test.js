// The small format entries: 3DS and its TDS name, LWO, AMF, MD2, PDB and KMZ, each from a file built here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse3DS } from '../dist/3ds.js';
import { parseTDS } from '../dist/tds.js';
import { parseLWO } from '../dist/lwo.js';
import { parseAMF } from '../dist/amf.js';
import { parseMD2 } from '../dist/md2.js';
import { parsePDB } from '../dist/pdb.js';
import { parseKMZ } from '../dist/kmz.js';
import { crc32, LoaderError } from '../dist/common.js';

const text = (value) => new TextEncoder().encode(value);
const isError = (format, code) => (error) =>
  error instanceof LoaderError && error.format === format && error.code === code;
const near = (actual, expected, tolerance = 1e-5) => {
  assert.equal(actual.length, expected.length, `${[...actual]} against ${expected}`);
  [...actual].forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < tolerance, `${[...actual]} against ${expected}`));
};
const normalZ = ({ positions: p, indices: t }, at = 0) => {
  const [a, b, c] = [t[at] * 3, t[at + 1] * 3, t[at + 2] * 3];
  return (p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a]);
};

function zip(files) {
  const locals = [],
    centrals = [];
  let offset = 0;
  for (const [path, content] of Object.entries(files)) {
    const data = typeof content === 'string' ? text(content) : content,
      name = text(path),
      crc = crc32(data),
      local = new Uint8Array(30 + name.length + data.length),
      lv = new DataView(local.buffer),
      central = new Uint8Array(46 + name.length),
      cv = new DataView(central.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const size = centrals.reduce((n, c) => n + c.length, 0),
    end = new Uint8Array(22),
    ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, size, true);
  ev.setUint32(16, offset, true);
  return Buffer.concat([...locals, ...centrals, end]);
}

// 3DS: little-endian chunks.
const chunk = (id, ...parts) => {
  const body = Buffer.concat(parts.map((part) => Buffer.from(part))),
    head = Buffer.alloc(6);
  head.writeUInt16LE(id, 0);
  head.writeUInt32LE(body.length + 6, 2);
  return Buffer.concat([head, body]);
};
const cstr = (value) => Buffer.from(`${value}\0`, 'latin1');
const u16 = (...values) => {
  const out = Buffer.alloc(values.length * 2);
  values.forEach((value, i) => out.writeUInt16LE(value, i * 2));
  return out;
};
const f32 = (...values) => {
  const out = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => out.writeFloatLE(value, i * 4));
  return out;
};
const QUAD = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
function studio({ material = true, uv = true } = {}) {
  const faces = chunk(
    0x4120,
    u16(2),
    u16(0, 1, 2, 0, 0, 2, 3, 0),
    material ? chunk(0x4130, cstr('Red'), u16(1), u16(1)) : [],
  );
  const mesh = chunk(
    0x4100,
    chunk(0x4110, u16(4), f32(...QUAD)),
    uv ? chunk(0x4140, u16(4), f32(0, 0, 1, 0, 1, 1, 0, 1)) : [],
    faces,
  );
  const redMaterial = chunk(
    0xafff,
    chunk(0xa000, cstr('Red')),
    chunk(0xa020, chunk(0x0011, [255, 0, 0])),
    chunk(0xa050, chunk(0x0030, u16(25))),
    chunk(0xa200, chunk(0xa300, cstr('brick.png'))),
  );
  // The mesh comes before the material it names, which files do.
  return chunk(0x4d4d, chunk(0x3d3d, chunk(0x0100, f32(2.5)), chunk(0x4000, cstr('box'), mesh), redMaterial));
}

test('3DS: a mesh, its UVs, a material after it and a face list', () => {
  const model = parse3DS(studio());
  near(model.positions, QUAD);
  near(model.uvs, [0, 1, 1, 1, 1, 0, 0, 0]);
  assert.equal(model.masterScale, 2.5);
  assert.deepEqual(model.materials[0].texture, 'brick.png');
  near(model.materials[0].color, [1, 0, 0, 0.75]);
  assert.deepEqual(
    model.groups.map(({ start, count, name, material }) => [start, count, name, material]),
    [
      [0, 3, 'box', 0],
      [3, 3, 'box', undefined],
    ],
  );
  assert.deepEqual([...model.indices], [0, 2, 3, 0, 1, 2]);
  near(model.groups[0].color, [1, 0, 0, 0.75]);
});

test('3DS: two meshes share one index space, and one without UVs stays aligned', () => {
  const plain = chunk(0x4100, chunk(0x4110, u16(3), f32(0, 0, 0, 1, 0, 0, 0, 1, 0)), chunk(0x4120, u16(1), u16(0, 1, 2, 0)));
  const textured = chunk(
    0x4100,
    chunk(0x4110, u16(3), f32(0, 0, 1, 1, 0, 1, 0, 1, 1)),
    chunk(0x4140, u16(3), f32(0, 0, 1, 0, 0, 1)),
    chunk(0x4120, u16(1), u16(0, 1, 2, 0)),
  );
  const model = parse3DS(chunk(0x4d4d, chunk(0x3d3d, chunk(0x4000, cstr('a'), plain), chunk(0x4000, cstr('b'), textured))));
  assert.deepEqual([...model.indices], [0, 1, 2, 3, 4, 5]);
  assert.equal(model.uvs.length, 12);
  near(model.uvs.subarray(6), [0, 1, 1, 1, 0, 0]);
});

test('3DS: bad files are named errors, and TDS is the same reader', () => {
  assert.equal(parseTDS, parse3DS);
  assert.throws(() => parse3DS(new Uint8Array(3)), isError('3DS', 'header'));
  assert.throws(() => parse3DS(Buffer.from([1, 2, 3, 4, 5, 6, 7])), isError('3DS', 'header'));
  assert.throws(() => parse3DS(studio().subarray(0, 20)), isError('3DS', 'truncated'));
  assert.throws(() => parse3DS(chunk(0x4d4d, chunk(0x3d3d))), isError('3DS', 'syntax'));
  assert.throws(() => parse3DS(studio(), { maxVertices: 2 }), isError('3DS', 'limit'));
  assert.throws(() => parse3DS(studio(), { maxTriangles: 1 }), isError('3DS', 'limit'));
  const badFace = chunk(0x4d4d, chunk(0x3d3d, chunk(0x4000, cstr('a'), chunk(0x4100, chunk(0x4110, u16(1), f32(0, 0, 0)), chunk(0x4120, u16(1), u16(0, 1, 2, 0))))));
  assert.throws(() => parse3DS(badFace), isError('3DS', 'range'));
  const lying = Buffer.from(studio());
  lying.writeUInt32LE(9, 8);
  assert.throws(() => parse3DS(lying), isError('3DS', 'truncated'));
});

// LWO: big-endian IFF.
const beU16 = (...values) => {
  const out = Buffer.alloc(values.length * 2);
  values.forEach((value, i) => out.writeUInt16BE(value, i * 2));
  return out;
};
const beF32 = (...values) => {
  const out = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => out.writeFloatBE(value, i * 4));
  return out;
};
const even = (value) => Buffer.from(`${value}\0${value.length % 2 ? '' : '\0'}`, 'latin1');
const iff = (id, ...parts) => {
  const body = Buffer.concat(parts.map((part) => Buffer.from(part))),
    head = Buffer.alloc(8);
  head.write(id, 0, 'latin1');
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body, Buffer.alloc(body.length % 2)]);
};
const lwo = (...chunks) => {
  const body = Buffer.concat([Buffer.from('LWO2'), ...chunks]),
    head = Buffer.alloc(8);
  head.write('FORM', 0, 'latin1');
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
};
const surfaceColor = (name, r, g, b) => {
  const part = Buffer.concat([Buffer.from('COLR'), beU16(14), beF32(r, g, b), beU16(0)]);
  return iff('SURF', even(name), even(''), part);
};
// Clockwise seen from -z, LightWave's front in its left-handed axes.
const LWO_POINTS = iff('PNTS', beF32(0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0));
const LWO_FACE = iff('POLS', Buffer.from('FACE'), beU16(4, 0, 1, 2, 3));

test('LWO: a polygon triangulates, turns right-handed and takes its surface colour', () => {
  const model = parseLWO(
    lwo(
      iff('TAGS', even('Default'), even('Wood')),
      iff('LAYR', beU16(0, 0), beF32(0, 0, 0), even('Base')),
      LWO_POINTS,
      LWO_FACE,
      iff('PTAG', Buffer.from('SURF'), beU16(0, 1)),
      surfaceColor('Wood', 0.5, 0.25, 0),
    ),
  );
  assert.equal(model.indices.length, 6);
  assert.equal(model.groups[0].name, 'Wood');
  assert.equal(model.groups[0].objectId, 'Base');
  near(model.groups[0].color, [0.5, 0.25, 0, 1]);
  assert.ok(normalZ(model) < 0, 'the file looks along -z at the front: the normal points back at it');
});

test('LWO: a z coordinate changes sign, from left-handed to right-handed', () => {
  const model = parseLWO(lwo(iff('PNTS', beF32(0, 0, 2, 1, 0, 2, 0, 1, 2)), iff('POLS', Buffer.from('FACE'), beU16(3, 0, 1, 2))));
  near(model.positions.subarray(0, 3), [0, 0, -2]);
});

test('LWO: a UV map, with a discontinuous value that splits a vertex along a seam', () => {
  const map = iff(
    'VMAP',
    Buffer.from('TXUV'),
    beU16(2),
    even('uv'),
    ...[0, 1, 2, 3].flatMap((point) => [beU16(point), beF32(point / 4, 0)]),
  );
  const seam = iff('VMAD', Buffer.from('TXUV'), beU16(2), even('uv'), beU16(2, 1), beF32(0.9, 0.5));
  const model = parseLWO(
    lwo(
      iff('PNTS', beF32(0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0)),
      iff('POLS', Buffer.from('FACE'), beU16(3, 0, 1, 2), beU16(3, 0, 2, 3)),
      map,
      seam,
    ),
  );
  assert.equal(model.positions.length / 3, 5, 'point 2 has two coordinates, so two vertices');
  const uvsAt = (x, y) => {
    const found = [];
    for (let v = 0; v < model.positions.length / 3; v++)
      if (model.positions[v * 3] === x && model.positions[v * 3 + 1] === y)
        found.push(Math.round(model.uvs[v * 2] * 100) / 100);
    return found.sort();
  };
  assert.deepEqual(uvsAt(1, 1), [0.5, 0.9]);
  near(model.uvs.subarray(1, 2), [1]);
});

test('LWO: layers keep their own point numbers, a large index reads, and the old LWOB form works', () => {
  const twoLayers = parseLWO(
    lwo(
      iff('LAYR', beU16(0, 0), beF32(0, 0, 0), even('a')),
      iff('PNTS', beF32(0, 0, 0, 1, 0, 0, 0, 1, 0)),
      iff('POLS', Buffer.from('FACE'), beU16(3, 0, 1, 2)),
      iff('LAYR', beU16(1, 0), beF32(0, 0, 0), even('b')),
      iff('PNTS', beF32(0, 0, 1, 1, 0, 1, 0, 1, 1)),
      iff('POLS', Buffer.from('FACE'), beU16(3, 0, 1, 2)),
    ),
  );
  assert.deepEqual([...twoLayers.indices], [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(twoLayers.groups.map((g) => g.objectId), ['a', 'b']);
  const wideIndex = Buffer.from([0xff, 0, 0, 2]);
  const wide = parseLWO(
    lwo(iff('PNTS', beF32(0, 0, 0, 1, 0, 0, 0, 1, 0)), iff('POLS', Buffer.from('FACE'), beU16(3, 0, 1), wideIndex)),
  );
  assert.equal(wide.indices.length, 3);
  const old = Buffer.concat([
    Buffer.from('LWOB'),
    iff('PNTS', beF32(0, 0, 0, 1, 0, 0, 0, 1, 0)),
    iff('SRFS', even('Old')),
    iff('POLS', beU16(3, 0, 1, 2, 1)),
    iff('SURF', even('Old'), Buffer.concat([Buffer.from('COLR'), beU16(4), Buffer.from([255, 0, 0, 0])])),
  ]);
  const head = Buffer.alloc(8);
  head.write('FORM', 0, 'latin1');
  head.writeUInt32BE(old.length, 4);
  const model = parseLWO(Buffer.concat([head, old]));
  assert.equal(model.groups[0].name, 'Old');
  near(model.groups[0].color, [1, 0, 0, 1]);
});

test('LWO: bad files are named errors, and other polygon kinds warn', () => {
  assert.throws(() => parseLWO(new Uint8Array(4)), isError('LWO', 'header'));
  assert.throws(() => parseLWO(Buffer.from('FORM\0\0\0\x04XXXX')), isError('LWO', 'header'));
  assert.throws(() => parseLWO(Buffer.from('NOPE\0\0\0\x04LWO2')), isError('LWO', 'header'));
  assert.throws(() => parseLWO(lwo(LWO_POINTS)), isError('LWO', 'syntax'));
  assert.throws(() => parseLWO(lwo(iff('PNTS', beF32(0, 0)))), isError('LWO', 'syntax'));
  assert.throws(() => parseLWO(lwo(LWO_POINTS, iff('POLS', Buffer.from('FACE'), beU16(3, 0, 1, 9)))), isError('LWO', 'range'));
  assert.throws(() => parseLWO(lwo(LWO_POINTS, LWO_FACE, iff('PTAG', Buffer.from('SURF'), beU16(5, 0)))), isError('LWO', 'range'));
  assert.throws(() => parseLWO(lwo(LWO_POINTS, iff('POLS', Buffer.from('FACE'), beU16(4, 0)))), isError('LWO', 'truncated'));
  assert.throws(() => parseLWO(lwo(LWO_POINTS, LWO_FACE), { maxVertices: 3 }), isError('LWO', 'limit'));
  assert.throws(() => parseLWO(lwo(LWO_POINTS, LWO_FACE), { maxTriangles: 1 }), isError('LWO', 'limit'));
  const model = parseLWO(lwo(LWO_POINTS, iff('POLS', Buffer.from('PTCH'), beU16(4, 0, 1, 2, 3)), LWO_FACE, iff('CLIP', beU16(0))));
  assert.deepEqual(model.warnings, ['PTCH polygons are not read', 'image maps are not read']);
});

// AMF.
const vertex = (x, y, z, extra = '') =>
  `<vertex><coordinates><x>${x}</x><y>${y}</y><z>${z}</z></coordinates>${extra}</vertex>`;
const tri = (a, b, c) => `<triangle><v1>${a}</v1><v2>${b}</v2><v3>${c}</v3></triangle>`;
const object = (id, volumes = `<volume>${tri(0, 1, 2)}</volume>`, extra = '') =>
  `<object id="${id}">${extra}<mesh><vertices>${vertex(0, 0, 0)}${vertex(10, 0, 0)}${vertex(0, 10, 0)}</vertices>${volumes}</mesh></object>`;
const amf = (body, attributes = 'unit="millimeter"') => text(`<?xml version="1.0"?><amf ${attributes}>${body}</amf>`);
const rejects = (promise, format, code) => assert.rejects(promise, isError(format, code));

test('AMF: units, plain and zipped, and a metadata name', async () => {
  const body = object('1', undefined, '<metadata type="name">Bracket</metadata>');
  const model = await parseAMF(amf(`<metadata type="author">x</metadata>${body}`));
  near(model.positions, [0, 0, 0, 0.01, 0, 0, 0, 0.01, 0]);
  assert.equal(model.groups[0].name, 'Bracket');
  assert.equal(model.metadata.author, 'x');
  near((await parseAMF(amf(body, 'unit="inch"'), { units: 'file' })).positions.subarray(3, 4), [10]);
  near((await parseAMF(amf(body, 'unit="inch"'))).positions.subarray(3, 4), [0.254]);
  near((await parseAMF(zip({ 'part.amf': amf(body) }))).positions.subarray(3, 4), [0.01]);
});

test('AMF: volume, material, object and vertex colours', async () => {
  const color = (r, g, b) => `<color><r>${r}</r><g>${g}</g><b>${b}</b></color>`;
  const model = await parseAMF(
    amf(
      `<material id="5">${color(0, 1, 0)}</material>` +
        object(
          '1',
          `<volume materialid="5">${tri(0, 1, 2)}</volume><volume>${color(0, 0, 1)}${tri(0, 1, 2)}</volume><volume>${tri(0, 1, 2)}</volume>`,
          color(1, 0, 0),
        ),
    ),
  );
  assert.deepEqual(model.groups.map((g) => g.color), [
    [0, 1, 0, 1],
    [0, 0, 1, 1],
    [1, 0, 0, 1],
  ]);
  const painted = await parseAMF(
    amf(
      `<object id="1"><mesh><vertices>${vertex(0, 0, 0, color(1, 0, 0))}${vertex(1, 0, 0)}${vertex(0, 1, 0)}</vertices><volume>${tri(0, 1, 2)}</volume></mesh></object>`,
    ),
  );
  near(painted.colors, [1, 0, 0, 1, 1, 1, 1, 1, 1]);
  const formula = await parseAMF(amf(object('1', undefined, '<color><r>x/10</r><g>0</g><b>0</b></color>')));
  assert.deepEqual(formula.warnings, ['colour formulas are not read']);
});

test('AMF: a constellation places objects, nests, and a turn goes before its move', async () => {
  const model = await parseAMF(
    amf(
      `${object('1')}<constellation id="2"><instance objectid="1"><deltax>100</deltax><rz>90</rz></instance><instance objectid="1"><deltay>5</deltay></instance></constellation><constellation id="3"><instance objectid="2"><deltaz>1000</deltaz></instance></constellation>`,
    ),
    { units: 'file' },
  );
  assert.equal(model.groups.length, 2, 'the inner constellation is not a second root');
  near(model.positions.subarray(0, 3), [100, 0, 1000]);
  near(model.positions.subarray(3, 6), [100, 10, 1000], 1e-4);
  near(model.positions.subarray(9, 12), [0, 5, 1000]);
});

test('AMF: bad files are named errors', async () => {
  await rejects(parseAMF(text('<other/>')), 'AMF', 'header');
  await rejects(parseAMF(amf(object('1'), 'unit="cubit"')), 'AMF', 'unsupported');
  await rejects(parseAMF(amf('')), 'AMF', 'syntax');
  await rejects(parseAMF(amf(object('1', `<volume>${tri(0, 1, 7)}</volume>`))), 'AMF', 'range');
  await rejects(parseAMF(amf(object('1', `<volume><triangle><v1>0</v1></triangle></volume>`))), 'AMF', 'syntax');
  await rejects(parseAMF(amf('<object id="1"><mesh/></object>')), 'AMF', 'syntax');
  await rejects(parseAMF(amf(`<constellation id="2"><instance objectid="9"/></constellation>`)), 'AMF', 'syntax');
  await rejects(parseAMF(amf(`<constellation id="2"><instance objectid="2"/></constellation>`)), 'AMF', 'syntax');
  await rejects(parseAMF(amf(object('1')), { maxVertices: 2 }), 'AMF', 'limit');
  await rejects(parseAMF(amf(object('1')), { maxTriangles: 0 }), 'AMF', 'limit');
  await rejects(parseAMF(amf(object('1')), { units: 'feet' }), 'AMF', 'range');
  const controller = new AbortController();
  controller.abort();
  await rejects(parseAMF(amf(object('1')), { signal: controller.signal }), 'AMF', 'aborted');
});

// MD2.
function md2({ version = 8, frames = ['run1', 'run2', 'stand'], tris = [[0, 1, 2, 0, 1, 2], [0, 2, 3, 3, 2, 1]] } = {}) {
  const vertices = 4,
    coords = [
      [0, 0],
      [64, 0],
      [64, 32],
      [0, 32],
    ],
    frameSize = 40 + vertices * 4,
    header = 68,
    skinsAt = header,
    coordsAt = skinsAt + 64,
    trisAt = coordsAt + coords.length * 4,
    framesAt = trisAt + tris.length * 12,
    out = Buffer.alloc(framesAt + frames.length * frameSize);
  out.write('IDP2', 0, 'latin1');
  [version, 64, 32, frameSize, 1, vertices, coords.length, tris.length, 0, frames.length, skinsAt, coordsAt, trisAt, framesAt, 0, out.length].forEach(
    (value, i) => out.writeInt32LE(value, 4 + i * 4),
  );
  out.write('models/skin.pcx', skinsAt, 'latin1');
  coords.forEach(([s, t], i) => {
    out.writeInt16LE(s, coordsAt + i * 4);
    out.writeInt16LE(t, coordsAt + i * 4 + 2);
  });
  tris.forEach((triangle, i) => triangle.forEach((value, k) => out.writeUInt16LE(value, trisAt + i * 12 + k * 2)));
  frames.forEach((name, f) => {
    const at = framesAt + f * frameSize;
    [1, 1, 1, f, 0, 0].forEach((value, i) => out.writeFloatLE(value, at + i * 4));
    out.write(name, at + 24, 'latin1');
    [
      [0, 0, 0],
      [0, 10, 0],
      [10, 10, 0],
      [10, 0, 0],
    ].forEach((xyz, v) => xyz.forEach((value, c) => (out[at + 40 + v * 4 + c] = value)));
  });
  return out;
}

test('MD2: frames share one layout, moved by their own scale and offset', () => {
  const model = parseMD2(md2());
  assert.equal(model.frames.length, 3);
  assert.equal(model.positions, model.frames[0].positions);
  assert.deepEqual(model.skins, ['models/skin.pcx']);
  assert.equal(model.frames[1].positions.length, model.positions.length);
  near(model.frames[1].positions.subarray(0, 1), [model.positions[0] + 1]);
});

test('MD2: a vertex with two texture coordinates splits, and uvs are over the skin size', () => {
  const model = parseMD2(md2());
  // Vertex 0 appears with coordinates 0 and 3, and the others with one each, so 4 vertices become 5.
  assert.equal(model.positions.length / 3, 5);
  const seen = new Set();
  for (let v = 0; v < model.uvs.length / 2; v++) seen.add(`${model.uvs[v * 2]} ${model.uvs[v * 2 + 1]}`);
  assert.ok(seen.has('1 1') && seen.has('0 0') && seen.has('1 0') && seen.has('0 1'));
});

test('MD2: clockwise fronts turn counter-clockwise, and the normal agrees', () => {
  // The first triangle runs (0,0) (0,10) (10,10): clockwise seen from +z.
  const model = parseMD2(md2());
  assert.ok(normalZ(model) > 0);
  assert.ok(model.normals[2] > 0.99);
});

test('MD2: frames with one stem form clips', () => {
  assert.deepEqual(parseMD2(md2()).clips, [
    { name: 'run', start: 0, count: 2 },
    { name: 'stand', start: 2, count: 1 },
  ]);
});

test('MD2: bad files are named errors', () => {
  assert.throws(() => parseMD2(new Uint8Array(10)), isError('MD2', 'header'));
  assert.throws(() => parseMD2(Buffer.alloc(80)), isError('MD2', 'header'));
  assert.throws(() => parseMD2(md2({ version: 7 })), isError('MD2', 'header'));
  assert.throws(() => parseMD2(md2({ frames: [] })), isError('MD2', 'range'));
  assert.throws(() => parseMD2(md2({ tris: [[9, 1, 2, 0, 1, 2]] })), isError('MD2', 'range'));
  assert.throws(() => parseMD2(md2({ tris: [[0, 1, 2, 0, 1, 9]] })), isError('MD2', 'range'));
  assert.throws(() => parseMD2(md2().subarray(0, 120)), isError('MD2', 'truncated'));
  assert.throws(() => parseMD2(md2(), { maxVertices: 6 }), isError('MD2', 'limit'));
  assert.throws(() => parseMD2(md2(), { maxTriangles: 1 }), isError('MD2', 'limit'));
});

// PDB.
const atom = (serial, name, residue, chain, sequence, x, y, z, element = '', record = 'ATOM', alt = ' ') =>
  `${record.padEnd(6)}${String(serial).padStart(5)} ${name.padEnd(4)}${alt}${residue.padStart(3)} ${chain}${String(sequence).padStart(4)}    ${x.toFixed(3).padStart(8)}${y.toFixed(3).padStart(8)}${z.toFixed(3).padStart(8)}  1.00  0.00          ${element.padStart(2)}`;

test('PDB: atoms read by column, with labels, colours and radii', () => {
  const molecule = parsePDB(
    [
      'TITLE     A SMALL',
      'TITLE    2 MOLECULE',
      atom(1, ' N', 'ALA', 'A', 1, 1.5, 2.5, -3.5, 'N'),
      atom(2, 'FE', 'HEM', 'B', 2, 0, 0, 9, 'FE', 'HETATM'),
    ].join('\r\n'),
  );
  near(molecule.positions, [1.5, 2.5, -3.5, 0, 0, 9]);
  assert.equal(molecule.title, 'A SMALL MOLECULE');
  assert.deepEqual(molecule.atoms[0], { serial: 1, name: 'N', element: 'N', residue: 'ALA', sequence: 1, chain: 'A', hetero: false });
  assert.equal(molecule.atoms[1].hetero, true);
  near(molecule.colors.subarray(0, 3), [0x30 / 255, 0x50 / 255, 0xf8 / 255]);
  near(molecule.radii, [0.71, 1.32]);
});

test('PDB: an empty element column falls back on the name, where the columns tell carbon from calcium', () => {
  const molecule = parsePDB([atom(1, ' CA', 'ALA', 'A', 1, 0, 0, 0), atom(2, 'CA', ' CA', 'A', 2, 9, 0, 0), atom(3, '1HB', 'ALA', 'A', 1, 20, 0, 0)].join('\n'));
  assert.deepEqual(molecule.atoms.map((a) => a.element), ['C', 'CA', 'H']);
});

test('PDB: CONECT rows and distance both give bonds, each once', () => {
  const lines = [atom(1, ' C', 'ALA', 'A', 1, 0, 0, 0, 'C'), atom(2, ' C', 'ALA', 'A', 1, 1.5, 0, 0, 'C'), atom(3, ' C', 'ALA', 'A', 1, 50, 0, 0, 'C')];
  assert.deepEqual([...parsePDB(lines.join('\n')).bonds], [0, 1]);
  const linked = [...lines, 'CONECT    1    2    3', 'CONECT    2    1'].join('\n');
  assert.deepEqual([...parsePDB(linked).bonds], [0, 1, 0, 2]);
  assert.deepEqual([...parsePDB(linked, { guessBonds: false }).bonds], [0, 1, 0, 2]);
  assert.deepEqual([...parsePDB(lines.join('\n'), { guessBonds: false }).bonds], []);
});

test('PDB: only the first model loads, its CONECT rows still do, and alternate locations keep the first', () => {
  const molecule = parsePDB(
    [
      'MODEL        1',
      atom(1, ' C', 'ALA', 'A', 1, 0, 0, 0, 'C', 'ATOM', 'A'),
      atom(2, ' C', 'ALA', 'A', 1, 0.2, 0, 0, 'C', 'ATOM', 'B'),
      atom(3, ' O', 'ALA', 'A', 1, 40, 0, 0, 'O'),
      'ENDMDL',
      'MODEL        2',
      atom(4, ' C', 'ALA', 'A', 1, 9, 9, 9, 'C'),
      'ENDMDL',
      'CONECT    1    3',
      'CONECT    1    4',
    ].join('\n'),
  );
  assert.equal(molecule.atoms.length, 2);
  assert.deepEqual([...molecule.bonds], [0, 1]);
  assert.deepEqual(molecule.warnings, ['only the first MODEL is read', 'CONECT names atoms that were not read']);
});

test('PDB: bad files are named errors', () => {
  assert.throws(() => parsePDB('HEADER    NOTHING\n'), isError('PDB', 'syntax'));
  assert.throws(() => parsePDB('ATOM      1  N   ALA A   1      abcdefgh   0.000   0.000\n'), isError('PDB', 'syntax'));
  assert.throws(() => parsePDB(atom(1, ' C', 'ALA', 'A', 1, 0, 0, 0, 'C'), { maxVertices: 0 }), isError('PDB', 'limit'));
});

// KMZ.
const DAE = `<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1"><library_geometries><geometry id="g"><mesh><source id="p"><float_array id="pa" count="9">0 0 0 1 0 0 0 1 0</float_array><technique_common><accessor source="#pa" count="3" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source><vertices id="v"><input semantic="POSITION" source="#p"/></vertices><triangles count="1"><input semantic="VERTEX" source="#v" offset="0"/><p>0 1 2</p></triangles></mesh></geometry></library_geometries><library_visual_scenes><visual_scene id="s"><node id="n"><instance_geometry url="#g"/></node></visual_scene></library_visual_scenes><scene><instance_visual_scene url="#s"/></scene></COLLADA>`;
const KML = `<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>Tower</name><Model><Location><longitude>-79.38</longitude><latitude>43.64</latitude><altitude>12</altitude></Location><Orientation><heading>90</heading></Orientation><Scale><x>2</x><y>2</y><z>2</z></Scale><Link><href>models/tower.dae</href></Link></Model></Placemark></Document></kml>`;

test('KMZ: a model with its place on the Earth, and the archive stays readable', async () => {
  const image = new Uint8Array([1, 2, 3]);
  const { models, files, read } = await parseKMZ(zip({ 'doc.kml': KML, 'models/tower.dae': DAE, 'images/a.png': image }));
  assert.equal(models.length, 1);
  const [tower] = models;
  assert.equal(tower.name, 'Tower');
  assert.equal(tower.path, 'models/tower.dae');
  assert.deepEqual(tower.location, { longitude: -79.38, latitude: 43.64, altitude: 12 });
  assert.deepEqual(tower.orientation, { heading: 90, tilt: 0, roll: 0 });
  assert.deepEqual(tower.scale, [2, 2, 2]);
  assert.equal(tower.geometry.indices.length, 3);
  assert.ok(files.includes('images/a.png'));
  assert.deepEqual([...(await read('images/a.png'))], [...image]);
});

test('KMZ: a document in a folder finds its model beside it; no document gives every dae', async () => {
  const nested = await parseKMZ(zip({ 'files/doc.kml': KML.replace('models/tower.dae', 'tower.dae'), 'files/tower.dae': DAE }));
  assert.equal(nested.models[0].path, 'files/tower.dae');
  const bare = await parseKMZ(zip({ 'a.dae': DAE, 'b.DAE': DAE, 'note.txt': 'x' }));
  assert.deepEqual(bare.models.map((m) => m.path), ['a.dae', 'b.DAE']);
  assert.equal(bare.models[0].location, undefined);
});

test('KMZ: bad archives are named errors', async () => {
  await rejects(parseKMZ(text('not a zip')), 'KMZ', 'header');
  await rejects(parseKMZ(zip({ 'note.txt': 'x' })), 'KMZ', 'syntax');
  await rejects(parseKMZ(zip({ 'doc.kml': KML })), 'KMZ', 'syntax');
  await rejects(parseKMZ(zip({ 'doc.kml': '<kml><Model/></kml>' })), 'KMZ', 'syntax');
  await rejects(parseKMZ(zip({ 'doc.kml': KML.replace('43.64', 'north'), 'models/tower.dae': DAE })), 'KMZ', 'syntax');
  const { read } = await parseKMZ(zip({ 'a.dae': DAE }));
  await rejects(read('gone.png'), 'KMZ', 'syntax');
  const controller = new AbortController();
  controller.abort();
  await rejects(parseKMZ(zip({ 'a.dae': DAE }), { signal: controller.signal }), 'KMZ', 'aborted');
});
