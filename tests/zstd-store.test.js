// scripts/support/zstd-store.mjs stands in for zlib.zstdCompressSync on Node 22.12, where 13 tests of the decoders and
// splats packages were skipped for want of an encoder (KB-NODE22-TESTS1, 2026-11-26). Its frames must be valid
// Zstandard (RFC 8878): Node's own decoder reads them wherever node:zlib has one, and the engine's decoder everywhere.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as zlib from 'node:zlib';
import { decompressZstd, decompressZstdSync } from '../packages/shared/zstd.js';
import { ZSTD_PARAMS, xxh64, zstdStoreSync } from '../scripts/support/zstd-store.mjs';

const { ZSTD_c_checksumFlag: CHECKSUM, ZSTD_c_contentSizeFlag: SIZED, ZSTD_c_windowLog: WINDOW } = ZSTD_PARAMS,
  KIB128 = 1 << 17;
/** Deterministic bytes that are not all alike, so a block put in the wrong place shows. */
const sample = (length) => Buffer.alloc(length).map((_, i) => (i * 31 + (i >>> 7)) & 255);

/** The frame's blocks as { type, size, last }, walked from the end of the frame header at `at`. */
function blocks(frame, at, checksum) {
  const out = [];
  for (;;) {
    const header = frame.readUIntLE(at, 3),
      block = { last: header & 1, type: (header >> 1) & 3, size: header >> 3 };
    out.push(block);
    at += 3 + block.size;
    if (block.last) break;
  }
  assert.equal(at + (checksum ? 4 : 0), frame.length, 'the frame ends after its last block and checksum');
  return out;
}

test('stored frames decode to their input in Node and in the engine, from empty to several blocks', async () => {
  const sizes = [0, 1, 255, 256, 65_791, 65_792, KIB128 - 1, KIB128, KIB128 + 1, 2 * KIB128, 400_000, 1_000_003],
    settings = [
      {},
      { [CHECKSUM]: 1 },
      { [SIZED]: 0 },
      { [SIZED]: 0, [CHECKSUM]: 1 },
      { [WINDOW]: 10, [SIZED]: 0, [CHECKSUM]: 1 },
      { [WINDOW]: 20, [CHECKSUM]: 1 },
      { [WINDOW]: 12 },
      { [ZSTD_PARAMS.ZSTD_c_compressionLevel]: 19 },
    ];
  for (const length of sizes)
    for (const params of settings) {
      const input = sample(length),
        frame = zstdStoreSync(input, { params }),
        what = `${length} bytes ${JSON.stringify(params)}`;
      if (zlib.zstdDecompressSync) assert.ok(zlib.zstdDecompressSync(frame).equals(input), `Node: ${what}`);
      assert.ok(Buffer.from(decompressZstdSync(frame)).equals(input), `engine: ${what}`);
      assert.ok(Buffer.from(await decompressZstd(frame)).equals(input), `engine, async: ${what}`);
    }
});

test('the frame layout: magic, header, raw blocks of at most 128 KiB with the last one flagged', () => {
  assert.deepEqual([...zstdStoreSync(new Uint8Array(0))], [0x28, 0xb5, 0x2f, 0xfd, 0x20, 0, 1, 0, 0]);
  assert.deepEqual([...zstdStoreSync('abc')], [0x28, 0xb5, 0x2f, 0xfd, 0x20, 3, 0x19, 0, 0, 97, 98, 99]);
  // Single segment: the content size takes 1, 2 (size - 256) or 4 bytes; the blocks start after it.
  for (const [length, field, expected] of [
    [KIB128, 4, [KIB128]],
    [KIB128 + 1, 4, [KIB128, 1]],
    [400_000, 4, [KIB128, KIB128, KIB128, 400_000 - 3 * KIB128]],
    [300, 2, [300]],
  ]) {
    const frame = zstdStoreSync(sample(length));
    assert.equal(frame[4], ((field === 4 ? 2 : 1) << 6) | 0x20, `${length}: descriptor`);
    assert.equal(field === 4 ? frame.readUInt32LE(5) : frame.readUInt16LE(5) + 256, length);
    const found = blocks(frame, 5 + field, false);
    assert.deepEqual(
      found.map((block) => block.size),
      expected,
    );
    assert.ok(found.every((block, i) => block.type === 0 && block.last === Number(i === found.length - 1)));
  }
  // No content size: a window descriptor instead (default 128 KiB), and a 1 KiB window holds 1 KiB blocks.
  const unsized = zstdStoreSync(sample(KIB128 + 5), { params: { [SIZED]: 0, [CHECKSUM]: 1 } });
  assert.deepEqual([unsized[4], unsized[5]], [4, (17 - 10) << 3]);
  assert.deepEqual(
    blocks(unsized, 6, true).map((block) => block.size),
    [KIB128, 5],
  );
  const narrow = zstdStoreSync(sample(2500), { params: { [WINDOW]: 10 } });
  assert.deepEqual([narrow[4], narrow[5], narrow.readUInt32LE(6)], [0x80, 0, 2500]);
  assert.deepEqual(
    blocks(narrow, 10, false).map((block) => block.size),
    [1024, 1024, 452],
  );
});

