// The small format entries: 3DS and its TDS name, LWO, AMF, MD2, PDB and KMZ, each from a file built here, and the
// resolver that reads the textures they name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse3DS } from '../dist/3ds.js';
import { parseTDS } from '../dist/tds.js';
import { parseLWO } from '../dist/lwo.js';
import { parseAMF } from '../dist/amf.js';
import { parseMD2 } from '../dist/md2.js';
import { parsePDB } from '../dist/pdb.js';
import { parseKMZ } from '../dist/kmz.js';
import { loadTextures } from '../dist/textures.js';
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

// A key is a frame, a used-fields mask, the spline values that mask names, then the value.
const u32 = (...values) => {
  const out = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => out.writeUInt32LE(value, i * 4));
  return out;
};
const track = (id, ...keys) =>
  chunk(id, u16(0), Buffer.alloc(8), u32(keys.length), ...keys.flatMap(([frame, mask, ...floats]) => [u32(frame), u16(mask), f32(...floats)]));
const BOX = chunk(0x4000, cstr('box'), chunk(0x4100, chunk(0x4110, u16(3), f32(0, 0, 0, 1, 0, 0, 0, 1, 0)), chunk(0x4120, u16(1), u16(0, 1, 2, 0))));
const scene = (...parts) => chunk(0x4d4d, chunk(0x3d3d, BOX, ...parts.filter((part) => part.readUInt16LE(0) !== 0xb000)), ...parts.filter((part) => part.readUInt16LE(0) === 0xb000));

test('3DS: cameras, lights and the ambient colour', () => {
  const model = parse3DS(
    scene(
      chunk(0x2100, chunk(0x0010, f32(0.5, 0.25, 0))),
      chunk(0x4000, cstr('Cam'), chunk(0x4700, f32(1, 2, 3, 4, 5, 6, 15, 35), chunk(0x4720, f32(1, 100)))),
      chunk(0x4000, cstr('Bulb'), chunk(0x4600, f32(7, 8, 9), chunk(0x0010, f32(1, 0.5, 0)), chunk(0x4620), chunk(0x465b, f32(2)))),
      chunk(0x4000, cstr('Spot'), chunk(0x4600, f32(0, 0, 9), chunk(0x4610, f32(1, 1, 0, 30, 45)))),
    ),
  );
  assert.deepEqual(model.cameras, [{ name: 'Cam', position: [1, 2, 3], target: [4, 5, 6], roll: 15, lens: 35 }]);
  assert.deepEqual(model.lights[0], { name: 'Bulb', position: [7, 8, 9], color: [1, 0.5, 0], on: false, multiplier: 2 });
  assert.deepEqual(model.lights[1].spot, { target: [1, 1, 0], hotspot: 30, falloff: 45 });
  assert.deepEqual(model.lights[1].color, [1, 1, 1]);
  assert.equal(model.lights[1].on, true);
  assert.deepEqual(model.ambient, [0.5, 0.25, 0]);
  assert.equal(model.groups.length, 1, 'the mesh still reads');
  assert.deepEqual([parse3DS(studio()).cameras, parse3DS(studio()).lights, parse3DS(studio()).keyframes], [[], [], undefined]);
});

