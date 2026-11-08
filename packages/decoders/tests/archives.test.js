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

test('a wrong header is named, and an xz filter that is not LZMA2 is unsupported', () => {
  assert.throws(() => decodeBzip2(new TextEncoder().encode('not bzip2 data')), /no BZh header/);
  assert.throws(() => decodeXz(new TextEncoder().encode('not an xz file, at all')), /no xz header/);
  // Hand-made: one block header naming the delta filter (0x03), with its CRC32.
  const crc = (bytes) => {
      let c = ~0;
      for (const b of bytes) {
        c ^= b;
        for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
      }
      return ~c >>> 0;
    },
    word = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24],
    flags = [0, 1],
    head = [0x02, 0, 0x03, 0x01, 0, 0, 0, 0],
    file = Uint8Array.from([
      0xfd, 0x37, 0x7a, 0x58, 0x5a, 0, ...flags, ...word(crc(flags)), ...head, ...word(crc(head)),
    ]);
  assert.throws(
    () => decodeXz(file),
    (e) => e.code === 'unsupported' && /filter 0x3/.test(e.message),
  );
});
