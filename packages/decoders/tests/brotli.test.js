import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { brotliCompressSync, constants } from 'node:zlib';
import { decodeBrotli } from '../dist/brotli.js';

const { BROTLI_PARAM_LGWIN, BROTLI_PARAM_MODE, BROTLI_PARAM_QUALITY, BROTLI_PARAM_SIZE_HINT, BROTLI_MODE_TEXT, BROTLI_MODE_FONT } =
  constants;
const pack = (data, quality = 11, lgwin = 22, mode = 0) =>
  brotliCompressSync(data, {
    params: {
      [BROTLI_PARAM_QUALITY]: quality,
      [BROTLI_PARAM_LGWIN]: lgwin,
      [BROTLI_PARAM_MODE]: mode,
      [BROTLI_PARAM_SIZE_HINT]: data.length,
    },
  });
const same = (data, packed, note) =>
  assert.equal(
    createHash('sha1').update(decodeBrotli(packed)).digest('hex'),
    createHash('sha1').update(data).digest('hex'),
    note,
  );

const source = readFileSync(new URL('../src/brotli.ts', import.meta.url));
const english = Buffer.from(
  `The following list of words reaches the static dictionary through its transforms: the time of day, and the people
  of the world; Information about <a href="http://example.com/">the page</a> in the United States, THE GOVERNMENT, Which
  one? function(){ return document.getElementById('content'); } <div class="container"><span style="color: red">
  Copyright, All Rights Reserved. Español: información, también. Русский текст. 日本語のテキスト。العربية`.repeat(3),
);
function ints(n) {
  const out = new Int32Array(n);
  for (let i = 0, v = 0; i < n; i++) out[i] = v += ((i * 2654435761) >>> 28) - 7;
  return Buffer.from(out.buffer);
}

test('reads what the reference encoder writes at every quality', () => {
  for (const [name, data] of Object.entries({ english, source, ints: ints(40000), noise: randomBytes(70000) }))
    for (let quality = 0; quality <= 11; quality++) same(data, pack(data, quality), `${name} at quality ${quality}`);
});

test('every window size and mode', () => {
  const data = Buffer.concat([source, ints(5000), source]);
  for (let lgwin = 10; lgwin <= 24; lgwin++) same(data, pack(data, 9, lgwin), `window ${lgwin}`);
  for (const mode of [BROTLI_MODE_TEXT, BROTLI_MODE_FONT]) same(data, pack(data, 11, 22, mode), `mode ${mode}`);
});

test('small inputs, runs, and streams of many blocks', () => {
  for (const data of [Buffer.alloc(0), Buffer.from('a'), Buffer.from('time'), Buffer.alloc(100000, 7)]) same(data, pack(data));
  const big = Buffer.concat(Array.from({ length: 12 }, (_, i) => (i % 2 ? randomBytes(200000) : ints(50000))));
  same(big, pack(big, 5, 18), 'mixed metablocks and stored blocks');
});

test('a corrupt or short stream throws a coded error, never hangs or reads out of bounds', () => {
  const packed = pack(english, 11),
    failed = (e) => e.name === 'MargoError' && e.code === 'failed';
  for (const cut of [1, 2, 10, packed.length >> 1, packed.length - 1])
    assert.throws(() => decodeBrotli(packed.subarray(0, cut)), failed, `cut at ${cut}`);
  let seed = 5;
  for (let trial = 0; trial < 300; trial++) {
    const bad = Uint8Array.from(packed);
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    bad[seed % bad.length] ^= 1 << (seed >> 8) % 8;
    try {
      decodeBrotli(bad);
    } catch (e) {
      assert.ok(failed(e), `trial ${trial}: ${e}`);
    }
  }
});

test('maxBytes stops a stream that expands past it', () => {
  const packed = pack(Buffer.alloc(1 << 22));
  assert.ok(packed.length < 100);
  assert.throws(
    () => decodeBrotli(packed, { maxBytes: 1 << 20 }),
    (e) => e.code === 'failed' && /maxBytes/.test(e.message),
  );
  assert.equal(decodeBrotli(packed, { maxBytes: 1 << 22 }).length, 1 << 22);
});
