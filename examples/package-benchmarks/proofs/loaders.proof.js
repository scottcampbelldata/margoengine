// Proof for @margoengine/loaders: PLY and PCD body readers, LZF, vertex normals and the Geometry converters.
// Run: node examples/package-benchmarks/proofs/loaders.proof.js [ref] [pin]
// Pinned: f05414a against f47ff3f, the commit that recorded results/loaders.json, so the run never depends on today's tree.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { refs, versions, time, record } from './compare.js';

const { ref, pin } = refs('f05414a', 'f47ff3f'),
  { baseline, candidate } = await versions('loaders', ref, undefined, pin);
const text = (value) => new TextEncoder().encode(value),
  join = (parts) =>
    Buffer.concat(
      parts.map((part) =>
        typeof part === 'string' ? text(part) : Buffer.from(part.buffer, part.byteOffset, part.byteLength),
      ),
    );
/** Bit-exact comparison: typed arrays by their bytes (so NaN payloads and -0 count), everything else structurally. */
function same(actual, expected, path = 'result') {
  if (ArrayBuffer.isView(expected)) {
    assert.equal(actual?.constructor, expected.constructor, path);
    return assert.ok(
      Buffer.compare(
        Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength),
        Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength),
      ) === 0,
      `${path} differs`,
    );
  }
  if (expected && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual), Object.keys(expected), path);
    for (const key of Object.keys(expected)) same(actual[key], expected[key], `${path}.${key}`);
  } else assert.ok(Object.is(actual, expected), `${path}: ${actual} != ${expected}`);
}
const outcome = (operation) => {
  try {
    return { value: operation() };
  } catch (error) {
    return { type: error.constructor.name, code: error.code, message: error.message };
  }
};
/** Both versions must return the same value or throw the same error. */
function agree(name, run) {
  const expected = outcome(() => run(baseline)),
    actual = outcome(() => run(candidate));
  if ('value' in expected) {
    assert.ok('value' in actual, `${name}: ${actual.message}`);
    same(actual.value, expected.value, name);
  } else assert.deepEqual(actual, expected, name);
  if (process.env.PROOF_VERBOSE) console.error(name, '->', expected.message ?? 'ok'); // lists what each edge case exercised
  return expected;
}

// 224 x 224 vertices and 99,458 triangles: a detailed scanned part, the size these formats usually carry.
const side = 224,
  count = side * side,
  P = new Float32Array(count * 3),
  N = new Float32Array(count * 3),
  UV = new Float32Array(count * 2),
  RGB = new Uint8Array(count * 3),
  faces = [];
for (let y = 0, i = 0; y < side; y++)
  for (let x = 0; x < side; x++, i++) {
    const a = (x / (side - 1)) * Math.PI * 2,
      b = (y / (side - 1) - 0.5) * Math.PI,
      r = 1 + 0.15 * Math.sin(a * 7) * Math.cos(b * 5);
    P.set([r * Math.cos(b) * Math.cos(a) * 3.7, r * Math.sin(b) * 2.1, r * Math.cos(b) * Math.sin(a) * 3.7], i * 3);
    N.set([Math.cos(b) * Math.cos(a), Math.sin(b), Math.cos(b) * Math.sin(a)], i * 3);
    UV.set([x / (side - 1), y / (side - 1)], i * 2);
    RGB.set([x & 255, y & 255, (x * y) & 255], i * 3);
  }
for (let y = 0; y < side - 1; y++)
  for (let x = 0; x < side - 1; x++) {
    const a = y * side + x;
    faces.push([a, a + 1, a + side], [a + 1, a + side + 1, a + side]);
  }
const triangles = Uint32Array.from(faces.flat());

// --- PLY ---
const plyHeader = (format, extra = '') =>
  `ply\nformat ${format} 1.0\ncomment proof\nelement vertex ${count}\nproperty float x\nproperty float y\nproperty float z\nproperty float nx\nproperty float ny\nproperty float nz\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nproperty float s\nproperty float t\n${extra}element face ${faces.length}\nproperty list uchar int vertex_indices\nend_header\n`;
