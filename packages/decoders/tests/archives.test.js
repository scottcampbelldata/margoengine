// bzip2 and xz: files from the outside libbzip2 and liblzma, damage, short streams and the output limit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decodeBzip2 } from '../dist/bzip2.js';
import { decodeLzma, decodeXz } from '../dist/xz.js';

const folder = new URL('./fixtures/archives/', import.meta.url),
  expected = JSON.parse(readFileSync(new URL('expected.json', folder), 'utf8')),
  read = (name) => new Uint8Array(readFileSync(new URL(name, folder))),
  decoder = (name) => (name.endsWith('.bz2') ? decodeBzip2 : name.endsWith('.xz') ? decodeXz : decodeLzma),
  coded = (error) => error.name === 'MargoError' && (error.code === 'failed' || error.code === 'unsupported');

for (const [name, { bytes, sha256 }] of Object.entries(expected))
  test(`${name} decodes byte for byte`, () => {
    const out = decoder(name)(read(name));
    assert.equal(out.length, bytes);
    assert.equal(createHash('sha256').update(out).digest('hex'), sha256);
  });

test('every prefix of a stream is refused with a coded error', () => {
  for (const name of ['text.multi.bz2', 'floats.crc32.xz', 'text.lc.lzma']) {
    const whole = read(name),
      decode = decoder(name),
      join = name === 'text.multi.bz2' ? Buffer.from(whole).indexOf('BZh', 1) : -1;
    if (name === 'text.multi.bz2') assert.ok(join > 0);
    for (let length = 0; length < whole.length; length += Math.ceil(whole.length / 97)) {
      // The first of two concatenated bzip2 streams is a whole stream: it ends cleanly at the join.
      if (length === join) continue;
      assert.throws(() => decode(whole.subarray(0, length)), coded, `${name} at ${length}`);
    }
  }
});

test('damage to a checked file never comes through as data', () => {
  let seed = 21;
  const next = (n) => (seed = (seed * 1664525 + 1013904223) >>> 0) % n;
  for (const name of ['runs.9.bz2', 'text.multi.bz2', 'floats.crc32.xz', 'floats.crc64.xz', 'floats.sha.xz', 'text.lc2.xz']) {
    const whole = read(name),
      { sha256 } = expected[name];
    for (let i = 0; i < 300; i++) {
      const copy = whole.slice();
      copy[next(copy.length)] ^= 1 << next(8);
      try {
        const out = decoder(name)(copy, { maxBytes: 1 << 24 });
        assert.equal(createHash('sha256').update(out).digest('hex'), sha256, `${name}: wrong bytes got through`);
      } catch (error) {
        assert.ok(coded(error) || error.code === 'ERR_ASSERTION', `${name}: ${error}`);
        if (error.code === 'ERR_ASSERTION') throw error;
      }
    }
  }
});

test('damage to an unchecked .lzma ends in a coded error or some output, never a hang or a raw throw', () => {
  let seed = 4;
  const next = (n) => (seed = (seed * 1664525 + 1013904223) >>> 0) % n;
  const whole = read('floats.lzma');
  for (let i = 0; i < 300; i++) {
    const copy = whole.slice();
    copy[13 + next(copy.length - 13)] ^= 1 << next(8);
    try {
      decodeLzma(copy, { maxBytes: 1 << 24 });
    } catch (error) {
      assert.ok(coded(error), String(error));
    }
  }
});

test('a block whose stored check does not match is refused, for each kind of check', () => {
  for (const [name, size] of [['floats.crc32.xz', 4], ['floats.crc64.xz', 8], ['floats.sha.xz', 32]]) {
    const copy = read(name),
      footer = copy.length - 12,
      // The footer's backward size gives where the index starts; the block's check sits just before it.
      index = footer - (new DataView(copy.buffer, copy.byteOffset).getUint32(footer + 4, true) + 1) * 4;
    copy[index - size] ^= 1;
    assert.throws(() => decodeXz(copy), /fails its check/, name);
  }
});

test('output stops at maxBytes, and a file that fits exactly passes', () => {
  for (const name of ['zeros.9.bz2', 'text.lc2.xz', 'floats.lzma']) {
    const { bytes } = expected[name],
      decode = decoder(name),
      file = read(name);
    assert.equal(decode(file, { maxBytes: bytes }).length, bytes);
    assert.throws(() => decode(file, { maxBytes: bytes - 1 }), (e) => coded(e) && /maxBytes/.test(e.message));
  }
});