test('3DS: keyframer nodes, their hierarchy and tracks with spline values', () => {
  const object = chunk(
    0xb002,
    chunk(0xb030, u16(4)),
    chunk(0xb010, cstr('box'), u16(0, 0, 0xffff)),
    chunk(0xb013, f32(1, 2, 3)),
    track(0xb020, [0, 0, 0, 0, 0], [10, 0b00101, 0.5, 0.25, 1, 2, 3]),
    track(0xb021, [0, 0, 0, 0, 0, 1], [10, 0, 1.5, 0, 1, 0]),
    track(0xb022, [0, 0, 1, 1, 1]),
  );
  const child = chunk(
    0xb002,
    chunk(0xb030, u16(5)),
    chunk(0xb010, cstr('$$$DUMMY'), u16(0, 0, 4)),
    chunk(0xb011, cstr('handle')),
  );
  const camera = chunk(0xb003, chunk(0xb010, cstr('Cam'), u16(0, 0, 0xffff)), track(0xb023, [0, 0, 45]), track(0xb024, [3, 0, 10]));
  const model = parse3DS(
    scene(chunk(0xb000, chunk(0xb00a, u16(5), cstr('MAXSCENE'), u32(100)), chunk(0xb008, u32(10, 90)), object, child, camera)),
  );
  const { start, end, length, nodes } = model.keyframes;
  assert.deepEqual([start, end, length, nodes.length], [10, 90, 100, 3]);
  const [box, dummy, cam] = nodes;
  assert.deepEqual([box.id, box.kind, box.name, box.parent], [4, 'object', 'box', -1]);
  assert.deepEqual(box.pivot, [1, 2, 3]);
  assert.deepEqual(box.tracks.position.keys[1], { frame: 10, value: [1, 2, 3], tension: 0.5, bias: 0.25 });
  assert.deepEqual(box.tracks.rotation.keys[1], { frame: 10, value: [1.5, 0, 1, 0] });
  assert.deepEqual(box.tracks.scale.keys, [{ frame: 0, value: [1, 1, 1] }]);
  assert.deepEqual([dummy.parent, dummy.name, dummy.instance], [4, '$$$DUMMY', 'handle']);
  assert.deepEqual([cam.id, cam.kind, cam.tracks.fov.keys[0].value, cam.tracks.roll.keys[0].frame], [2, 'camera', [45], 3]);
});

test('3DS: broken camera, light and track chunks are named errors', () => {
  const truncated = isError('3DS', 'truncated');
  assert.throws(() => parse3DS(scene(chunk(0x4000, cstr('c'), chunk(0x4700, f32(1, 2))))), truncated);
  assert.throws(() => parse3DS(scene(chunk(0x4000, cstr('l'), chunk(0x4600, f32(1))))), truncated);
  assert.throws(() => parse3DS(scene(chunk(0x4000, cstr('l'), chunk(0x4600, f32(1, 2, 3), chunk(0x4610, f32(1, 2)))))), truncated);
  const lying = chunk(0xb020, u16(0), Buffer.alloc(8), u32(0xffffffff), u32(0), u16(0));
  assert.throws(() => parse3DS(scene(chunk(0xb000, chunk(0xb002, lying)))), truncated);
  assert.throws(() => parse3DS(scene(chunk(0xb000, chunk(0xb002, chunk(0xb010, cstr('x')))))), truncated);
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
  const model = parseLWO(lwo(LWO_POINTS, iff('POLS', Buffer.from('CURV'), beU16(4, 0, 1, 2, 3)), LWO_FACE, iff('CLIP', beU32(1), subchunk('ANIM', even('a.mov')))));
  assert.deepEqual(model.warnings, ['CURV polygons are not read', 'ANIM clips are not read']);
  assert.equal(model.indices.length, 6);
  assert.throws(() => parseLWO(lwo(LWO_POINTS, LWO_FACE, iff('CLIP', beU16(0)))), isError('LWO', 'truncated'));
  assert.throws(() => parseLWO(lwo(LWO_POINTS, LWO_FACE, iff('POLS', Buffer.from('BONE'), beU16(3, 0, 1, 2)))), isError('LWO', 'range'));
  assert.throws(() => parseLWO(lwo(LWO_POINTS, LWO_FACE, iff('POLS', Buffer.from('BONE'), beU16(2, 0, 9)))), isError('LWO', 'range'));
  assert.throws(
    () => parseLWO(lwo(LWO_POINTS, LWO_FACE, iff('POLS', Buffer.from('BONE'), beU16(2, 0, 1)), iff('PTAG', Buffer.from('BONE'), beU16(4, 0)))),
    isError('LWO', 'range'),
  );
});

