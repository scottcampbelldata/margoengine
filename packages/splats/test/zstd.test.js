// The built-in Zstandard decoder (RFC 8878) against streams made by Node's own zstd (node:zlib, used only as a
// black-box encoder), the SPZ version 4 fixture, and damaged, truncated, over-limit and aborted input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as zlib from 'node:zlib';

// The decoder is an internal, lazily loaded chunk of the build (parseSpz imports it for version 4 files).
const chunk = readdirSync(new URL('../dist/', import.meta.url)).find((f) => /^zstd-.*\.js$/.test(f));
const { decompressZstd } = await import(new URL(`../dist/${chunk}`, import.meta.url));

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const hasZstd = typeof zlib.zstdCompressSync === 'function';
const skip = hasZstd ? false : 'this Node has no zstd in node:zlib (Node 22.15 or later)';
const P = zlib.constants;

/** Compresses with Node's zstd; `params` maps ZSTD_c_* names to values. */
function zstd(bytes, params = {}) {
  const p = {};
  for (const [k, v] of Object.entries(params)) p[P[`ZSTD_c_${k}`]] = v;
  return new Uint8Array(zlib.zstdCompressSync(bytes, { params: p }));
}

/** Deterministic test data: word-like text, random bytes, runs, and a real binary file. */
function corpus() {
  let seed = 7;
  const rand = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
  const words = ['splat', 'margo', 'engine', 'gaussian', 'zstandard', 'frame', 'block', 'the', 'of', 'and', 'a'];
  let text = '';
  while (text.length < 400_000) text += `${words[Math.floor(rand() ** 2 * words.length)]}${rand() < 0.1 ? '.\n' : ' '}`;
  const random = new Uint8Array(300_000).map(() => Math.floor(rand() * 256));
  const runs = new Uint8Array(500_000);
  for (let i = 0; i < runs.length; i += 1 + Math.floor(rand() * 5000)) runs.fill(Math.floor(rand() * 4), i);
  const ply = fixture('raccoon-v2.ply');
  // A random block, then single-byte literals between copies from it: the encoder picks RLE literals.
  const block = new Uint8Array(1 << 17).map(() => Math.floor(rand() * 256)),
    copies = [block];
  for (let i = 0; i < 1200; i++) {
    const at = Math.floor(rand() * 130_000);
    copies.push(Uint8Array.of(90), block.subarray(at, at + 100));
  }
  return {
    alphabet: new Uint8Array(3000).map(() => Math.floor(rand() * 6)), // few symbols: direct Huffman weights
    rleLiterals: new Uint8Array(Buffer.concat(copies)),
    empty: new Uint8Array(0),
    one: Uint8Array.of(42),
    small: new TextEncoder().encode('Hello, Hello, Hello Zstandard! '.repeat(3)),
    text: new TextEncoder().encode(text),
    random,
    runs,
    zeros: new Uint8Array(1 << 20),
    ply: ply.subarray(0, 1_200_000),
  };
}

test('decodes Node zstd output at every level, with checksums, small windows and no content size', {
  skip,
}, async () => {
  const data = corpus();
  const settings = [
    { compressionLevel: 1 },
    { compressionLevel: 3, checksumFlag: 1 },
    { compressionLevel: 9, checksumFlag: 1, contentSizeFlag: 0 },
    { compressionLevel: 19, checksumFlag: 1 },
    { compressionLevel: 22, checksumFlag: 1 },
    { compressionLevel: -5 },
    { compressionLevel: 6, windowLog: 10, checksumFlag: 1, contentSizeFlag: 0 },
    { compressionLevel: 15, windowLog: 12, contentSizeFlag: 0 },
  ];
  for (const params of settings)
    for (const [name, bytes] of Object.entries(data)) {
      const packed = zstd(bytes, params),
        out = await decompressZstd(packed);
      assert.equal(out.length, bytes.length, `${name} ${JSON.stringify(params)} length`);
      assert.ok(Buffer.from(out).equals(Buffer.from(bytes)), `${name} ${JSON.stringify(params)} bytes`);
    }
});

test('decodes several frames with skippable frames between them, and checks every xxHash64', { skip }, async () => {
  const { text, ply } = corpus(),
    a = zstd(text, { checksumFlag: 1 }),
    b = zstd(ply.subarray(0, 100_000), { compressionLevel: 19 }),
    skippable = Uint8Array.of(0x5a, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 9, 9, 9),
    joined = new Uint8Array([...skippable, ...a, ...skippable, ...b, ...skippable]);
  const out = await decompressZstd(joined);
  assert.ok(Buffer.from(out).equals(Buffer.concat([text, ply.subarray(0, 100_000)])));
  assert.equal((await decompressZstd(skippable)).length, 0, 'only skippable frames decode to nothing');
});