function plyBinary(little, extra = '', extraBytes = new Uint8Array(0)) {
  const vertices = new DataView(new ArrayBuffer(count * 35)),
    list = new DataView(new ArrayBuffer(faces.length * 13));
  for (let i = 0, o = 0; i < count; i++) {
    for (const v of [P[i * 3], P[i * 3 + 1], P[i * 3 + 2], N[i * 3], N[i * 3 + 1], N[i * 3 + 2]]) {
      vertices.setFloat32(o, v, little);
      o += 4;
    }
    for (let k = 0; k < 3; k++) vertices.setUint8(o++, RGB[i * 3 + k]);
    vertices.setFloat32(o, UV[i * 2], little);
    vertices.setFloat32(o + 4, UV[i * 2 + 1], little);
    o += 8;
  }
  faces.forEach((face, f) => {
    list.setUint8(f * 13, 3);
    face.forEach((v, k) => list.setInt32(f * 13 + 1 + k * 4, v, little));
  });
  return join([plyHeader(little ? 'binary_little_endian' : 'binary_big_endian', extra), vertices, extraBytes, list]);
}
const plyLittle = plyBinary(true),
  plyBig = plyBinary(false);
// A fixed-size element the parser skips, between the vertices and the faces.
const plySkipped = plyBinary(
  true,
  'element edge 1000\nproperty int vertex1\nproperty int vertex2\nproperty double weight\n',
  new Uint8Array(16000).map((_, i) => i * 7),
);
const plyAscii = join([
  plyHeader('ascii'),
  Array.from(
    { length: count },
    (_, i) =>
      `${P[i * 3]} ${P[i * 3 + 1]} ${P[i * 3 + 2]} ${N[i * 3]} ${N[i * 3 + 1]} ${N[i * 3 + 2]} ${RGB[i * 3]} ${RGB[i * 3 + 1]} ${RGB[i * 3 + 2]} ${UV[i * 2]} ${UV[i * 2 + 1]}`,
  ).join('\n') + '\n',
  faces.map((face) => `3 ${face.join(' ')}`).join('\n') + '\n',
]);
// Small files for the general paths: quads and pentagons, a list on the vertex element, every scalar type, nan and inf.
const mixed = (little) => {
  const head = `ply\nformat ${little ? 'binary_little_endian' : 'binary_big_endian'} 1.0\nelement vertex 5\nproperty double x\nproperty short y\nproperty ushort z\nproperty list uchar char tags\nproperty char q\nproperty uint w\nelement material 2\nproperty list ushort float weights\nproperty uchar id\nelement face 3\nproperty uchar flag\nproperty list uint ushort vertex_index\nproperty list uchar double extra\nend_header\n`;
  const body = new DataView(new ArrayBuffer(4096));
  let o = 0;
  for (let i = 0; i < 5; i++) {
    body.setFloat64(o, i * 1.5 - 2, little);
    o += 8;
    body.setInt16(o, -i * 300, little);
    o += 2;
    body.setUint16(o, i * 9000, little);
    o += 2;
    body.setUint8(o++, i % 3);
    for (let k = 0; k < i % 3; k++) body.setInt8(o++, -k);
    body.setInt8(o++, -i);
    body.setUint32(o, 4e9 - i, little);
    o += 4;
  }
  for (let i = 0; i < 2; i++) {
    body.setUint16(o, 2, little);
    o += 2;
    body.setFloat32(o, 0.25, little);
    body.setFloat32(o + 4, NaN, little);
    o += 8;
    body.setUint8(o++, i);
  }
  for (const face of [
    [0, 1, 2],
    [0, 1, 2, 3],
    [4, 3, 2, 1, 0],
  ]) {
    body.setUint8(o++, 9);
    body.setUint32(o, face.length, little);
    o += 4;
    for (const v of face) {
      body.setUint16(o, v, little);
      o += 2;
    }
    body.setUint8(o++, 1);
    body.setFloat64(o, Infinity, little);
    o += 8;
  }
  return join([head, new Uint8Array(body.buffer, 0, o)]);
};
const asciiHead =
  'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n';
