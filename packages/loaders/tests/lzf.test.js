import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decompressLZF, LoaderError } from '../dist/index.js';
import { lzfCompress } from './lzf-compress.js';

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);
const vectors = JSON.parse(readFileSync(fixture('lzf-vectors.json'), 'utf8'));
const hex = (s) => Uint8Array.from(Buffer.from(s, 'hex'));
const toHex = (bytes) => Buffer.from(bytes).toString('hex');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// The "farthest distance" case is described rather than listed: 256 literal runs of 32 bytes, then one reference.
function farthestInput() {
  const out = [];
  for (let k = 0; k < 256; k++) {
    out.push(31);
    for (let i = 0; i < 32; i++) out.push((7 * i + 13 * k) & 255);
  }
  // Length field 3 (5 bytes), distance 8192: low 5 bits 31, offset byte 255.
  out.push((3 << 5) | 31, 255);
  return Uint8Array.from(out);
}

function expectError(fn, expected) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof LoaderError);
    assert.equal(error.name, expected.name);
    assert.equal(error.code, expected.code);
    assert.equal(error.message, expected.message);
    return true;
  });
}

test('LZF: decodes the hand-assembled format vectors byte for byte, with the documented errors', () => {
  for (const c of vectors.cases) {
    const input = c.input === undefined ? farthestInput() : hex(c.input);
    const run = () => decompressLZF(input, c.outputLength);
    if (c.result.name) {
      expectError(run, c.result);
      continue;
    }
    const output = run();
    assert.ok(output instanceof Uint8Array, c.name);
    if (c.result.output !== undefined) assert.equal(toHex(output), c.result.output, c.name);
    else {
      assert.equal(output.length, c.result.length, c.name);
      assert.equal(sha256(output), c.result.sha256, c.name);
    }
  }
  expectError(() => decompressLZF(hex('0001'), 4, 'PCD'), vectors.formatArgument.result);
  expectError(() => decompressLZF(new Uint8Array(0), Number.NaN), {
    name: 'LoaderError',
    code: 'range',
    message: 'LZF: invalid LZF output length NaN',
  });
});

test('LZF: decodes the real PCL binary_compressed body', () => {
  const f = vectors.fixture;
  const bytes = readFileSync(new URL(`../../../${f.path}`, import.meta.url));
  // bodyOffset is where the LZF data starts, after PCD's two uint32 sizes.
  const view = new DataView(bytes.buffer, bytes.byteOffset + f.bodyOffset - 8, 8);
  assert.equal(view.getUint32(0, true), f.compressedSize);
  assert.equal(view.getUint32(4, true), f.uncompressedSize);
  const body = bytes.subarray(f.bodyOffset, f.bodyOffset + f.compressedSize);
  const out = decompressLZF(body, f.uncompressedSize, 'PCD');
  assert.equal(out.length, f.uncompressedSize);
  assert.equal(sha256(out), f.outputSha256);
  assert.equal(toHex(out.subarray(0, 16)), f.first16);
  assert.equal(toHex(out.subarray(out.length - 16)), f.last16);
});

test('LZF: the test compressor round trips literals, short and long references and far distances', () => {
  let seed = 12345;
  const random = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed >>> 24;
  };
  const far = new Uint8Array(20000);
  for (let i = 0; i < 8000; i++) far[i] = random();
  far.set(far.subarray(0, 300), 8150); // 8150 back: within the window, longer than one match
  for (let i = 8450; i < far.length; i++) far[i] = random() & 3;
  const samples = [
    new Uint8Array(0),
    Uint8Array.of(1),
    Uint8Array.of(1, 2),
    new Uint8Array(1000).fill(9),
    Uint8Array.from({ length: 5000 }, (_, i) => (i * 31) % 7),
    Uint8Array.from({ length: 4096 }, random),
    far,
    new Uint8Array(readFileSync(fixture('simple.pcd'))),
  ];
  const kinds = { literal: 0, short: 0, long: 0 };
  for (const input of samples) {
    const packed = lzfCompress(input);
    assert.deepEqual(decompressLZF(packed, input.length), input);
    for (let i = 0; i < packed.length; ) {
      const c = packed[i];
      if (c < 32) {
        kinds.literal++;
        i += c + 2;
      } else if (c >> 5 === 7) {
        kinds.long++;
        i += 3;
      } else {
        kinds.short++;
        i += 2;
      }
    }
  }
  assert.ok(kinds.literal > 0 && kinds.short > 0 && kinds.long > 0, JSON.stringify(kinds));
  assert.ok(lzfCompress(new Uint8Array(1000).fill(9)).length < 20);
});

test('LZF: corrupt streams throw LoaderError, never read or write out of bounds', () => {
  const packed = lzfCompress(Uint8Array.from({ length: 3000 }, (_, i) => (i * 7) % 13));
  for (let cut = 0; cut < packed.length; cut += 37)
    assert.throws(() => decompressLZF(packed.subarray(0, cut), 3000), LoaderError);
  assert.throws(() => decompressLZF(packed, 2999), LoaderError);
  assert.throws(() => decompressLZF(packed, 3001), LoaderError);
  let seed = 7;
  for (let round = 0; round < 500; round++) {
    const junk = Uint8Array.from({ length: 1 + (round % 40) }, () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed >>> 24;
    });
    try {
      const out = decompressLZF(junk, round % 64);
      assert.equal(out.length, round % 64);
    } catch (error) {
      assert.ok(error instanceof LoaderError);
      assert.ok(error.code === 'range' || error.code === 'truncated');
    }
  }
});
