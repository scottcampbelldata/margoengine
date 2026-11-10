import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { constants, zstdCompressSync } from 'node:zlib';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { decodeLZ4, decodeLZ4Block } from '@margoengine/decoders/lz4';
import { decompressZstd } from '@margoengine/decoders/zstd';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/lz4/${name}`, import.meta.url)));
const manifest = JSON.parse(new TextDecoder().decode(fixture('manifest.json')));
const source = new Uint8Array(readFileSync(new URL('./fixtures/Avocado.bin', import.meta.url)));
const expected = new Uint8Array(source.length * 40);
for (let i = 0; i < 40; i++) expected.set(source, i * source.length);

test('LZ4 reads stored blocks, empty files, frames without checksums and framed dictionaries', async () => {
  const stored = new Uint8Array(
    Buffer.concat(
      Array.from({ length: 6251 }, (_, i) => createHash('sha256').update(`margo LZ4 stored ${i}`).digest()),
    ).subarray(0, 200003),
  );
  assert.deepEqual(await decodeLZ4(fixture('stored.lz4')), stored);
  assert.deepEqual(await decodeLZ4(fixture('empty.lz4')), new Uint8Array());
  assert.deepEqual(await decodeLZ4(fixture('plain.lz4')), expected);
  const options = { dictionary: expected.slice(-65536), dictionaryId: 203 };
  assert.deepEqual(await decodeLZ4(fixture('dictionary-frame.lz4'), options), expected.slice(0, 30000));
  await assert.rejects(decodeLZ4(fixture('dictionary-frame.lz4')), (error) => error.code === 'unsupported');
  await assert.rejects(decodeLZ4(fixture('dictionary-frame.lz4'), { ...options, dictionaryId: 204 }), /identifier/);
  // Empty stored block is distinct from the zero EndMark, and still has a block checksum.
  const emptyFrame = fixture('empty.lz4');
  const headerLength = 7 + (emptyFrame[4] & 8 ? 8 : 0) + (emptyFrame[4] & 1 ? 4 : 0);
  const storedZero = Uint8Array.of(0, 0, 0, 0x80, 5, 0x5d, 0xcc, 2);
  assert.deepEqual(
    await decodeLZ4(
      Buffer.concat([emptyFrame.subarray(0, headerLength), storedZero, emptyFrame.subarray(headerLength)]),
    ),
    new Uint8Array(),
  );
});

test('standalone stream entries decode in a Node worker without browser APIs', { timeout: 15000 }, async () => {
  const worker = new Worker(new URL('./support/stream-worker.mjs', import.meta.url), {
    workerData: { lz4: fixture(manifest.frames[0]), zstd: zstdCompressSync(expected) },
  });
  try {
    const decoded = await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    assert.deepEqual(decoded.lz4, expected);
    assert.deepEqual(decoded.zstd, expected);
  } finally {
    await worker.terminate();
  }
});

for (const name of manifest.frames)
  test(`standalone LZ4 matches native reference ${name}`, async () => {
    assert.deepEqual(await decodeLZ4(fixture(name)), expected);
  });

test('raw LZ4, dictionary history and legacy frames decode the native bytes exactly', async () => {
  const raw = fixture('raw.lz4');
  assert.deepEqual(decodeLZ4Block(raw, expected.length), expected);
  assert.deepEqual(
    decodeLZ4Block(fixture('dict.lz4'), 30000, { dictionary: expected.slice(-65536) }),
    expected.slice(0, 30000),
  );
  assert.throws(() => decodeLZ4Block(fixture('dict.lz4'), 30000), /history/);
  const legacy = new Uint8Array(8 + raw.length),
    view = new DataView(legacy.buffer);
  view.setUint32(0, 0x184c2102, true);
  view.setUint32(4, raw.length, true);
  legacy.set(raw, 8);
  assert.deepEqual(await decodeLZ4(legacy), expected);
  assert.deepEqual(
    await decodeLZ4(Buffer.concat([legacy, fixture(manifest.frames[0])])),
    new Uint8Array(Buffer.concat([expected, expected])),
  );
  assert.deepEqual(decodeLZ4Block(Uint8Array.of(0), 0), new Uint8Array());
});

test('LZ4 verifies header, block and content checksums and exact declared sizes', async () => {
  const original = fixture('4-0-0-1.lz4');
  // FLG + BD + uint64 size + HC: the first data block begins at byte 15.
  for (const at of [14, 19, original.length - 1]) {
    const damaged = original.slice();
    damaged[at] ^= 1;
    await assert.rejects(decodeLZ4(damaged), /checksum/);
  }
  await assert.rejects(decodeLZ4(original, { maxOutputSize: expected.length - 1 }), RangeError);
  assert.throws(() => decodeLZ4Block(fixture('raw.lz4'), expected.length + 1), /decoded size/);
  assert.throws(() => decodeLZ4Block(Uint8Array.of(0, 0, 0, 0), 20), /history/);
});

test('LZ4 concatenation skips metadata, honors sliced inputs, and bounds unknown sizes', async () => {
  const skip = Uint8Array.of(0x50, 0x2a, 0x4d, 0x18, 1, 0, 0, 0, 72);
  const packed = Buffer.concat([skip, fixture('4-0-1-0.lz4'), skip, fixture('7-16-0-1.lz4')]);
  assert.deepEqual(await decodeLZ4(packed), new Uint8Array(Buffer.concat([expected, expected])));
  const padded = Buffer.concat([Buffer.alloc(13), packed, Buffer.alloc(9)]);
  assert.deepEqual(await decodeLZ4(padded.subarray(13, -9)), new Uint8Array(Buffer.concat([expected, expected])));
  await assert.rejects(decodeLZ4(packed, { maxOutputSize: expected.length }), RangeError);
  assert.deepEqual(await decodeLZ4(skip), new Uint8Array());
});

test('every truncated LZ4 frame prefix rejects, and malformed blocks terminate with coded errors', {
  timeout: 120000,
}, async () => {
  const packed = fixture(manifest.frames[0]);
  for (let end = 0; end < packed.length; end++) await assert.rejects(decodeLZ4(packed.subarray(0, end)));
  for (const bytes of [Uint8Array.of(0xf0), Uint8Array.of(0, 0, 0), Uint8Array.of(0x10, 1, 1, 0)])
    assert.throws(
      () => decodeLZ4Block(bytes, 64),
      (error) => error.code === 'failed' || error instanceof RangeError,
    );
});

test('LZ4 validates options and cancels before or between blocks without swallowing the reason', async () => {
  await assert.rejects(decodeLZ4('bytes'), TypeError);
  for (const maxOutputSize of [-1, NaN, Infinity, 1.5])
    await assert.rejects(decodeLZ4(fixture(manifest.frames[0]), { maxOutputSize }), (error) => {
      assert.ok(error instanceof RangeError);
      assert.match(error.message, /https:\/\/margoengine\.com\/errors#limits\b/);
      return true;
    });
  const reason = new Error('cancel stream'),
    controller = new AbortController();
  await assert.rejects(
    decodeLZ4(fixture(manifest.frames[0]), { signal: AbortSignal.abort(reason) }),
    (error) => error === reason,
  );
  const skip = fixture(manifest.frames[0]);
  const pending = decodeLZ4(Buffer.concat(Array(130).fill(skip)), { signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
});

test('standalone Zstandard matches native compressed data, with concatenation, unknown sizes and destination reuse', async () => {
  const frames = [];
  for (const level of [-5, 1, 3, 9, 19]) {
    const bytes = zstdCompressSync(expected, {
      params: {
        [constants.ZSTD_c_compressionLevel]: level,
        [constants.ZSTD_c_checksumFlag]: 1,
        [constants.ZSTD_c_contentSizeFlag]: 0,
      },
    });
    assert.deepEqual(await decompressZstd(bytes), expected);
    frames.push(bytes);
  }
  const skip = Uint8Array.of(0x50, 0x2a, 0x4d, 0x18, 1, 0, 0, 0, 72),
    packed = Buffer.concat([skip, ...frames]);
  const storage = new Uint8Array(expected.length * frames.length + 32).fill(77),
    destination = storage.subarray(16, -16);
  const decoded = await decompressZstd(packed, { destination });
  assert.equal(decoded.buffer, destination.buffer);
  assert.equal(decoded.byteOffset, destination.byteOffset);
  assert.deepEqual(decoded, new Uint8Array(Buffer.concat(Array(frames.length).fill(expected))));
  assert.ok(storage.subarray(0, 16).every((byte) => byte === 77));
  assert.ok(storage.subarray(-16).every((byte) => byte === 77));
  const damaged = packed.slice();
  damaged[damaged.length - 1] ^= 1;
  await assert.rejects(decompressZstd(damaged), /checksum/);
  await assert.rejects(decompressZstd(packed, { maxOutputSize: 1 }), RangeError);
});
