// The test-only meshopt encoder (tests/support/meshopt-encode.js), checked by round trips through the package's own
// decoder and by byte layouts worked out by hand from the KHR_meshopt_compression bitstream appendix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { meshoptDecodeGltfBuffer as decode } from '../dist/meshopt.js';
import {
  colorFilter,
  encodeAttributes,
  encodeIndexSequence,
  encodeTriangles,
  exponentialFilter,
  octahedralFilter,
  quantizeColor,
  quaternionFilter,
} from './support/meshopt-encode.js';

let seed = 7;
const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
const bytes = (view) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

test('attributes: header, tail padding and baseline follow the bitstream layout', () => {
  // One element of 4 bytes: v0 is header, one block (a header byte per lane, all-zero groups), 28 padding bytes and
  // the 4-byte baseline.
  const v0 = encodeAttributes(Uint8Array.of(1, 2, 3, 4), 1, 4);
  assert.deepEqual([...v0], [0xa0, 0, 0, 0, 0, ...new Array(28).fill(0), 1, 2, 3, 4]);
  // v1: header, control byte 0xaa (control 2 = all deltas zero, for all four lanes), padding to 24, baseline, channel.
  const v1 = encodeAttributes(Uint8Array.of(1, 2, 3, 4), 1, 4, { version: 1 });
  assert.deepEqual([...v1], [0xa1, 0xaa, ...new Array(19).fill(0), 1, 2, 3, 4, 0]);
  assert.deepEqual(decode(v1, 1, 4, 'ATTRIBUTES'), Uint8Array.of(1, 2, 3, 4));
  // Empty stream: header, padding and a zero baseline only.
  assert.deepEqual([...encodeAttributes(new Uint8Array(0), 0, 16)], [0xa0, ...new Array(32).fill(0)]);
});

test('attributes: 4-bit sentinel group matches the specification example', () => {
  // The appendix example deltas, as one lane of 16 elements (stride 4, the other lanes constant).
  const deltas = [-1, -4, -3, 26, -91, 0, -6, 6, -4, -4, 5, -5, 1, -1, 0, 0],
    data = new Uint8Array(16 * 4);
  let value = 0;
  // Each element differs from the one before by the example delta; element 0 is also the baseline, so its delta is 0.
  for (let i = 0; i < 16; i++) {
    value = (value + deltas[i]) & 0xff;
    data[i * 4] = value;
  }
  const encoded = encodeAttributes(data, 16, 4);
  const zig = deltas.map((d, i) => (i === 0 ? 0 : ((d << 1) ^ (d >> 7)) & 0xff));
  // Header byte 2 = 4-bit sentinel; 8 packed bytes, then the explicit codes for values >= 15.
  const packed = [];
  for (let i = 0; i < 16; i += 2) packed.push((Math.min(zig[i], 15) << 4) | Math.min(zig[i + 1], 15));
  const extra = zig.filter((z) => z >= 15);
  assert.deepEqual([...encoded.subarray(1, 2 + packed.length + extra.length)], [2, ...packed, ...extra]);
  assert.deepEqual(decode(encoded, 16, 4, 'ATTRIBUTES'), data);
  // The appendix's own sample bytes decode to its listed deltas through a hand-built v0 stream.
  const sample = [0x17, 0x5f, 0xf0, 0xbc, 0x77, 0xa9, 0x21, 0x00, 0x34, 0xb5];
  const stream = Uint8Array.from([0xa0, 2, ...sample, 0, 0, 0, ...new Array(28).fill(0), 0, 0, 0, 0]);
  const out = decode(stream, 16, 4, 'ATTRIBUTES'),
    listed = [-1, -4, -3, 26, -91, 0, -6, 6, -4, -4, 5, -5, 1, -1, 0, 0];
  let running = 0;
  for (let i = 0; i < 16; i++) {
    running = (running + listed[i]) & 0xff;
    assert.equal(out[i * 4], running, `sample element ${i}`);
  }
});

