// meshopt on Wasm SIMD (@margoengine/decoders/meshopt-simd): the output must equal the TypeScript decoder's byte for byte,
// on the reference vectors, on every compressed view of real gltfpack files, and on streams that fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MeshoptDecoder, meshoptDecodeGltfBuffer as plain } from '../dist/meshopt.js';
import { meshoptDecodeGltfBufferSIMD as simd, MeshoptSIMDDecoder } from '../dist/meshopt-simd.js';

const fixtures = new URL('./fixtures/', import.meta.url),
  repo = new URL('../../../', import.meta.url),
  vectors = JSON.parse(readFileSync(new URL('meshopt-vectors.json', fixtures), 'utf8')),
  base64 = (text) => new Uint8Array(Buffer.from(text, 'base64'));

await MeshoptSIMDDecoder.ready;

function compressedViews(url) {
  const data = new Uint8Array(readFileSync(url));
  let json, binary;
  if (url.pathname.endsWith('.glb')) {
    const view = new DataView(data.buffer, data.byteOffset),
      length = view.getUint32(12, true),
      at = 20 + length + 8;
    json = JSON.parse(Buffer.from(data.subarray(20, 20 + length)));
    binary = data.subarray(at, at + view.getUint32(20 + length, true));
  } else json = JSON.parse(Buffer.from(data));
  const buffers = json.buffers.map((buffer, i) => {
    if (i === 0 && binary) return binary;
    return buffer.uri ? new Uint8Array(readFileSync(new URL(buffer.uri, url))) : new Uint8Array(0);
  });
  return json.bufferViews.flatMap((view) => {
    const c = view.extensions?.EXT_meshopt_compression ?? view.extensions?.KHR_meshopt_compression;
    if (!c) return [];
    const at = c.byteOffset ?? 0;
    return [[buffers[c.buffer].subarray(at, at + c.byteLength), c.count, c.byteStride, c.mode, c.filter ?? 'NONE']];
  });
}

test('this runtime has Wasm SIMD, so the rest of this file tests the module', () => {
  assert.equal(MeshoptSIMDDecoder.supported, true);
});

test('the reference vectors decode to the same bytes', () => {
  for (const c of vectors.cases) {
    const args = [base64(c.encoded), c.count, c.stride ?? c.size, c.mode, c.filter ?? 'NONE'];
    assert.deepEqual(simd(...args), plain(...args), c.name);
  }
});

test('every compressed view of real files decodes to the same bytes, in both codec versions and every filter', () => {
  const seen = new Set();
  for (const file of [
    new URL('meshopt-simd/knight-ext.glb', fixtures),
    new URL('meshopt-simd/knight-khr.glb', fixtures),
    new URL('examples/assets/khronos/MeshoptCubeTest/MeshoptCubeTest.gltf', repo),
  ])
    for (const args of compressedViews(file)) {
      seen.add(`${args[3]} ${args[4]} v${args[0][0] & 15}`);
      assert.deepEqual(simd(...args), plain(...args), `${file.pathname} ${args.slice(1)}`);
    }
  for (const name of ['ATTRIBUTES NONE v0', 'ATTRIBUTES NONE v1', 'ATTRIBUTES OCTAHEDRAL v0', 'TRIANGLES NONE v1'])
    assert.ok(seen.has(name), `${name} in ${[...seen]}`);
});

test('a stream that fails gives the same error as the TypeScript decoder', () => {
  const vector = (name) => {
      const c = vectors.cases.find((v) => v.name === name);
      return [base64(c.encoded), c.count, c.stride ?? c.size];
    },
    [attributes, vertices, size] = vector('attributes'),
    [triangles, corners] = vector('triangles32'),
    [sequence, sequenceCount] = vector('indices'),
    cases = [
      // Index 100,000 cannot go into a 16-bit index buffer: refused, never cut to its low 16 bits.
      [sequence, sequenceCount, 2, 'INDICES'],
      [Uint8Array.of(0xb0, ...attributes.subarray(1)), vertices, size, 'ATTRIBUTES'],
      [Uint8Array.of(0xa2, ...attributes.subarray(1)), vertices, size, 'ATTRIBUTES'],
      [attributes, vertices, 6, 'ATTRIBUTES'],
      [attributes, vertices, 260, 'ATTRIBUTES'],
      [Uint8Array.of(...attributes, 0), vertices, size, 'ATTRIBUTES'],
      [attributes.subarray(0, -1), vertices, size, 'ATTRIBUTES'],
      [attributes, 10000000, size, 'ATTRIBUTES'],
      [attributes, -1, size, 'ATTRIBUTES'],
      [attributes, 2 ** 27 + 1, size, 'ATTRIBUTES'],
      [Uint8Array.of(0xd1, ...triangles.subarray(1)), corners, 4, 'TRIANGLES'],
      [Uint8Array.of(0xe2, ...triangles.subarray(1)), corners, 4, 'TRIANGLES'],
      [triangles, corners - 1, 4, 'TRIANGLES'],
      [triangles.subarray(0, -1), corners, 4, 'TRIANGLES'],
    ];
  for (const args of cases) {
    let expected;
    try {
      plain(...args);
    } catch (error) {
      expected = error;
    }
    assert.ok(expected, `${args.slice(1)}`);
    assert.throws(
      () => simd(...args),
      (error) => error.constructor === expected.constructor && error.message === expected.message,
      `${args.slice(1)}`,
    );
  }
  const [src, count, stride, mode] = compressedViews(new URL('meshopt-simd/knight-ext.glb', fixtures))[0],
    cut = src.subarray(0, src.length - 7);
  assert.throws(() => simd(cut, count, stride, mode), { message: /EXT_meshopt_compression: / });
  assert.throws(() => simd(src, count, stride, mode, 'RAINBOW'), { message: /unknown filter|filters only apply/ });
  assert.throws(() => simd(src, -1, stride, mode), RangeError);
});

