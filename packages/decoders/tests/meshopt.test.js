// meshopt bufferView decoding (KHR_/EXT_meshopt_compression), checked three ways: the reference vectors (bit exact),
// every compressed view of two real glTF files (SHA-256 of the output), and streams this file encodes itself from the
// extension's bitstream description.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { requiredFixture } from '../../../scripts/support/required-fixture.mjs';
import { fileURLToPath } from 'node:url';
import {
  MeshoptDecoder,
  meshoptDecodeGltfBuffer as decode,
  meshoptDecodeIndexBuffer,
  meshoptDecodeIndexSequence,
  meshoptDecodeVertexBuffer,
} from '../dist/meshopt.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const fixtures = new URL('./fixtures/', import.meta.url);
const json = (name) => JSON.parse(readFileSync(new URL(name, fixtures), 'utf8'));
const base64 = (text) => new Uint8Array(Buffer.from(text, 'base64'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const reference = json('meshopt-vectors.json');
const views = json('meshopt-views.json');
const vector = (name) => {
  const c = reference.cases.find((v) => v.name === name);
  return { ...c, src: base64(c.encoded), expected: base64(c.expected) };
};
const throwsNamed = (fn, kind, pattern) =>
  assert.throws(fn, (error) => {
    assert.equal(error.constructor, kind, error.message);
    assert.match(error.message, /^EXT_meshopt_compression: /);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });

test('meshopt: every reference vector decodes bit for bit', () => {
  for (const meta of views.fixtureCases) {
    const c = vector(meta.name);
    const out = decode(c.src, c.count, c.stride, c.mode, c.filter);
    assert.equal(sha256(out), meta.outputSha256, c.name);
    assert.deepEqual(out, c.expected, c.name);
    const target = new Uint8Array(c.count * c.stride + 3);
    MeshoptDecoder.decodeGltfBuffer(target, c.count, c.stride, c.src, c.mode, c.filter);
    assert.deepEqual(target.subarray(0, c.count * c.stride), c.expected, `${c.name} via MeshoptDecoder`);
  }
  assert.equal(MeshoptDecoder.supported, true);
});

test('meshopt: every compressed bufferView of MeshoptCubeTest and Triangle.meshopt decodes to the recorded bytes', () => {
  let checked = 0;
  for (const file of views.gltfs) {
    const doc = JSON.parse(readFileSync(repo + file.path, 'utf8'));
    const dir = file.path.replace(/[^/]+$/, '');
    const buffers = new Map();
    const buffer = (index) => {
      if (!buffers.has(index)) {
        const uri = doc.buffers[index].uri;
        buffers.set(
          index,
          uri.startsWith('data:')
            ? Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64')
            : requiredFixture(repo + dir + uri, 'git lfs pull'),
        );
      }
      return buffers.get(index);
    };
    for (const view of file.views) {
      const bv = doc.bufferViews[view.bufferView];
      const ext = bv.extensions.KHR_meshopt_compression ?? bv.extensions.EXT_meshopt_compression;
      const data = buffer(ext.buffer);
      const src = new Uint8Array(data.buffer, data.byteOffset + (ext.byteOffset ?? 0), ext.byteLength);
      assert.equal(`0x${src[0].toString(16)}`, view.header, `view ${view.bufferView} header`);
      const out = decode(src, view.count, view.byteStride, view.mode, view.filter);
      assert.equal(out.length, view.result.length);
      assert.equal(sha256(out), view.result.sha256, `${file.path} view ${view.bufferView}`);
      checked++;
    }
  }
  assert.equal(checked, 62);
});

test('meshopt: edge and error cases decode or fail with the recorded class', () => {
  const expected = new Map(views.errorCases.map((c) => [c.name, c.result]));
  const attributes = vector('attributes');
  const triangles = vector('triangles32');
  const indices = vector('indices');
  const zeros = (n) => new Uint8Array(n);
  const cases = {
    'ATTRIBUTES count 0 on a v0 stream (header + 32-byte tail)': () =>
      decode(Uint8Array.of(0xa0, ...zeros(32)), 0, 16, 'ATTRIBUTES'),
    'ATTRIBUTES count 0 on a v0 stream, stride 48 (tail = stride)': () =>
      decode(Uint8Array.of(0xa0, ...zeros(48)), 0, 48, 'ATTRIBUTES'),
    'bad vertex header 0xb0': () => decode(Uint8Array.of(0xb0, ...attributes.src.subarray(1)), 300, 16, 'ATTRIBUTES'),
    'vertex version 2': () => decode(Uint8Array.of(0xa2, ...attributes.src.subarray(1)), 300, 16, 'ATTRIBUTES'),
    'stride 6': () => decode(attributes.src, 300, 6, 'ATTRIBUTES'),
    'stride 260': () => decode(attributes.src, 300, 260, 'ATTRIBUTES'),
    'attributes with one trailing byte': () => decode(Uint8Array.of(...attributes.src, 0), 300, 16, 'ATTRIBUTES'),
    'attributes missing last byte': () => decode(attributes.src.subarray(0, -1), 300, 16, 'ATTRIBUTES'),
    'count above what the bytes can hold': () => decode(attributes.src, 10000000, 16, 'ATTRIBUTES'),
    'negative count': () => decode(attributes.src, -1, 16, 'ATTRIBUTES'),
    'count*stride over 2^31': () => decode(attributes.src, 2 ** 27 + 1, 16, 'ATTRIBUTES'),
    'bad index header 0xd1 as TRIANGLES': () =>
      decode(Uint8Array.of(0xd1, ...triangles.src.subarray(1)), 864, 4, 'TRIANGLES'),
    'index codec version 2': () => decode(Uint8Array.of(0xe2, ...triangles.src.subarray(1)), 864, 4, 'TRIANGLES'),
    'TRIANGLES count not a multiple of 3': () => decode(triangles.src, 863, 4, 'TRIANGLES'),
    'TRIANGLES stride 3': () => decode(triangles.src, 864, 3, 'TRIANGLES'),
    'triangles with one trailing byte': () => decode(Uint8Array.of(...triangles.src, 0), 864, 4, 'TRIANGLES'),
    'triangles with codes truncated': () => decode(triangles.src.subarray(0, 100), 864, 4, 'TRIANGLES'),
    'index sequence bad header': () => decode(Uint8Array.of(0xe1, ...indices.src.subarray(1)), 10, 4, 'INDICES'),
    'index sequence trailing byte': () => decode(Uint8Array.of(...indices.src, 0), 10, 4, 'INDICES'),
    'index sequence as 16-bit': () => decode(indices.src, 10, 2, 'INDICES'),
    'unknown mode': () => decode(attributes.src, 300, 16, 'POINTS'),
    'filter on TRIANGLES': () => decode(triangles.src, 864, 4, 'TRIANGLES', 'OCTAHEDRAL'),
    'OCTAHEDRAL with stride 16': () => decode(attributes.src, 300, 16, 'ATTRIBUTES', 'OCTAHEDRAL'),
    'QUATERNION with stride 16': () => decode(attributes.src, 300, 16, 'ATTRIBUTES', 'QUATERNION'),
    'COLOR with stride 16': () => decode(attributes.src, 300, 16, 'ATTRIBUTES', 'COLOR'),
    'unknown filter': () => decode(attributes.src, 300, 16, 'ATTRIBUTES', 'SPHERICAL'),
    'EXPONENTIAL on stride 16 (allowed)': () => decode(attributes.src, 300, 16, 'ATTRIBUTES', 'EXPONENTIAL'),
    'filter empty string treated as NONE': () => decode(attributes.src, 300, 16, 'ATTRIBUTES', ''),
    'MeshoptDecoder.decodeGltfBuffer into a too-small target': () =>
      MeshoptDecoder.decodeGltfBuffer(new Uint8Array(100), 300, 16, attributes.src, 'ATTRIBUTES'),
    'meshoptDecodeVertexBuffer with output too small': () =>
      meshoptDecodeVertexBuffer(new Uint8Array(100), 300, 16, attributes.src),
    'meshoptDecodeIndexBuffer with output too small': () =>
      meshoptDecodeIndexBuffer(new Uint32Array(10), 864, triangles.src),
  };
  assert.deepEqual(Object.keys(cases).sort(), [...expected.keys()].sort());
  assert.deepEqual(decode(attributes.src, 300, 16, 'ATTRIBUTES', ''), attributes.expected);
  const words = new DataView(attributes.expected.buffer);
  const exp = new DataView(decode(attributes.src, 300, 16, 'ATTRIBUTES', 'EXPONENTIAL').buffer);
  for (let o = 0; o < 4800; o += 4) {
    const v = words.getInt32(o, true);
    assert.equal(exp.getFloat32(o, true), Math.fround(((v << 8) >> 8) * 2 ** (v >> 24)));
  }
  for (const [name, run] of Object.entries(cases)) {
    const want = expected.get(name);
    if (want.ok) {
      const out = run();
      assert.equal(out.length, want.length, name);
      // The recorded hashes of these two came from an input the vectors do not include; only the outcome is binding.
      if (!/EXPONENTIAL on stride|empty string/.test(name)) assert.equal(sha256(out), want.sha256, name);
    } else throwsNamed(run, globalThis[want.name], undefined);
  }
});

test('meshopt: a truncated v1 stream fails without reading past its end', () => {
  const meta = JSON.parse(readFileSync(`${repo}tests/fixtures/fuzz/meshopt-v1-truncated.json`, 'utf8'));
  const bytes = new Uint8Array(readFileSync(`${repo}tests/fixtures/fuzz/meshopt-v1-truncated.bin`));
  const guarded = new Proxy(bytes, {
    get(target, key) {
      if (typeof key === 'string' && /^\d+$/.test(key) && +key >= target.length) throw new Error(`read src[${key}]`);
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  throwsNamed(
    () => decode(guarded, meta.count, meta.stride, meta.mode, meta.filter),
    Error,
    /truncated vertex stream$/,
  );
  // Every prefix of every reference stream also fails with a named error and stays inside the bytes.
  for (const c of reference.cases) {
    const src = base64(c.encoded);
    for (let cut = 0; cut < src.length; cut += Math.max(1, src.length >> 6)) {
      const view = new Proxy(src.subarray(0, cut), {
        get(target, key) {
          if (typeof key === 'string' && /^\d+$/.test(key) && +key >= target.length) throw new Error(`read ${key}`);
          const value = target[key];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      assert.throws(
        () => decode(view, c.count, c.stride, c.mode, c.filter),
        (e) => /^EXT_meshopt_compression: /.test(e.message),
        `${c.name} cut ${cut}`,
      );
    }
  }
});

// ------------------------------------------------------------------ streams encoded here, from the bitstream text

const zigzag = (v) => (v < 0 ? -2 * v - 1 : 2 * v) >>> 0;
const varint = (out, v) => {
  for (v >>>= 0; v >= 128; v >>>= 7) out.push((v & 127) | 128);
  out.push(v);
};

/** Version-0 attribute stream using only raw (16-byte) and zero groups; deltas from the previous element. */
function encodeVertexV0(data, count, stride) {
  const out = [0xa0];
  const blockMax = Math.min(Math.floor(8192 / stride) & ~15, 256);
  const prev = new Uint8Array(stride); // baseline: all zeros
  for (let start = 0; start < count; start += blockMax) {
    const n = Math.min(count - start, blockMax);
    const groups = (n + 15) >> 4;
    const deltas = [];
    for (let k = 0; k < stride; k++) {
      const lane = new Uint8Array(groups * 16);
      for (let i = 0; i < n; i++) {
        const v = data[(start + i) * stride + k];
        lane[i] = zigzag(((v - prev[k] + 128) & 255) - 128);
        prev[k] = v;
      }
      deltas.push(lane);
    }
    for (const lane of deltas) {
      const header = new Uint8Array((groups + 3) >> 2);
      const body = [];
      for (let g = 0; g < groups; g++) {
        const group = lane.subarray(g * 16, g * 16 + 16);
        if (group.some((v) => v !== 0)) {
          header[g >> 2] |= 3 << ((g & 3) * 2);
          body.push(...group);
        }
      }
      out.push(...header, ...body);
    }
  }
  const tail = Math.max(32, stride);
  out.push(...new Uint8Array(tail - stride), ...new Uint8Array(stride));
  return Uint8Array.from(out);
}

/** Triangle stream (version 1) that spells every triangle with code 0xff and three explicit index deltas. */
function encodeTrianglesExplicit(indices) {
  const codes = [];
  const data = [];
  let last = 0;
  for (let t = 0; t < indices.length; t += 3) {
    codes.push(0xff);
    data.push(0xff); // Z = W = 15: b and c explicit too (and not 0, so next is not reset)
    for (const v of indices.subarray(t, t + 3)) {
      varint(data, zigzag(v - last));
      last = v;
    }
  }
  return Uint8Array.from([0xe1, ...codes, ...data, ...new Uint8Array(16)]);
}

/** Index sequence alternating the two baselines. */
function encodeSequence(indices) {
  const out = [0xd1];
  const last = [0, 0];
  indices.forEach((v, i) => {
    const which = i & 1;
    varint(out, (zigzag(v - last[which]) << 1) | which);
    last[which] = v;
  });
  return Uint8Array.from([...out, 0, 0, 0, 0]);
}

test('meshopt: self-encoded attribute, triangle and sequence streams round trip', () => {
  let seed = 99;
  const random = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed >>> 16;
  };
  for (const [count, stride] of [
    [1, 4],
    [17, 8],
    [300, 16],
    [700, 12],
    [40, 256],
  ]) {
    const data = Uint8Array.from({ length: count * stride }, (_, i) => (i % 5 === 0 ? 7 : random() & 255));
    const src = encodeVertexV0(data, count, stride);
    assert.deepEqual(decode(src, count, stride, 'ATTRIBUTES'), data, `${count} x ${stride}`);
  }
  const tris = Uint32Array.from({ length: 300 }, () => random() * 7919);
  const triStream = encodeTrianglesExplicit(tris);
  assert.deepEqual(new Uint32Array(decode(triStream, 300, 4, 'TRIANGLES').buffer), tris);
  // A 16-bit index buffer cannot hold these (up to 65,535 x 7,919): the stream is refused, never cut to its low 16 bits
  // (which drew triangles between the wrong vertices). Indices that fit decode the same either way.
  assert.throws(() => decode(triStream, 300, 2, 'TRIANGLES'), /does not fit a 16-bit index buffer/);
  const small = Uint32Array.from(tris, (v) => v % 65536),
    smallStream = encodeTrianglesExplicit(small);
  assert.deepEqual(new Uint16Array(decode(smallStream, 300, 2, 'TRIANGLES').buffer), Uint16Array.from(small));
  const wideSequence = encodeSequence(Uint32Array.of(1, 70000, 3));
  assert.throws(() => meshoptDecodeIndexSequence(new Uint16Array(3), 3, wideSequence), /16-bit/);
  const seq = Uint32Array.from({ length: 257 }, (_, i) => (i & 1 ? 100000 - i * 3 : i * 2));
  const seqStream = encodeSequence(seq);
  const out = new Uint32Array(257);
  meshoptDecodeIndexSequence(out, 257, seqStream);
  assert.deepEqual(out, seq);
});

test('meshopt: triangle codes follow the FIFO rules of the bitstream', () => {
  // 0xfe with aux 0x00 (three new vertices, resets next), then 0x00 (edge 0 + next), then 0x01 (edge 0 + vertex 1),
  // then 0x1d and 0x1e (edge 1 + last - 1 / last + 1, version 1 only).
  const codes = [0xfe, 0x00, 0x01, 0x1d, 0x1e];
  const src = Uint8Array.of(0xe1, ...codes, 0x00, ...new Uint8Array(16));
  const out = new Uint32Array(15);
  meshoptDecodeIndexBuffer(out, 15, src);
  // Triangle 0: (0,1,2); edges pushed (1,0) (2,1) (0,2); vertices 0,1,2.
  // Triangle 1: edge 0 = (0,2), c = next = 3; edges (3,2) (0,3); vertex 3.
  // Triangle 2: edge 0 = (0,3), c = vertex 1 = 2; edges (2,3) (0,2).
  // Triangle 3: edge 1 = (2,3), c = last - 1 = 0xffffffff (last starts at 0).
  // Triangle 4: edge 1 = (c3=0xffffffff, 3)... read below from the FIFO state.
  assert.deepEqual([...out.subarray(0, 12)], [0, 1, 2, 0, 2, 3, 0, 3, 2, 2, 3, 0xffffffff]);
  // After triangle 3 the FIFO holds (2, 0xffffffff) newest and (0xffffffff, 3) next; last = 0xffffffff, so +1 = 0.
  assert.deepEqual([...out.subarray(12)], [0xffffffff, 3, 0]);
  // Version 0 reads the vertex FIFO for 13 and 14 instead; slot 13 was never written, so it is all ones.
  const v0 = Uint8Array.of(0xe0, ...codes, 0x00, ...new Uint8Array(16));
  meshoptDecodeIndexBuffer(out, 15, v0);
  assert.equal(out[11], 0xffffffff);
});

test('meshopt: filters follow Appendix B on hand-made inputs', () => {
  const run = (bytes, stride, filter) => {
    const count = bytes.length / stride;
    const src = encodeVertexV0(bytes, count, stride);
    return decode(src, count, stride, 'ATTRIBUTES', filter);
  };
  // OCTAHEDRAL 8-bit: (0, 0, one) is +Z; (one, 0) is +X; (-one, 0) is -X; zero vector stays zero; w passes through.
  const oct = new Int8Array(
    run(
      new Uint8Array(new Int8Array([0, 0, 127, 5, 127, 0, 127, -9, -127, 0, 127, 1, 0, 0, 0, 3]).buffer),
      4,
      'OCTAHEDRAL',
    ).buffer,
  );
  assert.deepEqual([...oct], [0, 0, 127, 5, 127, 0, 0, -9, -127, 0, 0, 1, 0, 0, 0, 3]);
  // Lower hemisphere: x = y = one gives z = -one, folded to (0, 0, -1).
  const fold = new Int16Array(
    run(new Uint8Array(new Int16Array([1023, 1023, 1023, 0]).buffer), 8, 'OCTAHEDRAL').buffer,
  );
  assert.deepEqual([...fold], [0, 0, -32767, 0]);
  // QUATERNION: all three stored components 0 with max index 3 is the identity (0, 0, 0, 1).
  const quat = new Int16Array(
    run(new Uint8Array(new Int16Array([0, 0, 0, (1023 & ~3) | 3]).buffer), 8, 'QUATERNION').buffer,
  );
  assert.deepEqual([...quat], [0, 0, 0, 32767]);
  // EXPONENTIAL: m * 2^e, exact.
  const words = new Int32Array([(-3 << 24) | 5, (2 << 24) | (0xffffff & -7), 0, (-128 << 24) | 0x7fffff]);
  const exp = new Float32Array(run(new Uint8Array(words.buffer), 4, 'EXPONENTIAL').buffer);
  assert.deepEqual([...exp], [5 / 8, -28, 0, Math.fround(0x7fffff * 2 ** -128)]);
  // COLOR 8-bit, K = 8: Y = 100, Co = 20, Cg = -10, alpha 0x80 | 0x55 -> R 130, G 90, B 90, A 0xaa | 1.
  const col = run(Uint8Array.of(100, 20, 256 - 10, 0xd5), 4, 'COLOR');
  assert.deepEqual([...col], [130, 90, 90, 0xab]);
});
