// SHA-256 (@margoengine/exporters/hash): FIPS 180-4 vectors, node:crypto for every length across the padding
// boundaries and for arbitrary piece splits, and the finished-hash rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SHA256, sha256 } from '@margoengine/exporters/hash';

const text = (s) => new TextEncoder().encode(s);
const reference = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('standard vectors', () => {
  assert.equal(sha256(new Uint8Array()), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256(text('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(
    sha256(text('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );
  const million = new SHA256(),
    a = text('a'.repeat(1000));
  for (let i = 0; i < 1000; i++) million.update(a);
  assert.equal(million.hex(), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});

test('every length from 0 to 300 bytes, whole and in uneven pieces, matches node:crypto', () => {
  const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 31 + 7) & 255);
  for (let length = 0; length <= 300; length++) {
    const input = bytes.subarray(0, length),
      expected = reference(input);
    assert.equal(sha256(input), expected, `length ${length}`);
    const pieces = new SHA256();
    for (let at = 0, step = 1; at < length; at += step, step = (step * 3 + 1) % 97 || 1)
      pieces.update(input.subarray(at, Math.min(length, at + step)));
    assert.equal(pieces.hex(), expected, `pieces of length ${length}`);
  }
});

test('digest is 32 bytes, repeatable, and a finished hash refuses more data', () => {
  const hash = new SHA256().update(text('abc')),
    first = hash.digest();
  assert.equal(first.length, 32);
  first[0] ^= 255;
  assert.deepEqual(hash.digest(), Uint8Array.from(Buffer.from(reference(text('abc')), 'hex')));
  assert.equal(hash.hex(), reference(text('abc')));
  assert.throws(() => hash.update(text('d')), TypeError);
  assert.throws(() => new SHA256().update('abc'), TypeError);
});
