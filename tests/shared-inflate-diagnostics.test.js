// Synthetic malformed fixtures written directly from RFC 1951, not an external compressor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, deflateRawSync } from 'node:zlib';
import { inflateRaw, inflateZlib } from '../packages/shared/inflate.js';

class Bits {
  bits = [];
  put(value, width) {
    for (let i = 0; i < width; i++) this.bits.push((value >>> i) & 1);
    return this;
  }
  code(value, width) {
    for (let i = width - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
    return this;
  }
  bytes() {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((b, i) => (out[i >> 3] |= b << (i & 7)));
    return out;
  }
}
const fixed = () => new Bits().put(1, 1).put(1, 2);
const dynamic = (lengths = [2, 2, 2, 2]) => {
  const b = new Bits().put(1, 1).put(2, 2).put(0, 5).put(0, 5).put(0, 4);
  for (const n of lengths) b.put(n, 3);
  return b;
};
const cases = [
  ['reserved block', new Bits().put(1, 1).put(3, 2).bytes(), /reserved block type 3/],
  ['stored header truncated', Uint8Array.of(1, 0), /stored block length/],
  ['stored length check', Uint8Array.of(1, 1, 0, 0, 0, 65), /stored block.*length check/],
  ['stored body truncated', Uint8Array.of(1, 2, 0, 253, 255, 65), /stored block data/],
  [
    'literal count',
    new Bits().put(1, 1).put(2, 2).put(31, 5).put(0, 5).put(0, 4).bytes(),
    /288 literal\/length codes.*286/,
  ],
  ['oversubscribed Huffman', dynamic([1, 1, 1, 0]).bytes(), /over-subscribed Huffman/],
  ['undefined code', dynamic([1, 0, 0, 0]).code(1, 1).bytes(), /Huffman code its block does not define/],
  ['repeat before first', dynamic().code(1, 2).put(0, 2).bytes(), /repeats a code length before the first/],
  [
    'repeat past count',
    dynamic().code(3, 2).put(127, 7).code(3, 2).put(127, 7).bytes(),
    /repeats code lengths past the declared count/,
  ],
  ['no end code', dynamic().code(3, 2).put(127, 7).code(3, 2).put(109, 7).bytes(), /without an end-of-block code/],
  ['reserved length', fixed().code(198, 8).bytes(), /reserved length symbol 286/],
  ['reserved distance', fixed().code(113, 8).code(1, 7).code(30, 5).bytes(), /reserved distance symbol 30/],
  ['backreference', fixed().code(1, 7).code(0, 5).bytes(), /refers back.*before the start/],
  ['stream truncated', Uint8Array.of(3), /ends early.*DEFLATE/],
];
for (const [name, bytes, message] of cases)
  test(name, () =>
    assert.throws(
      () => inflateRaw(bytes, 0, { limit: 100 }),
      (error) => {
        assert.equal(error.name, 'MargoError');
        assert.equal(error.code, 'failed');
        assert.match(error.message, message);
        assert.match(error.message, /https:\/\/margoengine.com\/errors#failed/);
        return true;
      },
    ),
  );
test('exact size mismatches distinguish overflow and underflow', () => {
  const input = deflateSync(Uint8Array.of(1, 2, 3), { level: 0 });
  assert.throws(() => inflateZlib(input, 2), /at least 3 bytes.*expected 2/);
  assert.throws(() => inflateZlib(input, 4), /3 bytes.*expected 4/);
});
test('size limits identify policy rather than damaged input', () => {
  const input = deflateRawSync(new Uint8Array(40), { level: 0 });
  assert.throws(
    () => inflateRaw(input, 0, { limit: 12 }),
    (e) => {
      assert.equal(e.code, 'failed');
      assert.match(e.message, /at least 40 bytes.*limit 12 bytes/);
      assert.match(e.message, /raise.*limit/);
      assert.doesNotMatch(e.message, /damaged|export it again/);
      return true;
    },
  );
});
for (const [name, input, pattern] of [
  ['short header', Uint8Array.of(0x78), /too short for a zlib header/],
  ['compression method', Uint8Array.of(0x77, 0), /compression method 7.*DEFLATE \(8\)/],
  ['window size', Uint8Array.of(0x88, 0), /window size 8.*maximum 7/],
  ['header check', Uint8Array.of(0x78, 0), /zlib header check/],
])
  test(`zlib ${name}`, () => assert.throws(() => inflateZlib(input, 0), pattern));
test('preset dictionary is unsupported, with a usable recompression instruction', () => {
  const input = deflateSync(Buffer.from('sample'), { dictionary: Buffer.from('sample dictionary') });
  assert.throws(
    () => inflateZlib(input, 6),
    (e) => {
      assert.equal(e.name, 'MargoError');
      assert.equal(e.code, 'unsupported');
      assert.match(e.message, /needs a preset dictionary; recompress it without a preset dictionary/);
      assert.match(e.message, /errors#unsupported/);
      assert.doesNotMatch(e.message, /damaged/);
      return true;
    },
  );
});
test('zlib trailer truncation and corruption have distinct diagnostics', () => {
  const bytes = new Uint8Array(deflateSync(Uint8Array.of(1, 2, 3)));
  assert.throws(() => inflateZlib(bytes.subarray(0, bytes.length - 1), 3), /ends before its Adler-32 checksum/);
  bytes[bytes.length - 1] ^= 1;
  assert.throws(() => inflateZlib(bytes, 3), /fails its Adler-32 checksum/);
});
test('limit callers may name their public option without losing the byte counts', () => {
  const input = deflateRawSync(new Uint8Array(40), { level: 0 });
  assert.throws(
    () => inflateRaw(input, 0, { limit: 12, limitHint: 'increase maxSamples to raise this byte limit' }),
    /at least 40 bytes.*limit 12 bytes; increase maxSamples/,
  );
});
