// Tilt Brush .tilt files assembled in the test from the Open Brush file format notes: a 16-byte header, then a zip with
// data.sketch and metadata.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { parseTilt, parseTiltSketch } from '../dist/tilt.js';
import { crc32, LoaderError } from '../dist/common.js';

function zip(files, deflate = false) {
  const locals = [],
    centrals = [];
  let offset = 0;
  for (const [path, content] of Object.entries(files)) {
    const data = typeof content === 'string' ? Buffer.from(content) : content,
      packed = deflate ? deflateRawSync(data) : data,
      name = Buffer.from(path),
      crc = crc32(data),
      local = Buffer.alloc(30 + name.length),
      central = Buffer.alloc(46 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    locals.push(local, packed);
    centrals.push(central);
    offset += local.length + packed.length;
  }
  const size = centrals.reduce((n, c) => n + c.length, 0),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length, 8);
  end.writeUInt16LE(centrals.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

const i32 = (v) => (b => (b.writeInt32LE(v), b))(Buffer.alloc(4));
const u32 = (v) => (b => (b.writeUInt32LE(v), b))(Buffer.alloc(4));
const f32 = (...vs) => Buffer.concat(vs.map((v) => (b => (b.writeFloatLE(v), b))(Buffer.alloc(4))));

// pressure + timestamp on every control point (mask 0b11), one stroke extension (mask bit 0) and one sized blob (bit 16).
function sketch(strokes, { extra = Buffer.alloc(0) } = {}) {
  const parts = [u32(0xc576a5cd), u32(6), u32(0), u32(extra.length), extra, i32(strokes.length)];
  for (const s of strokes) {
    parts.push(i32(s.brush), f32(...s.color), f32(s.size), u32(s.strokeMask ?? 0), u32(s.pointMask ?? 0b11));
    if (s.strokeMask & 1) parts.push(u32(1));
    if (s.strokeMask & 0x10000) parts.push(u32(3), Buffer.from([7, 8, 9]));
    parts.push(i32(s.points.length));
    for (const p of s.points) {
      parts.push(f32(...p.position, 0, 0, 0, 1));
      if ((s.pointMask ?? 0b11) & 1) parts.push(f32(p.pressure ?? 1));
      if ((s.pointMask ?? 0b11) & 2) parts.push(u32(p.time ?? 0));
    }
  }
  return Buffer.concat(parts);
}

const tilt = (data, metadata, deflate = false) =>
  Buffer.concat([
    Buffer.from('tilT'),
    (b => (b.writeUInt16LE(16, 0), b.writeUInt16LE(1, 2), b))(Buffer.alloc(4)),
    Buffer.alloc(8),
    zip({ 'data.sketch': data, ...(metadata ? { 'metadata.json': metadata } : {}) }, deflate),
  ]);

const line = {
  brush: 1,
  color: [1, 0.5, 0, 1],
  size: 2,
  strokeMask: 1 | 0x10000,
  points: [
    { position: [0, 0, 0], pressure: 1, time: 10 },
    { position: [10, 0, 0], pressure: 0.5, time: 20 },
    { position: [20, 0, 0], pressure: 1, time: 30 },
  ],
};

test('strokes come out as ribbons with colour, width from size and pressure, and handedness converted', async () => {
  const meta = JSON.stringify({ BrushIndex: ['guid-a', 'guid-b'], Authors: ['x'] });
  for (const deflate of [false, true]) {
    const result = await parseTilt(tilt(sketch([line]), meta, deflate));
    assert.equal(result.version, 6);
    assert.deepEqual(result.brushes, ['guid-a', 'guid-b']);
    assert.equal(result.strokes[0].brush, 'guid-b');
    assert.equal(result.strokes[0].points[1].pressure, 0.5);
    assert.equal(result.strokes[0].points[2].timestamp, 30);
    const g = result.geometry;
    assert.equal(g.kind, 'mesh');
    assert.equal(g.positions.length, 6 * 3);
    assert.equal(g.indices.length, 4 * 3);
    // Identity orientation: the width runs along the controller's X, which is also the path's direction, so the normal
    // (right x tangent) is degenerate and falls back to the controller's up (Y). Width 2 units * 0.1 = 0.2 m at pressure 1.
    const x = (i) => g.positions[i * 3];
    assert.ok(Math.abs(x(1) - x(0) - 0.2) < 1e-6);
    assert.ok(Math.abs(x(3) - x(2) - 0.1) < 1e-6);
    assert.deepEqual([...g.colors.slice(0, 3)], [1, 0.5, 0]);
    assert.equal(g.groups.length, 1);
    assert.equal(g.groups[0].name, 'guid-b');
    assert.equal(g.groups[0].properties.brushIndex, 1);
    assert.deepEqual([...g.normals.slice(0, 3)].map((v) => v + 0), [0, 1, 0]);
  }
});

test('a ribbon seen from +Y with a rotated controller: width along the controller X, mirrored Z, flipped winding', async () => {
  // Controller yawed 90 degrees about Y: its local X becomes -Z in source space.
  const s = Math.SQRT1_2,
    stroke = { ...line, strokeMask: 0, pointMask: 0, points: [{ position: [0, 0, 0] }, { position: [0, 0, 10] }] };
  const raw = sketch([stroke]);
  // Patch both control point quaternions to (0, sin45, 0, cos45): the quaternion floats follow each position.
  const q = f32(0, s, 0, s);
  const at = raw.length - 2 * 28;
  for (let i = 0; i < 2; i++) q.copy(raw, at + i * 28 + 12);
  const { geometry: g } = await parseTilt(tilt(raw), { rightHanded: false, scale: 1 });
  // Local X (1,0,0) rotated by +90 deg about Y is (0,0,-1): vertex 0 = -side = +Z, vertex 1 = +side = -Z; width 2.
  assert.ok(Math.abs(g.positions[2] - 1) < 1e-6 && Math.abs(g.positions[5] + 1) < 1e-6);
  const flipped = (await parseTilt(tilt(raw), { scale: 1 })).geometry;
  assert.ok(Math.abs(flipped.positions[2] + 1) < 1e-6);
  assert.deepEqual([...g.indices.slice(0, 3)], [0, 1, 3]);
  assert.deepEqual([...flipped.indices.slice(0, 3)], [0, 3, 1]);
});

test('single-point strokes are skipped and the additional header is skipped', async () => {
  const one = { ...line, points: [line.points[0]] };
  const result = await parseTilt(tilt(sketch([one, line], { extra: Buffer.from([1, 2, 3, 4, 5]) })));
  assert.equal(result.strokes.length, 2);
  assert.equal(result.geometry.groups.length, 1);
  assert.equal(parseTiltSketch(sketch([]), {}).strokes.length, 0);
});

test('errors carry their codes', async () => {
  const err = (code) => (e) => e instanceof LoaderError && e.format === 'TILT' && e.code === code;
  const good = sketch([line]);
  await assert.rejects(parseTilt(tilt(good.subarray(0, good.length - 10))), err('truncated'));
  await assert.rejects(parseTilt(Buffer.from("tilT" + "x".repeat(40))), (e) => e.code === "zip");
  await assert.rejects(parseTilt(zip({ "other.txt": "x" })), (e) => e.code === "zip");
  await assert.rejects(parseTilt(tilt(good, '{nope')), err('syntax'));
  await assert.rejects(parseTilt(tilt(good), { maxVertices: 3 }), err('limit'));
  await assert.rejects(parseTilt(tilt(good), { scale: 0 }), err('range'));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(parseTilt(tilt(good), { signal: controller.signal }), err('aborted'));
});
