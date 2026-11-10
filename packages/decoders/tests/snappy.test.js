import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeSnappy } from '../dist/snappy.js';

test('raw Snappy literals, every copy tag, and overlapping copies', () => {
  for (const copy of [[1, 1], [14, 1, 0], [15, 1, 0, 0, 0]]) {
    const count = copy[0] === 1 ? 4 : 4;
    assert.equal(new TextDecoder().decode(decodeSnappy(Uint8Array.from([1 + count, 0, 120, ...copy]))), 'xxxxx');
  }
  // 300-byte literal uses two bytes for (length - 1).
  const block = Uint8Array.from([0xac, 2, 0xf4, 0x2b, 1, ...new Uint8Array(300).fill(42)]);
  assert.deepEqual(decodeSnappy(block), new Uint8Array(300).fill(42));
  assert.deepEqual(decodeSnappy(Uint8Array.of(0)), new Uint8Array());
});
test('Snappy rejects corrupt lengths, offsets, trailing tags, bombs, and cancellation', () => {
  for (const bytes of [[], [128], [128, 128, 128, 128, 128, 1], [1, 0], [1, 2, 0, 0], [0, 0, 1], [5, 0, 120, 1, 0]])
    assert.throws(() => decodeSnappy(Uint8Array.from(bytes)));
  assert.throws(() => decodeSnappy(Uint8Array.of(2), { maxOutputSize: 1 }), /exceeds/);
  const signal = AbortSignal.abort(); assert.throws(() => decodeSnappy(Uint8Array.of(0), { signal }));
});