test('the content checksum is the low half of XXH64, and a damaged frame is refused', () => {
  // The xxHash specification's own values for seed 0.
  assert.equal(xxh64(new Uint8Array(0)), 0xef46db3751d8e999n);
  assert.equal(xxh64(Buffer.from('abc')), 0x44bc2cf5ad770999n);
  const input = sample(70_001),
    frame = zstdStoreSync(input, { params: { [CHECKSUM]: 1 } });
  assert.equal(frame.readUInt32LE(frame.length - 4), Number(xxh64(input) & 0xffffffffn));
  frame[100] ^= 1;
  assert.throws(() => decompressZstdSync(frame), /checksum/);
  if (zlib.zstdDecompressSync) assert.throws(() => zlib.zstdDecompressSync(frame));
});

test('parameters: zstd numbers, and anything the writer cannot honour is refused', () => {
  if (zlib.zstdCompressSync)
    for (const [name, value] of Object.entries(ZSTD_PARAMS)) assert.equal(zlib.constants[name], value, name);
  assert.throws(() => zstdStoreSync(sample(4), { params: { 202: 1 } }), TypeError);
  assert.throws(() => zstdStoreSync(sample(4), { params: { [WINDOW]: 9 } }), RangeError);
  assert.throws(() => zstdStoreSync(12), TypeError);
});

// Tests of Huffman, FSE and match decoding read streams Node compressed once (zstdFixture). On a Node with Zstandard
// the helper compresses again and refuses a missing file or one that no longer decodes to the test's input; on one
// without (here: the stand-ins forced) it returns the checked-in file.
test('zstdFixture regenerates a stream where Node can, checks the checked-in file, and reads it elsewhere', () => {
  const folder = mkdtempSync(join(tmpdir(), 'margo-zstd-fixture-')),
    file = pathToFileURL(join(folder, 'text.zst')),
    script = `
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      import { zstdDecompressSync, zstdFixture } from './scripts/support/node-compat.mjs';
      const url = new URL(process.argv[1]), step = process.argv[2];
      const text = Buffer.from('Zstandard fixture '.repeat(500)), parts = [text, Buffer.alloc(0), text.subarray(7)];
      if (step === 'missing') assert.throws(() => zstdFixture(url, parts), /is missing/);
      else if (step === 'stale') assert.throws(() => zstdFixture(url, parts), /no longer decodes/);
      else {
        const frame = zstdFixture(url, parts);
        assert.ok(Buffer.from(zstdDecompressSync(frame)).equals(Buffer.concat(parts)));
        assert.ok(frame.length < 500, 'compressed blocks, not stored ones');
        if (step === 'read') assert.ok(frame.equals(readFileSync(url)), 'the checked-in file itself');
      }
      console.log('ok');
    `;
  const run = (step, env = {}) =>
    execFileSync(process.execPath, ['--input-type=module', '-e', script, file.href, step], {
      cwd: resolve(import.meta.dirname, '..'),
      env: { ...process.env, MARGO_ZSTD_FIXTURES: '', MARGO_NODE_COMPAT: '', ...env },
      encoding: 'utf8',
      timeout: 60_000,
    }).trim();
  try {
    if (zlib.zstdCompressSync) {
      assert.equal(run('missing'), 'ok');
      assert.equal(run('write', { MARGO_ZSTD_FIXTURES: 'write' }), 'ok');
      assert.equal(run('check'), 'ok');
      const made = readFileSync(file);
      writeFileSync(file, zlib.zstdCompressSync(Buffer.from('something else')));
      assert.equal(run('stale'), 'ok');
      writeFileSync(file, made);
    } else {
      // No Zstandard in this Node: the three frames as Node 26.13 compressed them.
      writeFileSync(file, Buffer.from(MADE, 'base64'));
    }
    assert.equal(run('read', { MARGO_NODE_COMPAT: 'fallback' }), 'ok');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

const MADE =
  'KLUv/WAoItUAAJBac3RhbmRhcmQgZml4dHVyZSABACZG8TMMKLUv/SAAAQAAKLUv/WAhItUAAJByZCBmaXh0dXJlIFpzdGFuZGEBABhG8TMM';