test('a damaged real stream gives the bytes or the error of the TypeScript decoder, every time', () => {
  const views = compressedViews(new URL('meshopt-simd/knight-khr.glb', fixtures)),
    filters = ['NONE', 'OCTAHEDRAL', 'QUATERNION', 'EXPONENTIAL', 'COLOR', 'BOGUS'],
    outcome = (decode, args) => {
      try {
        return { bytes: decode(...args) };
      } catch (error) {
        return { type: error.constructor, message: error.message };
      }
    };
  let seed = 12345,
    decoded = 0,
    refused = 0;
  const next = (below) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return Math.floor((seed / 2 ** 32) * below);
  };
  for (let round = 0; round < 4000; round++) {
    const [stream, count, stride, mode, filter] = views[next(views.length)],
      src = stream.slice(),
      kind = next(4);
    if (kind < 2) src[next(src.length)] = next(256);
    const args = [
      kind === 2 ? src.subarray(0, next(src.length)) : src,
      count,
      stride,
      mode,
      kind === 3 ? filters[next(filters.length)] : filter,
    ];
    const expected = outcome(plain, args);
    assert.deepEqual(outcome(simd, args), expected, `round ${round}`);
    if (expected.bytes) decoded++;
    else refused++;
  }
  assert.ok(decoded > 0 && refused > 0, `${decoded} decoded, ${refused} refused`);
});

test('MeshoptSIMDDecoder writes into a target, and refuses one that is too small', () => {
  const [src, count, stride, mode, filter] = compressedViews(new URL('meshopt-simd/knight-ext.glb', fixtures))[0],
    target = new Uint8Array(count * stride);
  MeshoptSIMDDecoder.decodeGltfBuffer(target, count, stride, src, mode, filter);
  assert.deepEqual(target, plain(src, count, stride, mode, filter));
  let expected;
  try {
    MeshoptDecoder.decodeGltfBuffer(new Uint8Array(1), count, stride, src, mode, filter);
  } catch (error) {
    expected = error;
  }
  assert.ok(expected instanceof RangeError);
  assert.throws(
    () => MeshoptSIMDDecoder.decodeGltfBuffer(new Uint8Array(1), count, stride, src, mode, filter),
    (error) => error.constructor === RangeError && error.message === expected.message,
  );
});

test('memory grows for a large output and earlier results stay', () => {
  const c = vectors.cases.find((v) => v.mode === 'ATTRIBUTES'),
    args = [base64(c.encoded), c.count, c.stride ?? c.size, c.mode, c.filter ?? 'NONE'],
    first = simd(...args),
    big = new Uint8Array(32 << 20);
  big[0] = 0xa0;
  assert.throws(() => simd(big, big.length / 4, 4, 'ATTRIBUTES'));
  assert.deepEqual(simd(...args), first);
});

test('without Wasm SIMD, or before ready, the TypeScript decoder runs', async () => {
  const fresh = await import(`../dist/meshopt-simd.js?before-ready`),
    [src, count, stride, mode, filter] = compressedViews(new URL('meshopt-simd/knight-ext.glb', fixtures))[0];
  assert.equal(fresh.MeshoptSIMDDecoder.supported, false);
  assert.deepEqual(fresh.meshoptDecodeGltfBufferSIMD(src, count, stride, mode, filter), plain(src, count, stride, mode, filter));
  const validate = WebAssembly.validate;
  WebAssembly.validate = () => false;
  try {
    const none = await import(`../dist/meshopt-simd.js?no-simd`);
    await none.MeshoptSIMDDecoder.ready;
    assert.equal(none.MeshoptSIMDDecoder.supported, false);
    assert.deepEqual(none.meshoptDecodeGltfBufferSIMD(src, count, stride, mode, filter), plain(src, count, stride, mode, filter));
  } finally {
    WebAssembly.validate = validate;
  }
});

test('the embedded module was built from the Rust source in this repository', () => {
  const generated = readFileSync(new URL('../src/meshopt-simd-wasm.ts', import.meta.url), 'utf8'),
    recorded = /source sha256 ([0-9a-f]{64})/.exec(generated)?.[1],
    source = readFileSync(new URL('../native/meshopt-simd/src/lib.rs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(recorded, createHash('sha256').update(source).digest('hex'), 'run node scripts/meshopt-simd-build.mjs');
});
