import assert from 'node:assert/strict';
import test from 'node:test';
import { zstdCompressSync, constants } from 'node:zlib';
import { decompressZstd } from '../../shared/zstd.js';
const compress = (b, options = {}) =>
  zstdCompressSync(b, {
    params: {
      [constants.ZSTD_c_checksumFlag]: 1,
      ...options,
    },
  });

test('Zstd borrows a fixed destination without output allocation, growth or a final copy', async () => {
  const source = new Uint8Array(4 << 20).map((_, i) => (i * 59 + (i >>> 12)) & 255);
  const packed = compress(source),
    storage = new Uint8Array(source.length + 32).fill(0xa5);
  const destination = storage.subarray(16, -16),
    allocations = [],
    Original = globalThis.Uint8Array;
  globalThis.Uint8Array = new Proxy(Original, {
    construct(target, args) {
      if (typeof args[0] === 'number') allocations.push(args[0]);
      return Reflect.construct(target, args);
    },
  });
  let result;
  try {
    result = await decompressZstd(packed, { destination });
  } finally {
    globalThis.Uint8Array = Original;
  }
  assert.equal(result.buffer, storage.buffer);
  assert.equal(result.byteOffset, 16);
  assert.equal(result.length, source.length);
  assert.deepEqual(result, source);
  assert(
    allocations.every((n) => n <= 1 << 17),
    `unexpected large allocation: ${allocations}`,
  );
  assert(storage.subarray(0, 16).every((n) => n === 0xa5));
  assert(storage.subarray(-16).every((n) => n === 0xa5));
});

test('fixed destination retains concatenation, unknown sizes, checksums and capacity limits', async () => {
  const a = new TextEncoder().encode('Margo owned buffer '.repeat(1000));
  const b = new Uint8Array(200_000).fill(29);
  const skip = Uint8Array.of(0x50, 0x2a, 0x4d, 0x18, 1, 0, 0, 0, 77);
  const packed = Buffer.concat([skip, compress(a), skip, compress(b, { [constants.ZSTD_c_contentSizeFlag]: 0 })]);
  const expected = new Uint8Array(Buffer.concat([a, b]));
  for (const spare of [0, 19]) {
    const destination = new Uint8Array(expected.length + spare).fill(0xa5);
    const result = await decompressZstd(packed, { destination });
    assert.equal(result.buffer, destination.buffer);
    assert.deepEqual(result, expected);
    assert(destination.subarray(result.length).every((n) => n === 0xa5));
  }
  const small = new Uint8Array(expected.length - 1);
  await assert.rejects(decompressZstd(packed, { destination: small }), /limit/);
  await assert.rejects(
    decompressZstd(packed, { destination: new Uint8Array(expected.length), maxOutputSize: a.length }),
    /limit/,
  );
  const bad = compress(a);
  bad[bad.length - 1] ^= 1;
  await assert.rejects(decompressZstd(bad, { destination: new Uint8Array(a.length) }), /checksum/);
  for (let n = 0; n < bad.length; n++)
    await assert.rejects(decompressZstd(bad.subarray(0, n), { destination: new Uint8Array(a.length) }), RangeError);
  assert.equal((await decompressZstd(skip, { destination: new Uint8Array(0) })).length, 0);
});

test('fixed destination rejects aliasing, invalid storage, dictionaries and oversized windows', async () => {
  const source = new Uint8Array(4096),
    packed = compress(source),
    destination = new Uint8Array(8192);
  destination.set(packed);
  await assert.rejects(decompressZstd(destination.subarray(0, packed.length), { destination }), /overlap/);
  await assert.rejects(decompressZstd(packed, { destination: {} }), TypeError);
  await assert.rejects(decompressZstd(packed, { destination, maxWindowSize: 100 }), /maxWindowSize/);
  const dictionary = Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0x01, 0, 7, 1, 0, 0);
  await assert.rejects(decompressZstd(dictionary, { destination }), (e) => e.code === 'unsupported');
  const separate = destination.subarray(2048, 6144);
  const result = await decompressZstd(destination.subarray(0, packed.length), { destination: separate });
  assert.deepEqual(result, source);
  assert.equal(result.byteOffset, 2048);
});

test('fixed destination abort and Wasm growth reject during a yielded decode', async () => {
  const source = new Uint8Array(16 << 20),
    packed = compress(source);
  const before = new Uint8Array(source.length).fill(91);
  await assert.rejects(
    decompressZstd(packed, { destination: before, signal: AbortSignal.abort(new Error('before')) }),
    /before/,
  );
  assert(before.every((n) => n === 91));
  const controller = new AbortController();
  const task = decompressZstd(packed, { destination: before, signal: controller.signal });
  controller.abort(new Error('during'));
  await assert.rejects(task, /during/);
  const memory = new WebAssembly.Memory({ initial: 257 });
  const growing = decompressZstd(packed, { destination: new Uint8Array(memory.buffer, 0, source.length) });
  memory.grow(1);
  await assert.rejects(growing, /detached/);
});