const fixture = (name) => readFileSync(new URL(`../../../packages/loaders/tests/fixtures/${name}`, import.meta.url));
for (const [name, data, options] of [
  ['binary little', plyLittle],
  ['binary big', plyBig],
  ['skipped element', plySkipped],
  ['ascii', plyAscii],
  ['mixed little', mixed(true)],
  ['mixed big', mixed(false)],
  ['dolphins', fixture('dolphins.ply')],
  ['dolphins big endian', fixture('dolphins_be.ply')],
  ['dolphins colored', fixture('dolphins_colored.ply')],
  ['ascii nan and inf', text(asciiHead + '1 nan -NaN\n+inf 2 -Infinity\n1e3 0x10 .5\n3 0 1 2\n')],
  ['ascii quad list', text(asciiHead.replace('face 1', 'face 2') + '0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n4 0 1 2 1\n')],
  ['ascii bad number', text(asciiHead + '1 2 abc\n')],
  ['ascii ends early', text(asciiHead + '1 2 3\n4 5')],
  ['ascii list length 2.5', text(asciiHead + '0 0 0\n1 0 0\n0 1 0\n2.5 0 1 2\n')],
  ['ascii list length nan', text(asciiHead + '0 0 0\n1 0 0\n0 1 0\nnan 0 1 2\n')],
  ['ascii list length word', text(asciiHead + '0 0 0\n1 0 0\n0 1 0\nthree 0 1 2\n')],
  ['ascii list ends', text(asciiHead + '0 0 0\n1 0 0\n0 1 0\n3 0 1')],
  ['ascii bad index', text(asciiHead + '0 0 0\n1 0 0\n0 1 0\n3 0 1 7\n')],
  ['ascii huge list', text(asciiHead + '0 0 0\n1 0 0\n0 1 0\n70000 0 1 2\n')],
  ['binary cut in faces', plyLittle.subarray(0, plyLittle.length - 3)],
  ['binary cut in vertices', plyLittle.subarray(0, 4000)],
  ['binary cut in skipped', plySkipped.subarray(0, plySkipped.length - faces.length * 13 - 20)],
  ['mixed cut', mixed(true).subarray(0, mixed(true).length - 5)],
  ['mixed cut early', mixed(true).subarray(0, 420)],
  ['vertex limit', plyLittle, { maxVertices: 100 }],
  ['triangle limit', plyLittle, { maxTriangles: 99457 }],
])
  agree(`PLY ${name}`, (api) => api.parsePLY(data, options));

// --- PCD ---
// A small LZF compressor (hash of three bytes, greedy matches) so binary_compressed has real back references.
function compressLZF(input) {
  const out = [],
    table = new Int32Array(1 << 14).fill(-1);
  let literal = -1,
    i = 0;
  const flush = () => {
    literal = -1;
  };
  while (i < input.length) {
    let length = 0,
      offset = 0;
    if (i + 2 < input.length) {
      const hash = (((input[i] << 8) ^ (input[i + 1] << 4) ^ input[i + 2]) * 2654435761) >>> 18,
        at = table[hash];
      table[hash] = i;
      if (at >= 0 && i - at - 1 < 8192) {
        while (length < 264 && i + length < input.length && input[at + length] === input[i + length]) length++;
        offset = i - at - 1;
      }
    }
    if (length >= 3) {
      flush();
      const l = length - 2;
      if (l < 7) out.push((l << 5) | (offset >> 8), offset & 255);
      else out.push((7 << 5) | (offset >> 8), l - 7, offset & 255);
      i += length;
    } else {
      if (literal < 0 || out[literal] === 31) {
        literal = out.length;
        out.push(-1);
      }
      out[literal]++;
      out.push(input[i++]);
    }
  }
  return Uint8Array.from(out);
}
const cloud = 300_000; // A 300,000-point organized scan with normals, packed colors and intensity; every 53rd point is a hole.
const fields =
  'FIELDS x y z normal_x normal_y normal_z rgb intensity\nSIZE 4 4 4 4 4 4 4 4\nTYPE F F F F F F U F\nCOUNT 1 1 1 1 1 1 1 1\n';
