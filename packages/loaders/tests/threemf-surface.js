// Helpers of the 3MF displacement, level set and boolean tests: packages written by hand from the specifications and
// measures of the triangle meshes they give.
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { crc32 } from '../dist/common.js';

const text = (value) => new TextEncoder().encode(value);

/** A stored zip of `{ name: bytes or text }`. */
export function zip(files) {
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

/** An 8-bit grey PNG of `rows`, top row first. */
export function grey(rows) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length);
    out.write(type, 4);
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(rows[0].length);
  head.writeUInt32BE(rows.length, 4);
  head[8] = 8;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', head),
      chunk('IDAT', deflateSync(Buffer.from(rows.flatMap((row) => [0, ...row])))),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/** A box from `low` to `high`: its eight corners and twelve outward triangles, two for each of -z, +z, -y, +y, -x, +x. */
export function box(low, high) {
  const vertices = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
  ].map((c) => c.map((v, k) => (v ? high[k] : low[k])));
  const triangles = [
    [0, 2, 1],
    [0, 3, 2],
    [4, 5, 6],
    [4, 6, 7],
    [0, 1, 5],
    [0, 5, 4],
    [3, 7, 6],
    [3, 6, 2],
    [0, 4, 7],
    [0, 7, 3],
    [1, 2, 6],
    [1, 6, 5],
  ];
  return { vertices, triangles };
}

export const vertexXML = (vertices, prefix = '') =>
  vertices.map(([x, y, z]) => `<${prefix}vertex x="${x}" y="${y}" z="${z}"/>`).join('');
export const meshXML = ({ vertices, triangles }) =>
  `<mesh><vertices>${vertexXML(vertices)}</vertices><triangles>${triangles
    .map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`)
    .join('')}</triangles></mesh>`;

/** Six times the enclosed volume over six, by the divergence theorem. */
export function volume({ positions, indices }) {
  let sum = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => positions.subarray(indices[t + k] * 3, indices[t + k] * 3 + 3));
    sum += a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  return sum / 6;
}

/** Every edge between two points is walked as often one way as the other: no crack and no flipped triangle. */
export function closed({ positions, indices }) {
  const point = (v) => positions.subarray(v * 3, v * 3 + 3).join(','),
    edges = new Map();
  for (let t = 0; t < indices.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = point(indices[t + k]),
        b = point(indices[t + ((k + 1) % 3)]);
      if (a === b) continue;
      const [key, way] = a < b ? [`${a} ${b}`, 1] : [`${b} ${a}`, -1];
      edges.set(key, (edges.get(key) ?? 0) + way);
    }
  const open = [...edges].filter(([, balance]) => balance !== 0);
  assert.deepEqual(open.slice(0, 4), [], `${open.length} open edges`);
}