test('attributes: v0 and v1 round trip exactly across strides, block sizes and data shapes', () => {
  const shapes = {
    zero: () => 0,
    smooth: (i, stride) => (Math.floor(i / stride) * ((i % stride) + 1)) & 0xff,
    noise: () => (random() * 256) | 0,
    small: (i, stride) => (Math.floor(i / stride) + ((random() * 3) | 0)) & 0xff,
  };
  for (const stride of [4, 8, 12, 16, 64, 256])
    for (const count of [1, 15, 16, 17, 255, 300, 700])
      for (const [shape, fn] of Object.entries(shapes)) {
        const data = Uint8Array.from({ length: count * stride }, (_, i) => fn(i, stride));
        for (const version of [0, 1]) {
          if (version === 1 && count * stride > 20000) continue; // channel search tries every mode; keep it quick
          const encoded = encodeAttributes(data, count, stride, { version });
          assert.deepEqual(
            decode(encoded, count, stride, 'ATTRIBUTES'),
            data,
            `${shape} v${version} ${count}x${stride}`,
          );
        }
      }
});

test('attributes v1: every channel mode and rotation round trips', () => {
  const count = 200,
    stride = 8,
    words = Uint32Array.from({ length: count * 2 }, (_, i) => (0x3f800000 + (i >> 1) * 4099 + (i & 1) * 77) >>> 0),
    data = bytes(words);
  for (const mode of [0, 1, 2])
    for (const rotation of mode === 2 ? [0, 1, 7, 8, 13, 15] : [0]) {
      const encoded = encodeAttributes(data, count, stride, {
        version: 1,
        channels: [{ mode, rotation }, { mode: 0 }],
      });
      assert.equal(encoded.at(-2), mode | (rotation << 4), 'channel byte');
      assert.deepEqual(decode(encoded, count, stride, 'ATTRIBUTES'), data, `mode ${mode} rotation ${rotation}`);
    }
  // The automatic search prefers the smaller stream.
  const auto = encodeAttributes(data, count, stride, { version: 1 }),
    plain = encodeAttributes(data, count, stride, { version: 1, channels: [{ mode: 0 }, { mode: 0 }] });
  assert.ok(auto.length <= plain.length);
});

const sameTriangle = (x, y) =>
  [0, 1, 2].some((r) => x[0] === y[r] && x[1] === y[(r + 1) % 3] && x[2] === y[(r + 2) % 3]);

function grid(side) {
  const faces = [];
  for (let y = 0; y < side - 1; y++)
    for (let x = 0; x < side - 1; x++) {
      const a = y * side + x;
      faces.push(a, a + 1, a + side, a + 1, a + side + 1, a + side);
    }
  return faces;
}

test('triangles: layout, round trips and rotation-only changes', () => {
  // One new triangle: header, one table code (0xf0, pair 0x00), no data, then the 16-byte table.
  const one = encodeTriangles([0, 1, 2]);
  assert.equal(one.length, 1 + 1 + 16);
  assert.deepEqual([...one.subarray(0, 2)], [0xe1, 0xf0]);
  const table = one.subarray(2);
  assert.deepEqual([...table.subarray(14)], [0, 0]);
  for (const v of table) assert.ok((v & 15) !== 15 && v >> 4 !== 15, 'no 0xf nibble in the table');

  const lists = {
    grid: grid(30),
    shuffled: (() => {
      const g = grid(20),
        tris = [];
      for (let i = 0; i < g.length; i += 3) tris.push(g.slice(i, i + 3));
      for (let i = tris.length - 1; i > 0; i--) {
        const j = (random() * (i + 1)) | 0;
        [tris[i], tris[j]] = [tris[j], tris[i]];
      }
      return tris.flat();
    })(),
    random: Array.from({ length: 900 }, () => (random() * 5000) | 0),
    large: Array.from({ length: 300 }, (_, i) => (0xfffffff0 + i * 7919) >>> 0),
    degenerate: [5, 5, 5, 0, 0, 1, 1, 0, 0, 7, 7, 7],
    restartLike: [3, 0, 1, 0, 1, 2, 9, 9, 9],
  };
  for (const [name, list] of Object.entries(lists)) {
    const exact = encodeTriangles(list, { keepOrder: true });
    assert.deepEqual([...new Uint32Array(decode(exact, list.length, 4, 'TRIANGLES').buffer)], list, `${name} exact`);
    const small = encodeTriangles(list),
      out = new Uint32Array(decode(small, list.length, 4, 'TRIANGLES').buffer);
    for (let t = 0; t < list.length; t += 3)
      assert.ok(sameTriangle([...out.subarray(t, t + 3)], list.slice(t, t + 3)), `${name} triangle ${t / 3}`);
    assert.ok(small.length <= exact.length + 2, `${name} rotation does not grow the stream`);
    if (list.every((v) => v < 65536)) {
      const out16 = new Uint16Array(decode(exact, list.length, 2, 'TRIANGLES').buffer);
      assert.deepEqual([...out16], list, `${name} 16-bit`);
    }
  }
  // A well-ordered grid costs close to one byte per triangle.
  const g = grid(30);
  assert.ok(encodeTriangles(g).length < (g.length / 3) * 1.2 + 64);
});