const rows = new DataView(new ArrayBuffer(cloud * 32)),
  columns = new DataView(new ArrayBuffer(cloud * 32)),
  lines = [];
for (let i = 0; i < cloud; i++) {
  const v = P[(i % count) * 3] + i * 1e-4,
    hole = i % 53 === 0,
    values = [
      hole ? NaN : v,
      P[(i % count) * 3 + 1],
      P[(i % count) * 3 + 2],
      N[(i % count) * 3],
      N[(i % count) * 3 + 1],
      N[(i % count) * 3 + 2],
      (i * 2654435761) >>> 8,
      (i % 1000) / 1000,
    ];
  values.forEach((value, f) => {
    if (f === 6) {
      rows.setUint32(i * 32 + f * 4, value, true);
      columns.setUint32(f * cloud * 4 + i * 4, value, true);
    } else {
      rows.setFloat32(i * 32 + f * 4, value, true);
      columns.setFloat32(f * cloud * 4 + i * 4, value, true);
    }
  });
  lines.push(
    values
      .map((value, f) => (Number.isNaN(value) ? 'nan' : f === 6 ? String(value) : String(Math.fround(value))))
      .join(' '),
  );
}
const pcdHead = (data) =>
  `# .PCD v0.7\nVERSION 0.7\n${fields}WIDTH ${cloud / 100}\nHEIGHT 100\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS ${cloud}\nDATA ${data}\n`;
const packed = compressLZF(new Uint8Array(columns.buffer)),
  sizes = new Uint32Array([packed.length, cloud * 32]);
const pcdBinary = join([pcdHead('binary'), rows]),
  pcdCompressed = join([pcdHead('binary_compressed'), sizes, packed]),
  pcdAscii = join([pcdHead('ascii'), lines.join('\n') + '\n']);
// Every integer and float width, a multi-count field before x, and a float-packed rgb.
const wide = (data) => {
  const head = `VERSION 0.7\nFIELDS pad x y z rgb a b c d e f intensity\nSIZE 1 8 2 4 4 1 2 4 8 8 8 2\nTYPE U F I I F I U U I U F U\nCOUNT 3 1 1 1 1 1 1 1 1 1 2 1\nWIDTH 4\nHEIGHT 1\nPOINTS 4\nDATA ${data}\n`,
    row = 3 + 8 + 2 + 4 + 4 + 1 + 2 + 4 + 8 + 8 + 16 + 2;
  const body = new DataView(new ArrayBuffer(4 * row)),
    order = [];
  for (let i = 0; i < 4; i++) {
    const cells = [
      [1, 'Uint8', i],
      [1, 'Uint8', i],
      [1, 'Uint8', i],
      [8, 'Float64', i * 1.25 - 1],
      [2, 'Int16', -i * 100],
      [4, 'Int32', -i * 70000],
      [4, 'Float32', 1e-40 * (i + 1)],
      [1, 'Int8', -i],
      [2, 'Uint16', 60000 + i],
      [4, 'Uint32', 4e9 + i],
      [8, 'BigInt64', BigInt(-i) * 5_000_000_000n],
      [8, 'BigUint64', BigInt(i) * 9_000_000_000n],
      [8, 'Float64', i / 3],
      [8, 'Float64', -i / 7],
      [2, 'Uint16', i * 1000],
    ];
    let o = 0;
    cells.forEach(([size, type, value], c) => {
      (order[c] ??= []).push([size, type, value]);
      body[`set${type}`](i * row + o, value, true);
      o += size;
    });
  }
  if (data === 'binary') return join([head, body]);
  const column = new DataView(new ArrayBuffer(4 * row));
  let o = 0;
  for (const cellsOfField of order)
    for (const [size, type, value] of cellsOfField) {
      column[`set${type}`](o, value, true);
      o += size;
    }
  const lz = compressLZF(new Uint8Array(column.buffer));
  return join([head, new Uint32Array([lz.length, 4 * row]), lz]);
};
const smallAscii =
  'VERSION 0.7\nFIELDS x y z rgb intensity\nSIZE 4 4 4 4 4\nTYPE F F F F F\nCOUNT 1 1 1 1 1\nWIDTH 2\nHEIGHT 1\nPOINTS 2\nDATA ascii\n';