test('a failed content checksum, a reserved bit and bad magic throw RangeError', { skip }, async () => {
  const packed = zstd(corpus().text, { checksumFlag: 1 });
  const bad = packed.slice();
  bad[bad.length - 1] ^= 1;
  await assert.rejects(decompressZstd(bad), (e) => e instanceof RangeError && /checksum/.test(e.message));
  const reserved = packed.slice();
  reserved[4] |= 8;
  await assert.rejects(decompressZstd(reserved), (e) => e instanceof RangeError && /reserved/.test(e.message));
  await assert.rejects(decompressZstd(Uint8Array.of(1, 2, 3, 4, 5)), /magic/);
  await assert.rejects(decompressZstd(new Uint8Array(0)), RangeError);
  await assert.rejects(decompressZstd('nope'), TypeError);
});

test('every truncation of a stream throws RangeError', { skip }, async () => {
  for (const bytes of [corpus().small, corpus().text.subarray(0, 20_000)]) {
    const packed = zstd(bytes, { compressionLevel: 19, checksumFlag: 1 });
    for (let n = 0; n < packed.length; n++)
      await assert.rejects(decompressZstd(packed.subarray(0, n)), RangeError, `prefix ${n} of ${packed.length}`);
  }
});

test('damaged bytes throw RangeError or, with a checksum, can never return wrong data', { skip }, async () => {
  const { text, ply } = corpus();
  let seed = 3,
    thrown = 0;
  const rand = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
  for (const source of [text.subarray(0, 60_000), ply.subarray(0, 200_000)]) {
    const packed = zstd(source, { compressionLevel: 19, checksumFlag: 1 });
    for (let trial = 0; trial < 300; trial++) {
      const bad = packed.slice(),
        at = 6 + Math.floor(rand() * (bad.length - 10));
      bad[at] ^= 1 + Math.floor(rand() * 255);
      try {
        const out = await decompressZstd(bad);
        assert.ok(Buffer.from(out).equals(Buffer.from(source)), `trial ${trial} returned wrong bytes`);
      } catch (e) {
        assert.ok(e instanceof RangeError, `trial ${trial}: ${e}`);
        thrown++;
      }
    }
  }
  assert.ok(thrown > 500, `${thrown} of 600 damaged streams were refused`);
});

test('window and output limits are enforced before decoding', { skip }, async () => {
  const text = corpus().text;
  const windowed = zstd(text, { windowLog: 20, contentSizeFlag: 0 });
  await assert.rejects(
    decompressZstd(windowed, { maxWindowSize: 1 << 18 }),
    (e) => e instanceof RangeError && /maxWindowSize/.test(e.message),
  );
  assert.equal((await decompressZstd(windowed, { maxWindowSize: 1 << 20 })).length, text.length);
  await assert.rejects(
    decompressZstd(zstd(text), { maxOutputSize: text.length - 1 }),
    (e) => e instanceof RangeError && /maxOutputSize/.test(e.message),
  );
  await assert.rejects(decompressZstd(zstd(text, { contentSizeFlag: 0 }), { maxOutputSize: 1000 }), /maxOutputSize/);
  await assert.rejects(decompressZstd(zstd(text), { maxOutputSize: -1 }), RangeError);
});

test('a frame that needs a dictionary throws MargoError unsupported', async () => {
  // magic, descriptor (dictionary id in 1 byte, window descriptor present), window 1 KiB, dictionary 7, last raw block.
  const frame = Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0x01, 0x00, 0x07, 0x01, 0x00, 0x00);
  await assert.rejects(
    decompressZstd(frame),
    (e) => e.name === 'MargoError' && e.code === 'unsupported' && /dictionar/.test(e.message),
  );
  // Dictionary id 0 means none, so the same frame with id 0 decodes to nothing.
  const none = frame.slice();
  none[6] = 0;
  assert.equal((await decompressZstd(none)).length, 0);
});

test('an AbortSignal stops decoding, before it starts and while it runs', { skip }, async () => {
  const packed = zstd(new Uint8Array(64 << 20));
  await assert.rejects(decompressZstd(packed, { signal: AbortSignal.abort(new Error('stop')) }), /stop/);
  const controller = new AbortController(),
    running = decompressZstd(packed, { signal: controller.signal });
  controller.abort(new Error('later'));
  await assert.rejects(running, /later/);
});

test('decodes the six Zstandard streams of the SPZ version 4 fixture to their declared sizes', async () => {
  const file = fixture('raccoon-v4.spz'),
    view = new DataView(file.buffer, file.byteOffset, file.byteLength),
    streams = file[15];
  let at = 32 + streams * 16;
  for (let i = 0; i < streams; i++) {
    const compressed = view.getUint32(32 + i * 16, true),
      size = view.getUint32(40 + i * 16, true),
      out = await decompressZstd(file.subarray(at, at + compressed));
    assert.equal(out.length, size, `stream ${i}`);
    if (hasZstd) assert.ok(Buffer.from(out).equals(zlib.zstdDecompressSync(file.subarray(at, at + compressed))));
    at += compressed;
  }
  assert.equal(at, file.length);
});