test('indices: varint layout and round trips', () => {
  // 0 (delta 0, baseline 0) -> 0x00; 1 -> zigzag(1)=2, <<1 -> 4; 200 -> zigzag(199)=398, <<1 = 796 -> 0x9c 0x06.
  assert.deepEqual([...encodeIndexSequence([0, 1, 200])], [0xd1, 0x00, 0x04, 0x9c, 0x06, 0, 0, 0, 0]);
  const lists = {
    strip: Array.from({ length: 400 }, (_, i) => (i & 1 ? 1000 + (i >> 1) : i >> 1)),
    random: Array.from({ length: 500 }, () => (random() * 2 ** 30) >>> 0),
    wide: [0, 2 ** 30 - 1, 0xffffffff, 5, 2 ** 30 + 4],
  };
  for (const [name, list] of Object.entries(lists)) {
    const encoded = encodeIndexSequence(list);
    assert.deepEqual([...new Uint32Array(decode(encoded, list.length, 4, 'INDICES').buffer)], list, name);
  }
  // Bimodal sequences pick the second baseline and stay at one byte per index.
  assert.equal(encodeIndexSequence(lists.strip).length, 1 + 400 + 1 + 4);
});

const unit = () => {
  const v = [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1],
    l = Math.hypot(...v) || 1;
  return v.map((x) => x / l);
};

test('OCTAHEDRAL filter: unit vectors survive within the precision of K bits', () => {
  for (const [stride, bits] of [
    [4, 8],
    [4, 5],
    [8, 16],
    [8, 12],
  ]) {
    const count = 400,
      vectors = new Float32Array(count * 4);
    for (let i = 0; i < count; i++)
      vectors.set(
        [
          ...(i < 6
            ? [
                [1, 0, 0],
                [0, -1, 0],
                [0, 0, 1],
                [0, 0, -1],
                [-1, 0, 0],
                [0, 1, 0],
              ][i]
            : unit()),
          (i % 3) - 1,
        ],
        i * 4,
      );
    const filtered = octahedralFilter(vectors, count, stride, bits),
      ints = stride === 4 ? new Int8Array(filtered.buffer) : new Int16Array(filtered.buffer);
    for (let i = 0; i < count; i++) assert.equal(ints[i * 4 + 2], (1 << (bits - 1)) - 1, 'third component is 1.0');
    const out = decode(encodeAttributes(filtered, count, stride), count, stride, 'ATTRIBUTES', 'OCTAHEDRAL'),
      decoded = stride === 4 ? new Int8Array(out.buffer) : new Int16Array(out.buffer),
      full = stride === 4 ? 127 : 32767,
      tolerance = 4 / (1 << (bits - 1)) + 2 / full;
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < 3; k++)
        assert.ok(Math.abs(decoded[i * 4 + k] / full - vectors[i * 4 + k]) <= tolerance, `vector ${i}[${k}]`);
      assert.equal(decoded[i * 4 + 3], ints[i * 4 + 3], 'w passes through');
    }
  }
});