for (const [name, data, options] of [
  ['binary', pcdBinary],
  ['binary keepInvalid', pcdBinary, { keepInvalid: true }],
  ['compressed', pcdCompressed],
  ['ascii', pcdAscii],
  ['wide binary', wide('binary')],
  ['wide compressed', wide('binary_compressed')],
  ['bunny', fixture('bunny.pcd')],
  ['logo', fixture('pcl_logo.pcd')],
  ['simple', fixture('simple.pcd')],
  ['ascii float rgb', text(smallAscii + '1 2 3 4.2108e+06 0.5\n\n-1,nan;3 -NaN 7\n')],
  ['ascii bad number', text(smallAscii + '1 2 3 4 5\n1 x 3 4 5\n')],
  ['ascii bad unused column ok', text(smallAscii.replace('rgb intensity', 'foo bar') + '1 2 3 zz 5\n1 2 3 4 qq\n')],
  ['ascii short row', text(smallAscii + '1 2 3 4\n')],
  ['ascii ends early', text(smallAscii + '1 2 3 4 5\n')],
  ['binary cut', pcdBinary.subarray(0, pcdBinary.length - 1)],
  ['compressed cut', pcdCompressed.subarray(0, pcdCompressed.length - 9)],
  ['point limit', pcdBinary, { maxVertices: 1000 }],
])
  agree(`PCD ${name}`, (api) => api.parsePCD(data, options));

// --- LZF ---
agree('LZF columns', (api) => api.decompressLZF(packed, cloud * 32));
for (const [name, bytes, length] of [
  ['before output', Uint8Array.of(1 << 5, 0), 3],
  ['literal past input', Uint8Array.of(4, 1, 2), 5],
  ['literal past output', Uint8Array.of(3, 1, 2, 3, 4), 2],
  ['reference past output', Uint8Array.of(0, 1, 1 << 5, 0), 2],
  ['reference cut', Uint8Array.of(0, 1, 7 << 5), 10],
  ['short', Uint8Array.of(0, 1), 4],
  ['overlapping run', Uint8Array.of(0, 9, 7 << 5, 20, 0), 30],
  ['empty', new Uint8Array(0), 0],
  ['bad length', Uint8Array.of(0, 1), -1],
])
  agree(`LZF ${name}`, (api) => api.decompressLZF(bytes, length));

// --- CRC-32 (checked on every ZIP entry of a 3MF or USDZ) ---
assert.equal(candidate.crc32(text('123456789')), 0xcbf43926);
assert.equal(candidate.crc32(new Uint8Array(0)), 0);
const payload = Uint8Array.from({ length: 8 << 20 }, (_, i) => Math.imul(i, 2654435761) >>> 11); // an 8 MiB model part
for (const length of [1, 2, 3, 4, 5, 6, 7, 8, 9, 31, 64, 129, 1023, 65535, payload.length])
  for (const offset of [0, 1, 2, 3])
    assert.equal(
      candidate.crc32(payload.subarray(offset, offset + length)),
      baseline.crc32(payload.subarray(offset, offset + length)),
      `crc32 of ${length} bytes at ${offset}`,
    );

// --- normals and Geometry conversion ---
const loaded = { kind: 'mesh', positions: P, indices: triangles },
  withNormals = { ...loaded, normals: N.map((v, i) => (i % 300 < 3 ? 0 : v * 2)) };