test('stopAt returns exactly the first bytes of a stream and decodes no further', () => {
  for (const name of Object.keys(expected).filter((n) => n.endsWith('.bz2'))) {
    const file = read(name),
      whole = decodeBzip2(file);
    for (const stop of [0, 1, 5, whole.length >> 1, whole.length, whole.length + 10]) {
      // maxBytes as small as the bytes wanted proves nothing past them was written, even inside a run.
      const want = Math.min(stop, whole.length),
        out = decodeBzip2(file, { stopAt: stop, maxBytes: Math.max(want, 1) });
      assert.deepEqual(out, whole.subarray(0, want), `${name} stopAt ${stop}`);
    }
  }
});

test('a wrong header is named, and an xz branch/call/jump filter is unsupported', () => {
  assert.throws(() => decodeBzip2(new TextEncoder().encode('not bzip2 data')), /no BZh header/);
  assert.throws(() => decodeXz(new TextEncoder().encode('not an xz file, at all')), /no xz header/);
  // XZ Utils' --x86 filter (0x04): the format specification names it but gives no algorithm.
  assert.throws(
    () => decodeXz(read('floats.x86.xz')),
    (e) => e.code === 'unsupported' && /filter 0x4/.test(e.message),
  );
});

// xz format 1.2.1: block header sizes (3.1.3, 3.1.4), header padding (3.1.6), the index records (4.2, 4.3) and the
// footer's backward size and flags (2.1.2.2, 2.1.2.3) MUST match what the stream holds. Each damage below keeps every
// CRC valid, so only those rules can catch it.
test('xz sizes in block headers, the index and the footer must match the stream (format 1.2.1 MUST rules)', () => {
  const crc = (bytes) => {
      let c = ~0;
      for (const b of bytes) {
        c ^= b;
        for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
      }
      return ~c >>> 0;
    },
    put = (file, at, value) => new DataView(file.buffer).setUint32(at, value, true),
    whole = read('floats.delta4.xz'),
    headerSize = (whole[12] + 1) * 4,
    reseal = (file) => put(file, 12 + headerSize - 4, crc(file.subarray(12, 12 + headerSize - 4))),
    damage = (change) => {
      const file = whole.slice();
      change(file);
      return file;
    };
  assert.equal(decodeXz(whole).length, 1_600_000);
  // Block header: flags 0xc0 (both sizes), then compressed size, uncompressed size 1,600,000 (0x80 0xd4 0x61).
  assert.equal(whole[13] & 0xc0, 0xc0);
  const sizes = 14,
    unpacked = sizes + (whole[sizes] & 0x80 ? 2 : 1);
  assert.deepEqual([...whole.subarray(unpacked, unpacked + 3)], [0x80, 0xd4, 0x61]);
  const cases = [
    ['an uncompressed size one too large', (f) => ((f[unpacked] = 0x81), reseal(f)), /sizes its header states/],
    ['a compressed size one too small', (f) => (f[sizes]--, reseal(f)), /sizes its header states/],
    ['a nonzero header padding byte', (f) => ((f[12 + headerSize - 5] = 1), reseal(f)), /header padding/],
  ];
  // Index: the 0x00 indicator follows the last block; footer is the last 12 bytes.
  const footer = whole.length - 12,
    backward = (new DataView(whole.buffer).getUint32(footer + 4, true) + 1) * 4,
    index = footer - backward,
    resealIndex = (f) => put(f, footer - 4, crc(f.subarray(index, footer - 4))),
    resealFooter = (f) => put(f, footer, crc(f.subarray(footer + 4, footer + 10)));
  assert.equal(whole[index], 0);
  cases.push(
    ['an index record off by one', (f) => (f[index + 2]++, resealIndex(f)), /index differs/],
    ['an index with two records', (f) => ((f[index + 1] = 2), resealIndex(f)), /lists 2 blocks/],
    ['a footer backward size one too large', (f) => (f[footer + 4]++, resealFooter(f)), /another index size/],
    ['footer flags naming another check', (f) => ((f[footer + 9] = 4), resealFooter(f)), /footer flags differ/],
  );
  for (const [what, change, message] of cases)
    assert.throws(() => decodeXz(damage(change)), (e) => e.code === 'failed' && message.test(e.message), what);
});
