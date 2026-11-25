// GAP-FILM-STREAMHASH: a file hashed in chunks gives the same SHA-256 hex as hashBytes of the whole file, whatever the
// chunk sizes (NIST FIPS 180-4; the test vectors of its examples, FIPS 180-2 appendix B), from an async iterable, a
// plain iterable or a web ReadableStream, holding one chunk at a time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { SHA256, hashBytes, hashStream } from '../dist/hashed.js';

const text = (s) => new TextEncoder().encode(s);
/** Deterministic bytes (a 32-bit linear congruential sequence), so a failure repeats. */
const noise = (length, seed = 1) => {
  const out = new Uint8Array(length);
  for (let i = 0, x = seed; i < length; i++) out[i] = (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) >>> 24;
  return out;
};
const pieces = (bytes, sizes) => {
  const out = [];
  for (let at = 0, i = 0; at < bytes.length; i++) {
    const size = sizes[i % sizes.length];
    out.push(bytes.subarray(at, at + size));
    at += size;
  }
  return out;
};

test('SHA256 gives the FIPS 180 example digests', () => {
  assert.equal(
    new SHA256().update(text('abc')).digest(),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(
    new SHA256().update(text('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).digest(),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );
  assert.equal(new SHA256().digest(), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  const million = new SHA256(),
    a = new Uint8Array(1000).fill(0x61);
  for (let i = 0; i < 1000; i++) million.update(a);
  assert.equal(million.digest(), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});

test('hashStream equals hashBytes for every length around the block and padding edges and any chunking', async () => {
  for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 65537]) {
    const bytes = noise(length, length + 7),
      whole = await hashBytes(bytes);
    for (const sizes of [[length || 1], [1], [3, 61, 64, 7], [4096]])
      assert.equal(await hashStream(pieces(bytes, sizes)), whole, `${length} bytes in pieces of ${sizes}`);
  }
  const big = noise(3 << 20, 99),
    whole = await hashBytes(big);
  assert.equal(await hashStream(Readable.from(pieces(big, [65536]))), whole, 'a Node stream');
  assert.equal(await hashStream(new Blob([big]).stream()), whole, 'a web ReadableStream');
  async function* slowly() {
    for (const piece of pieces(big, [100_000, 1])) yield piece;
  }
  assert.equal(await hashStream(slowly()), whole, 'an async generator');
});

test('hashStream checks its input and stops on its signal', async () => {
  await assert.rejects(hashStream(null), TypeError);
  await assert.rejects(hashStream(42), TypeError);
  await assert.rejects(hashStream(['text']), TypeError);
  // Every cache throw links to its help entry (tests/errors-page.test.js reads the source for the same rule).
  await assert.rejects(hashStream(null), /margoengine\.com\/errors#cache/);
  assert.throws(() => new SHA256().update(new Float32Array(1)), /margoengine\.com\/errors#cache/);
  const stop = new AbortController();
  async function* endless() {
    for (let i = 0; ; i++) {
      if (i === 3) stop.abort(new Error('stopped'));
      yield new Uint8Array(10);
    }
  }
  await assert.rejects(hashStream(endless(), { signal: stop.signal }), /stopped/);
  const used = new SHA256();
  used.digest();
  assert.throws(
    () => used.update(new Uint8Array(1)),
    (e) => e.code === 'state',
  );
});

// KB-CACHE-HASHSTREAM-SPEED: in Node the hash runs on the runtime's own digest (node:crypto through
// process.getBuiltinModule), measured in docs/whitepaper/perf-history.md; native: false keeps the JavaScript that
// browsers run.
// Both give the same hex on every length and chunking; the plain path now reads whole blocks in place.
test('the runtime digest and the plain JavaScript give the same hex, and Node uses the runtime one by default', async () => {
  assert.equal(new SHA256().engine, 'native');
  assert.equal(new SHA256({ native: false }).engine, 'js');
  for (const native of [true, false]) {
    assert.equal(
      new SHA256({ native }).update(text('abc')).digest(),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    for (const length of [0, 1, 55, 56, 63, 64, 65, 127, 128, 129, 1000, 65537]) {
      const bytes = noise(length, length + 3),
        whole = await hashBytes(bytes);
      for (const sizes of [[length || 1], [1], [3, 61, 64, 7], [64], [130], [4096]])
        assert.equal(
          await hashStream(pieces(bytes, sizes), { native }),
          whole,
          `${native} ${length} bytes in pieces of ${sizes}`,
        );
    }
    const used = new SHA256({ native });
    used.digest();
    assert.throws(
      () => used.update(new Uint8Array(1)),
      (e) => e.code === 'state',
    );
    assert.throws(() => new SHA256({ native }).update([1, 2]), /errors#cache/);
  }
  // Without getBuiltinModule (a browser or a worker) the default falls back to the JavaScript.
  const saved = process.getBuiltinModule;
  try {
    process.getBuiltinModule = undefined;
    assert.equal(new SHA256().engine, 'js');
  } finally {
    process.getBuiltinModule = saved;
  }
  await assert.rejects(hashStream(42), /errors#cache/);
});