const beU32 = (value) => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
};
/** An LWO sub-chunk: four letters, a 16-bit size, the body, a pad byte. */
const subchunk = (id, ...parts) => {
  const body = Buffer.concat(parts.map((part) => Buffer.from(part))),
    head = Buffer.alloc(6);
  head.write(id, 0, 'latin1');
  head.writeUInt16BE(body.length, 4);
  return Buffer.concat([head, body, Buffer.alloc(body.length % 2)]);
};
const uvMap = (name, offset) =>
  iff('VMAP', Buffer.from('TXUV'), beU16(2), even(name), ...[0, 1, 2, 3].flatMap((point) => [beU16(point), beF32(point / 4 + offset, 0)]));

test('LWO: every UV map comes through, and a seam in any of them splits the vertex for all', () => {
  const model = parseLWO(
    lwo(
      iff('PNTS', beF32(0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0)),
      iff('POLS', Buffer.from('FACE'), beU16(3, 0, 1, 2), beU16(3, 0, 2, 3)),
      uvMap('first', 0),
      uvMap('second', 0.1),
      iff('VMAD', Buffer.from('TXUV'), beU16(2), even('second'), beU16(2, 1), beF32(0.9, 0.5)),
    ),
  );
  assert.deepEqual(Object.keys(model.uvMaps), ['first', 'second']);
  assert.equal(model.positions.length / 3, 5);
  assert.deepEqual(model.uvs, model.uvMaps.first, 'uvs stays the first map');
  const at = (map, x, y) => {
    const found = [];
    for (let v = 0; v < model.positions.length / 3; v++)
      if (model.positions[v * 3] === x && model.positions[v * 3 + 1] === y) found.push(Math.round(map[v * 2] * 100) / 100);
    return found.sort();
  };
  assert.deepEqual(at(model.uvMaps.first, 1, 1), [0.5, 0.5], 'the first map holds the point value on both copies');
  assert.deepEqual(at(model.uvMaps.second, 1, 1), [0.6, 0.9]);
});

test('LWO: corners with the same seam value share a vertex', () => {
  const model = parseLWO(
    lwo(
      iff('PNTS', beF32(0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0)),
      iff('POLS', Buffer.from('FACE'), beU16(3, 0, 1, 2), beU16(3, 0, 2, 3)),
      uvMap('uv', 0),
      iff('VMAD', Buffer.from('TXUV'), beU16(2), even('uv'), beU16(2, 0), beF32(0.9, 0.5), beU16(2, 1), beF32(0.9, 0.5)),
    ),
  );
  assert.equal(model.positions.length / 3, 4);
});

test('LWO: a map in one layer leaves the other layer at zero and aligned', () => {
  const model = parseLWO(
    lwo(
      iff('LAYR', beU16(0, 0), beF32(0, 0, 0), even('a')),
      iff('PNTS', beF32(0, 0, 0, 1, 0, 0, 0, 1, 0)),
      iff('POLS', Buffer.from('FACE'), beU16(3, 0, 1, 2)),
      iff('LAYR', beU16(1, 0), beF32(0, 0, 0), even('b')),
      iff('PNTS', beF32(0, 0, 1, 1, 0, 1, 0, 1, 1)),
      iff('POLS', Buffer.from('FACE'), beU16(3, 0, 1, 2)),
      iff('VMAP', Buffer.from('TXUV'), beU16(2), even('late'), beU16(0), beF32(0.5, 0.5)),
    ),
  );
  assert.equal(model.uvs.length, 12);
  assert.equal(model.uvMaps.late.length, 12);
  near(model.uvMaps.late.subarray(0, 8), [0, 0, 0, 0, 0, 0, 0.5, 0.5]);
});