const points = {
  kind: 'points',
  positions: Float32Array.from({ length: 600_000 }, (_, i) => (i % 3001 === 0 ? NaN : P[i % P.length] + i * 1e-5)),
};
agree('normals', (api) => api.computeVertexNormals(P, triangles));
agree('normals with a degenerate and an unused vertex', (api) =>
  api.computeVertexNormals([0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 5, 5, 1, 1, 1], [0, 1, 2, 0, 0, 1, 4, 4, 4, 0, 1]),
);
for (const [name, source, options] of [
  ['smooth', loaded],
  ['flat', { ...loaded, indices: triangles.subarray(0, 300_000) }, { normals: 'flat' }],
  ['file normals with zero fallback', withNormals],
  ['forced smooth', withNormals, { normals: 'smooth' }],
  [
    'group',
    {
      ...loaded,
      groups: [
        { start: 0, count: 300 },
        { start: 300, count: 3000 },
      ],
    },
    { group: 1 },
  ],
  [
    'flat degenerate',
    {
      kind: 'mesh',
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2, 0, 1, 3]),
    },
    { normals: 'flat' },
  ],
  ['flat over the limit', loaded, { normals: 'flat' }],
  ['bad index', { ...loaded, indices: new Uint32Array([0, 1, count]) }],
  ['non-finite position', { ...loaded, positions: P.map((v, i) => (i === 7 ? Infinity : v)) }],
  ['points as mesh', points],
])
  agree(`toGeometry ${name}`, (api) => api.toGeometry(source, options));
for (const [name, source, options] of [
  ['default', points],
  ['subsampled', points, { maxPoints: 1000 }],
  ['sized', points, { size: 0.25, maxPoints: 7 }],
  ['one point', { kind: 'points', positions: new Float32Array([1, 2, 3]) }],
  ['no finite points', { kind: 'points', positions: new Float32Array([NaN, 0, 0, 0, Infinity, 0]) }],
  ['bad size', points, { size: -1 }],
  ['bad maxPoints', points, { maxPoints: 1e9 }],
  ['ragged', { kind: 'points', positions: new Float32Array([1, 2, 3, 4, 5]) }],
])
  agree(`pointsToGeometry ${name}`, (api) => api.pointsToGeometry(source, options));

const cases = [];
const add = (name, size, run, rounds = 12) => {
  cases.push({
    case: name,
    ...size,
    ...time(
      () => run(baseline),
      () => run(candidate),
      rounds,
    ),
  });
  console.error(JSON.stringify(cases.at(-1)));
};
const mesh = { vertices: count, triangles: faces.length };
add('PLY binary little endian', mesh, (api) => api.parsePLY(plyLittle), 30);
add('PLY binary big endian', mesh, (api) => api.parsePLY(plyBig), 30);
add('PLY ASCII', mesh, (api) => api.parsePLY(plyAscii));
add('PCD binary', { points: cloud }, (api) => api.parsePCD(pcdBinary));
add('PCD binary_compressed', { points: cloud }, (api) => api.parsePCD(pcdCompressed));
// PCD ASCII is unchanged (its cost is the line split and Number), so it is checked above but not timed.
add('crc32', { bytes: payload.length }, (api) => api.crc32(payload));
add('decompressLZF', { bytes: cloud * 32 }, (api) => api.decompressLZF(packed, cloud * 32));
add(
  'toGeometry flat',
  { triangles: 100_000 },
  (api) => api.toGeometry({ ...loaded, indices: triangles.subarray(0, 300_000) }, { normals: 'flat' }),
  30,
);
add('pointsToGeometry', { points: 200_000, markers: 166_666 }, (api) => api.pointsToGeometry(points));
await record(
  'loaders',
  ref,
  cases,
  'PLY and PCD body loops read through numeric type codes and precomputed offsets instead of closures and Map lookups; flat normals and point markers are written without per-item arrays; LZF literal runs copy in a loop; CRC-32 slices four bytes per step.',
  pin,
);
