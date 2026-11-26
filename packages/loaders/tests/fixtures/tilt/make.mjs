// Writes ribbon.tilt: a Margo-made two-stroke sketch following the Open Brush file format notes (16-byte tilT header,
// a stored zip of data.sketch and metadata.json). Run: node make.mjs
import { writeFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';

const i32 = (v) => Buffer.from(new Int32Array([v]).buffer);
const u32 = (v) => Buffer.from(new Uint32Array([v]).buffer);
const f32 = (...v) => Buffer.from(new Float32Array(v).buffer);

const stroke = (brush, color, size, points) =>
  Buffer.concat([
    i32(brush),
    f32(...color),
    f32(size),
    u32(0),
    u32(0b11),
    i32(points.length),
    ...points.map(([x, y, z], i) => Buffer.concat([f32(x, y, z, 0, 0, 0, 1), f32(1), u32(i * 100)])),
  ]);
const data = Buffer.concat([
  u32(0xc576a5cd),
  u32(6),
  u32(0),
  u32(0),
  i32(2),
  stroke(0, [1, 0.2, 0.1, 1], 1, [[0, 0, 0], [5, 3, 0], [10, 0, 0], [15, 3, 0]]),
  stroke(1, [0.1, 0.4, 1, 1], 2, [[0, 0, 5], [10, 0, 5], [10, 6, 5]]),
]);
const metadata = Buffer.from(JSON.stringify({ BrushIndex: ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'] }));

const locals = [],
  centrals = [];
let offset = 0;
for (const [name, content] of [
  ['data.sketch', data],
  ['metadata.json', metadata],
]) {
  const n = Buffer.from(name),
    local = Buffer.alloc(30 + n.length),
    central = Buffer.alloc(46 + n.length),
    crc = crc32(content);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(n.length, 26);
  n.copy(local, 30);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(n.length, 28);
  central.writeUInt32LE(offset, 42);
  n.copy(central, 46);
  locals.push(local, content);
  centrals.push(central);
  offset += local.length + content.length;
}
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(2, 8);
end.writeUInt16LE(2, 10);
end.writeUInt32LE(centrals.reduce((n, c) => n + c.length, 0), 12);
end.writeUInt32LE(offset, 16);
const header = Buffer.alloc(16);
header.write('tilT', 0, 'latin1');
header.writeUInt16LE(16, 4);
header.writeUInt16LE(1, 6);
writeFileSync(new URL('./ribbon.tilt', import.meta.url), Buffer.concat([header, ...locals, ...centrals, end]));
