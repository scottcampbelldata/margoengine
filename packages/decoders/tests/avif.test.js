import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { AVIFDecoder, decodeAVIF } from '../dist/avif.js';
import { decodeImage } from '../dist/image.js';

const fixture = async (name = 'fox.profile0.8bpc.yuv420.avif') =>
  new Uint8Array(await readFile(new URL(`../native/avif/tests/fixtures/${name}`, import.meta.url)));
const hash = (data) =>
  createHash('sha256')
    .update(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    .digest('hex');

test('AVIF browser-independent Node workers preserve source precision, transfer and restart', {
  timeout: 60000,
}, async () => {
  const decoder = new AVIFDecoder({ workerLimit: 2, timeout: 30000 });
  try {
    const bytes = await fixture();
    const original = hash(bytes);
    const [a, b, c] = await Promise.all([
      decoder.decode(bytes),
      decoder.decode(bytes),
      decoder.decode(bytes, { format: 'rgba16' }),
    ]);
    assert.deepEqual([a.width, a.height, a.bitDepth], [1204, 800, 8]);
    assert.equal(hash(a.data), hash(b.data));
    assert.equal(hash(bytes), original);
    assert.ok(c.data instanceof Uint16Array);
    assert.deepEqual(
      a.data,
      Uint8Array.from(c.data, (v) => Math.round(v / 257)),
    );
    const transferred = bytes.slice().buffer;
    assert.equal(hash((await decoder.decode(transferred, { transfer: true })).data), hash(a.data));
    assert.equal(transferred.byteLength, 0);
    decoder.dispose();
    assert.equal(hash((await decoder.decode(bytes)).data), hash(a.data));
    const mono = await decoder.decode(await fixture('fox.profile2.12bpc.yuv420.monochrome.odd-width.odd-height.avif'), {
      format: 'rgba16',
    });
    assert.deepEqual([mono.width, mono.height, mono.bitDepth], [1203, 799, 12]);
    assert.ok(mono.color.monochrome);
    assert.ok(
      mono.data.some((v, i) => i % 4 !== 3 && v % 257 !== 0),
      'retain more than eight bits',
    );
    assert.deepEqual((await decodeImage(bytes)).data, a.data);
  } finally {
    decoder.dispose();
  }
});

test('AVIF budgets, malformed input, pre-abort, active abort, watchdog and disposal reject', {
  timeout: 60000,
}, async () => {
  const bytes = await fixture();
  const decoder = new AVIFDecoder({ workerLimit: 1 });
  try {
    await assert.rejects(decoder.decode(bytes, { maxPixels: 1 }), /maxPixels|maxMemory/);
    await assert.rejects(decoder.decode(bytes, { maxMemory: 200000 }), /maxPixels|maxMemory/);
    await assert.rejects(decoder.decode(bytes.subarray(0, 100)), /malformed|truncated/);
    await assert.rejects(decoder.decode(bytes, { format: 'rgb' }), TypeError);
    await assert.rejects(decoder.decode(bytes, { maxMemory: Infinity }), RangeError);
    await assert.rejects(
      decoder.decode(bytes, { signal: AbortSignal.abort(new Error('pre-abort proof')) }),
      /pre-abort proof/,
    );
    const controller = new AbortController();
    const active = decoder.decode(bytes, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('active abort proof')), 1);
    await assert.rejects(active, /active abort proof/);
    const pending = decoder.decode(bytes);
    decoder.dispose();
    await assert.rejects(pending, /disposed/);
    assert.equal((await decoder.decode(bytes)).width, 1204);
  } finally {
    decoder.dispose();
  }
  const limited = new AVIFDecoder({ workerLimit: 1, timeout: 1 });
  try {
    await assert.rejects(limited.decode(bytes), /timed out|timeout/i);
  } finally {
    limited.dispose();
  }
  assert.equal((await decodeAVIF(bytes)).height, 800);
});

test('AVIF real grids, alpha, ICC and ordered rational crop/rotate/mirror match independent libavif output', {
  timeout: 60000,
}, async () => {
  const folder = new URL('../native/avif/tests/fixtures/', import.meta.url);
  const references = JSON.parse(await readFile(new URL('container-references.json', folder)));
  const decoder = new AVIFDecoder({ workerLimit: 1 });
  try {
    for (const reference of references) {
      const bytes = await fixture(reference.file);
      assert.equal(hash(bytes), reference.inputSha256);
      const image = await decoder.decode(bytes);
      assert.deepEqual([image.width, image.height], [reference.width, reference.height], reference.file);
      const expected = inflateSync(await readFile(new URL(reference.reference, folder)));
      assert.equal(hash(expected), reference.referenceSha256);
      assert.equal(image.data.length, expected.length);
      for (let i = 0; i < expected.length; i++) {
        const limit = i % 4 === 3 ? 0 : reference.maxRGBDifference;
        assert.ok(
          Math.abs(image.data[i] - expected[i]) <= limit,
          `${reference.file} channel ${i}: ${image.data[i]} versus ${expected[i]}`,
        );
      }
      if (reference.file.startsWith('paris')) assert.equal(image.color.icc.length, 596);
    }
  } finally {
    decoder.dispose();
  }
});
