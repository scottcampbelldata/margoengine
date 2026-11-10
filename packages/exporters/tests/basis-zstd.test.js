import test from 'node:test';
import assert from 'node:assert/strict';
import { zstdDecompressSync } from 'node:zlib';
import { loadNativeBasis } from '../dist/basis-native.js';
import { decompressZstd } from '../../shared/zstd.js';

const api = await loadNativeBasis(new URL('../dist/basis-encoder/margo_basis_encoder.wasm', import.meta.url));
function compress(input) {
  const capacity = input.length * 2 + 65536,
    source = api.allocate(input.length),
    output = api.allocate(capacity);
  try {
    new Uint8Array(api.memory.buffer, source, input.length).set(input);
    const size = api.encode_zstd(source, input.length, output, capacity);
    assert.ok(size > 0);
    return new Uint8Array(api.memory.buffer, output, size).slice();
  } finally {
    api.release(source, input.length);
    api.release(output, capacity);
  }
}
function noise(length, alphabet, skew) {
  let state = 0x13579;
  return Uint8Array.from({ length }, () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return skew && state & 1 ? 0 : (state >>> 8) % alphabet;
  });
}

test('Zstandard compresses low-entropy literals without changing any byte', async () => {
  const input = noise(131073, 256, true),
    encoded = compress(input);
  // Raw literals fail this deterministic byte budget despite LZ matching.
  assert.ok(encoded.length < input.length * 0.8, `encoded ${encoded.length} of ${input.length}`);
  assert.deepEqual(new Uint8Array(zstdDecompressSync(encoded)), input);
  assert.deepEqual(await decompressZstd(encoded), input);
});

test('literal entropy coding interoperates over alphabets, stream sizes and frame boundaries', async () => {
  for (const length of [16, 17, 31, 255, 256, 1023, 1024, 4095, 4096, 16383, 16384, 131071, 131072, 131073])
    for (const alphabet of [2, 7, 128, 129, 255, 256]) {
      const input = noise(length, alphabet, true),
        encoded = compress(input);
      assert.deepEqual(new Uint8Array(zstdDecompressSync(encoded)), input, `${length}/${alphabet}/native`);
      assert.deepEqual(await decompressZstd(encoded), input, `${length}/${alphabet}/Margo`);
    }
});