test('QUATERNION filter: rotations survive up to sign within the precision of K bits', () => {
  for (const bits of [16, 12, 8, 4]) {
    const count = 300,
      quats = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const axis = unit(),
        angle = random() * Math.PI * 4,
        s = Math.sin(angle / 2);
      quats.set([axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)], i * 4);
    }
    const filtered = quaternionFilter(quats, count, bits),
      ints = new Int16Array(filtered.buffer);
    for (let i = 0; i < count; i++) assert.equal(ints[i * 4 + 3] | 3, (1 << (bits - 1)) - 1);
    const out = new Int16Array(
        decode(encodeAttributes(filtered, count, 8), count, 8, 'ATTRIBUTES', 'QUATERNION').buffer,
      ),
      tolerance = (bits === 4 ? 0.3 : 3 / (1 << (bits - 1))) + 2 / 32767;
    for (let i = 0; i < count; i++) {
      const q = [0, 1, 2, 3].map((k) => quats[i * 4 + k]),
        d = [0, 1, 2, 3].map((k) => out[i * 4 + k] / 32767),
        sign = Math.sign(q.reduce((sum, v, k) => sum + v * d[k], 0)) || 1;
      for (let k = 0; k < 4; k++) assert.ok(Math.abs(sign * d[k] - q[k]) <= tolerance, `bits ${bits} quat ${i}[${k}]`);
    }
  }
});

test('EXPONENTIAL filter: decoding is exactly 2^e * m with |m| inside the mantissa bits', () => {
  const values = [
    0,
    1,
    -1,
    0.5,
    3.7,
    -2.1,
    1e-20,
    -1e20,
    123456.789,
    2 ** 24,
    1 / 3,
    ...Array.from({ length: 200 }, () => (random() - 0.5) * 10 ** ((random() * 20) | 0)),
  ];
  for (const bits of [23, 15, 8, 1]) {
    const count = values.length,
      filtered = exponentialFilter(values, count, 4, bits),
      words = new Int32Array(filtered.buffer),
      out = new Float32Array(
        decode(encodeAttributes(filtered, count, 4), count, 4, 'ATTRIBUTES', 'EXPONENTIAL').buffer,
      );
    for (let i = 0; i < count; i++) {
      const e = words[i] >> 24,
        m = (words[i] << 8) >> 8;
      assert.ok(e >= -100 && e <= 100, 'exponent range');
      assert.ok(Math.abs(m) < 2 ** bits, `mantissa within ${bits} bits`);
      assert.equal(out[i], Math.fround(m * 2 ** e), `value ${i} decodes exactly`);
      if (values[i] !== 0)
        assert.ok(Math.abs(out[i] - values[i]) <= Math.abs(values[i]) * 2 ** (1 - bits), `value ${i} precision`);
    }
  }
  // Stride 12 (three floats an element) too.
  const floats = Float32Array.from({ length: 30 }, () => random() * 8 - 4),
    out = new Float32Array(
      decode(encodeAttributes(exponentialFilter(floats, 10, 12, 23), 10, 12), 10, 12, 'ATTRIBUTES', 'EXPONENTIAL')
        .buffer,
    );
  for (let i = 0; i < 30; i++) assert.ok(Math.abs(out[i] - floats[i]) <= Math.abs(floats[i]) * 2 ** -22);
});

test('COLOR filter: decoded colours are the quantised integers rescaled, within one unit', () => {
  for (const [stride, bits] of [
    [4, 8],
    [4, 7],
    [4, 2],
    [8, 16],
    [8, 12],
  ]) {
    const count = 500,
      colors = Float32Array.from({ length: count * 4 }, (_, i) => (i < 16 ? [0, 1][(i >> 1) & 1] : random())),
      out = decode(
        encodeAttributes(colorFilter(colors, count, stride, bits), count, stride, { version: 1 }),
        count,
        stride,
        'ATTRIBUTES',
        'COLOR',
      ),
      decoded = stride === 4 ? out : new Uint16Array(out.buffer),
      full = stride === 4 ? 255 : 65535,
      top = (1 << bits) - 1;
    for (let i = 0; i < count; i++) {
      const [r, g, b, a] = quantizeColor(...colors.subarray(i * 4, i * 4 + 4), bits),
        wide = (a << 1) | (a & 1),
        expected = [r, g, b, wide].map((v) => Math.round((v * full) / top));
      for (let k = 0; k < 4; k++)
        assert.ok(Math.abs(decoded[i * 4 + k] - expected[k]) <= 1, `${bits}-bit colour ${i}[${k}]`);
      for (let k = 0; k < 3; k++)
        assert.ok(Math.abs([r, g, b][k] / top - colors[i * 4 + k]) <= 1.5 / top, `${bits}-bit quantisation ${i}[${k}]`);
    }
  }
});