test('LWO: a surface image map names its clip, channel, projection and UV map', () => {
  const imap = subchunk('IMAP', even('\x80'), subchunk('CHAN', 'BUMP'), subchunk('ENAB', beU16(0)));
  const blok = subchunk('BLOK', imap, subchunk('PROJ', beU16(5)), subchunk('IMAG', beU16(3)), subchunk('VMAP', even('uv')));
  const gradient = subchunk('BLOK', subchunk('GRAD', even('\x80')));
  const model = parseLWO(
    lwo(
      iff('TAGS', even('Wood')),
      iff('CLIP', beU32(3), subchunk('STIL', even('Images:wood.jpg')), subchunk('BRIT', beF32(1), beU16(0))),
      LWO_POINTS,
      LWO_FACE,
      iff('PTAG', Buffer.from('SURF'), beU16(0, 0)),
      iff('SURF', even('Wood'), even(''), subchunk('COLR', beF32(1, 0, 0), beU16(0)), blok, gradient),
    ),
  );
  assert.deepEqual(model.images, [{ clip: 3, path: 'Images:wood.jpg' }]);
  assert.deepEqual(model.surfaces, [
    {
      name: 'Wood',
      color: [1, 0, 0],
      maps: [{ channel: 'BUMP', projection: 'uv', enabled: false, uvMap: 'uv', path: 'Images:wood.jpg' }],
    },
  ]);
  near(model.groups[0].color, [1, 0, 0, 1]);
  assert.deepEqual(model.warnings, []);
});

test('LWO: the old LWOB form names its image textures', () => {
  const body = Buffer.concat([
    Buffer.from('LWOB'),
    iff('PNTS', beF32(0, 0, 0, 1, 0, 0, 0, 1, 0)),
    iff('SRFS', even('Old')),
    iff('POLS', beU16(3, 0, 1, 2, 1)),
    iff(
      'SURF',
      even('Old'),
      subchunk('CTEX', even('Cylindrical Image Map')),
      subchunk('TIMG', even('C:\\maps\\WALL.JPG')),
      subchunk('BTEX', even('Fractal Noise')),
      subchunk('TIMG', even('(none)')),
    ),
  ]);
  const head = Buffer.alloc(8);
  head.write('FORM', 0, 'latin1');
  head.writeUInt32BE(body.length, 4);
  assert.deepEqual(parseLWO(Buffer.concat([head, body])).surfaces[0].maps, [
    { channel: 'COLR', projection: 'cylindrical', enabled: true, path: 'C:\\maps\\WALL.JPG' },
  ]);
});

test('LWO: skelegons become bones with names, parents and weight maps', () => {
  const model = parseLWO(
    lwo(
      iff('TAGS', even('Default'), even('Upper'), even('Lower'), even('Arm')),
      iff('PNTS', beF32(0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 2, 0, 2, 2)),
      iff('VMAP', Buffer.from('WGHT'), beU16(1), even('Arm'), beU16(0), beF32(0.25), beU16(2), beF32(1)),
      iff('POLS', Buffer.from('FACE'), beU16(3, 0, 1, 2)),
      iff('PTAG', Buffer.from('SURF'), beU16(0, 0)),
      iff('POLS', Buffer.from('BONE'), beU16(2, 4, 3), beU16(2, 3, 2)),
      iff('PTAG', Buffer.from('BONE'), beU16(0, 2, 1, 1)),
      iff('PTAG', Buffer.from('BNWT'), beU16(1, 3)),
      iff('PTAG', Buffer.from('SURF'), beU16(1, 3)),
    ),
  );
  assert.equal(model.groups[0].name, 'Default', 'a tag list after a BONE list leaves the faces alone');
  assert.equal(model.positions.length / 3, 3, 'skelegon points are not mesh vertices');
  near(model.weightMaps.Arm, [0.25, 0, 1]);
  assert.deepEqual(model.bones, [
    { start: [0, 2, -2], end: [0, 1, -2], parent: -1, layer: '', name: 'Lower' },
    { start: [0, 1, -2], end: [1, 1, -0], parent: 0, layer: '', name: 'Upper', weightMap: 'Arm' },
  ]);
});

test('LWO: a loop of bones still ends at a root', () => {
  const { bones } = parseLWO(lwo(LWO_POINTS, LWO_FACE, iff('POLS', Buffer.from('BONE'), beU16(2, 0, 1), beU16(2, 1, 0))));
  assert.deepEqual(bones.map((bone) => bone.parent), [1, -1]);
});

