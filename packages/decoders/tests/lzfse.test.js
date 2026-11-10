import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decodeLZFSE } from '../dist/lzfse.js';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`fixtures/lzfse/${name}.lzfse`, import.meta.url)));
const repeat = (data, count) => {
  const out = new Uint8Array(data.length * count);
  for (let i = 0; i < count; i++) out.set(data, i * data.length);
  return out;
};
const range = (n) => Uint8Array.from({ length: n }, (_, i) => i);
for (const [name, expected] of [
  ['raw', new TextEncoder().encode('abc')],
  ['lzvn', repeat(range(256), 15)],
  ['fse', repeat(Uint8Array.from([...new TextEncoder().encode('hello world '), ...range(100)]), 1000)],
  ['blocks', repeat(range(256), 10000)],
])
  test(`LZFSE reference-compressed ${name}: exact bytes and bounded allocation`, () => {
    const input = fixture(name);
    assert.deepEqual(decodeLZFSE(input), expected);
    assert.deepEqual(decodeLZFSE(input.buffer, { maxBytes: expected.length }), expected);
    assert.throws(() => decodeLZFSE(input, { maxBytes: expected.length - 1 }), /maxBytes/);
    // ByteOffset must apply to every header and payload, including v2 packed fields.
    const padded = new Uint8Array(input.length + 17);
    padded.set(input, 7);
    assert.deepEqual(decodeLZFSE(padded.subarray(7, 7 + input.length)), expected);
  });

test('LZFSE entropy-rich frequency tables, v1 and shared v2 tables', () => {
  const hash = readFileSync(new URL('fixtures/lzfse/entropy.sha256', import.meta.url), 'utf8').trim();
  assert.equal(
    createHash('sha256')
      .update(decodeLZFSE(fixture('entropy')))
      .digest('hex'),
    hash,
  );
  const expected = decodeLZFSE(fixture('fse'));
  assert.deepEqual(decodeLZFSE(fixture('v1')), expected);
  assert.deepEqual(decodeLZFSE(fixture('reused')), repeat(expected, 2));
});

test('LZFSE rejects truncation at every byte of compressed fixtures and unknown signatures', () => {
  for (const name of ['raw', 'lzvn', 'fse', 'v1', 'reused']) {
    const data = fixture(name);
    for (let end = 0; end < data.length; end++)
      assert.throws(() => decodeLZFSE(data.subarray(0, end)), { code: 'failed' });
    assert.throws(() => decodeLZFSE(Uint8Array.from([...data, 0])), /after end marker/);
  }
  assert.throws(() => decodeLZFSE(Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0)), /signature/);
  for (const maxBytes of [-1, NaN, Infinity, 1.5])
    assert.throws(() => decodeLZFSE(fixture('raw'), { maxBytes }), RangeError);
  const controller = new AbortController(),
    reason = new Error('cancelled');
  controller.abort(reason);
  assert.throws(
    () => decodeLZFSE(fixture('fse'), { signal: controller.signal }),
    (error) => error === reason,
  );
});

test('LZVN previous-distance packets with literal lengths 1 and 2 are valid', () => {
  // Original packet stream: "abcd", then 3 matches with the retained distance.
  const payload = Uint8Array.of(0xe4, 97, 98, 99, 100, 0x00, 4, 0x5e, 88, 0x9e, 89, 90, 6, 0, 0, 0, 0, 0, 0, 0),
    bytes = new Uint8Array(12 + payload.length + 4),
    dv = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('bvxn'));
  dv.setUint32(4, 22, true);
  dv.setUint32(8, payload.length, true);
  bytes.set(payload, 12);
  bytes.set(new TextEncoder().encode('bvx$'), bytes.length - 4);
  const out = decodeLZFSE(bytes);
  assert.equal(out.length, 22);
  assert.deepEqual([...out.subarray(0, 7)], [...new TextEncoder().encode('abcdabc')]);
});