test('LWO: tags after a patch list stay off the faces, and patches and subdivision polygons come in as their cage', () => {
  const model = parseLWO(
    lwo(
      iff('TAGS', even('Face'), even('Patch')),
      LWO_POINTS,
      LWO_FACE,
      iff('PTAG', Buffer.from('SURF'), beU16(0, 0)),
      iff('POLS', Buffer.from('SUBD'), beU16(3, 0, 1, 2)),
      iff('PTAG', Buffer.from('SURF'), beU16(0, 1)),
      iff('POLS', Buffer.from('PTCH'), beU16(3, 0, 2, 3)),
    ),
  );
  assert.deepEqual(model.groups.map((group) => [group.name, group.count]), [
    ['Face', 6],
    ['Patch', 3],
    ['', 3],
  ]);
  assert.deepEqual(model.warnings, ['SUBD polygons are read as their control cage', 'PTCH polygons are read as their control cage']);
  assert.equal(parseLWO(lwo(LWO_POINTS, iff('POLS', Buffer.from('SUBD'), beU16(4, 0, 1, 2, 3)))).indices.length, 6);
});

test('loadTextures: tries each spelling, keeps what it finds and lists what is lost', async () => {
  const asked = [],
    files = { 'skin.pcx': new Uint8Array([1]), 'maps/brick.tga': 'text' };
  const { textures, missing } = await loadTextures(
    ['players\\MALE\\SKIN.PCX', 'Images:skin.pcx', 'maps\\brick.tga', 'gone.png', 'gone.png'],
    async (path) => {
      asked.push(path);
      if (path in files) return files[path];
      throw new Error(`no ${path}`);
    },
  );
  assert.deepEqual(asked.slice(0, 5), ['players\\MALE\\SKIN.PCX', 'players/MALE/SKIN.PCX', 'players/male/skin.pcx', 'SKIN.PCX', 'skin.pcx']);
  assert.deepEqual([...textures.keys()], ['players\\MALE\\SKIN.PCX', 'Images:skin.pcx', 'maps\\brick.tga']);
  assert.deepEqual([...textures.get('Images:skin.pcx')], [1]);
  assert.deepEqual([...textures.get('maps\\brick.tga')], [...text('text')]);
  assert.deepEqual(missing.map(({ path, error }) => [path, error.message]), [['gone.png', 'no gone.png']]);
  assert.equal(asked.filter((path) => path === 'gone.png').length, 1, 'one path, one read of each spelling');
});

test('loadTextures: a resolver that throws nothing still lists the file, and an abort rejects', async () => {
  const none = await loadTextures(['a.png'], () => Promise.reject());
  assert.deepEqual(none.missing, [{ path: 'a.png', error: undefined }]);
  const controller = new AbortController();
  await rejects(
    loadTextures(['a.png'], async () => {
      controller.abort();
      throw new Error('stopped');
    }, { signal: controller.signal }),
    'textures',
    'aborted',
  );
});

test('loadTextures: reads the names 3DS, LWO and MD2 give', async () => {
  const read = async () => new Uint8Array(1),
    names = (list) => loadTextures(list, read).then(({ textures }) => [...textures.keys()]);
  assert.deepEqual(await names(parse3DS(studio()).materials.flatMap((material) => material.texture ?? [])), ['brick.png']);
  assert.deepEqual(await names(parseMD2(md2()).skins), ['models/skin.pcx']);
  const model = parseLWO(lwo(iff('CLIP', beU32(1), subchunk('STIL', even('a.jpg'))), LWO_POINTS, LWO_FACE));
  assert.deepEqual(await names(model.images.map((image) => image.path)), ['a.jpg']);
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

/** Column-major 4x4 times a point. */
const apply = (m, [x, y, z]) => [0, 1, 2].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r]);
const placedKML = (longitude, latitude, altitude, extra = '') =>
  `<Placemark><Model><altitudeMode>absolute</altitudeMode><Location><longitude>${longitude}</longitude><latitude>${latitude}</latitude><altitude>${altitude}</altitude></Location>${extra}<Link><href>m.dae</href></Link></Model></Placemark>`;
const placedKMZ = async (kml, options) => (await parseKMZ(zip({ 'doc.kml': `<kml><Document>${kml}</Document></kml>`, 'm.dae': DAE }), options)).models;

test('KMZ: origin places models by location, east and up and south in metres', async () => {
  const origin = { longitude: 0, latitude: 0, altitude: 100 };
  const [north, east, up] = await placedKMZ(placedKML(0, 0.001, 100) + placedKML(0.001, 0, 100) + placedKML(0, 0, 150), { origin });
  // On the equator 0.001 degrees of longitude is 111.321 m at this height, and of latitude the published 110.574 m plus
  // 2 mm for the height. The Earth curves about 1 mm below the origin's plane over that distance.
  near(north.matrix.slice(12, 15), [0, -0.001, -110.576], 1e-3);
  near(east.matrix.slice(12, 15), [(6378237 * Math.PI) / 180000, -0.001, 0], 1e-3);
  near(up.matrix.slice(12, 15), [0, 50, 0], 1e-6);
  assert.equal(up.altitudeMode, 'absolute');
});

test('KMZ: orientation follows KML: heading clockwise from north, tilt and roll by the right hand, then scale', async () => {
  const model = async (body) => (await placedKMZ(placedKML(10, 45, 0, body), { origin: 'first' }))[0].matrix;
  // The scene is x east, y up, z south, so north is -z.
  const heading = await model('<Orientation><heading>90</heading></Orientation>');
  near(apply(heading, [0, 0, -1]), [1, 0, 0]);
  near(apply(heading, [1, 0, 0]), [0, 0, 1]);
  const tilt = await model('<Orientation><tilt>90</tilt></Orientation>');
  near(apply(tilt, [0, 0, -1]), [0, 1, 0]); // North tilts up.
  const roll = await model('<Orientation><roll>90</roll></Orientation>');
  near(apply(roll, [0, 1, 0]), [1, 0, 0]); // Up rolls east, turning about north.
  const order = await model('<Orientation><heading>90</heading><tilt>90</tilt></Orientation>');
  near(apply(order, [0, 0, -1]), [0, 1, 0]); // Tilt first, so heading turns nothing here.
  near(apply(order, [0, 1, 0]), [-1, 0, 0]); // Up tilts south, and heading turns south to west.
  const scale = await model('<Scale><x>2</x><y>3</y><z>4</z></Scale>');
  near(apply(scale, [1, 1, 1]), [2, 4, 3]); // KML y is north, the scene's z; KML z is up, the scene's y.
});

test('KMZ: a model far from the origin turns with the curve of the Earth', async () => {
  const [, far] = await placedKMZ(placedKML(0, 0, 0) + placedKML(90, 0, 0), { origin: 'first' });
  near(apply(far.matrix, [0, 0, 0]), [6378137, -6378137, 0], 1e-3);
  near(apply(far.matrix, [0, 1, 0]).map((v, i) => v - far.matrix[12 + i]), [1, 0, 0]); // Up there is east here.
});

test('KMZ: clampToGround ignores altitude, the default mode, and no origin or location means no matrix', async () => {
  const clamped = '<Placemark><Model><Location><longitude>0</longitude><latitude>0</latitude><altitude>500</altitude></Location><Link><href>m.dae</href></Link></Model></Placemark>';
  const [first] = await placedKMZ(clamped, { origin: { longitude: 0, latitude: 0, altitude: 20 } });
  assert.equal(first.altitudeMode, 'clampToGround');
  near(first.matrix.slice(12, 15), [0, -20, 0], 1e-6);
  const [own] = await placedKMZ(clamped, { origin: 'first' });
  near(own.matrix.slice(12, 15), [0, 0, 0], 1e-6);
  assert.equal((await placedKMZ(clamped))[0].matrix, undefined);
  const bare = await parseKMZ(zip({ 'a.dae': DAE }), { origin: 'first' });
  assert.equal(bare.models[0].matrix, undefined);
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
