// LZ4 / TfFastCompression and Crate integer coding, checked on the private decoders in src/crate.ts against the
// binding vectors in fixtures/lz4-usd.json and fixtures/usd-intcoding.json, plus round trips from first principles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { lz4 } from './crate-writer.js';

const repo = new URL('../../../', import.meta.url),
  source = readFileSync(new URL('../src/crate.ts', import.meta.url), 'utf8'),
  loaders = new URL('../../loaders/dist/common.js', import.meta.url).href,
  js = `${stripTypeScriptTypes(source.replace("'@margoengine/loaders/common'", JSON.stringify(loaders)))}\nexport { decompressFast, lz4Block, decodeInts };\n`,
  { decompressFast, decodeInts } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const vectors = (name) => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8')),
  lz = vectors('lz4-usd.json'),
  ic = vectors('usd-intcoding.json');
const hex = (s) => new Uint8Array(Buffer.from(s, 'hex')),
  sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const outcome = (run) => {
  try {
    return { ok: run() };
  } catch (error) {
    return { error };
  }
};
const expect = (result, expected, name) => {
  if (expected.name) {
    assert.ok(result.error, `${name}: expected an error`);
    assert.equal(result.error.name, expected.name, name);
    assert.equal(result.error.message, expected.message, name);
    return;
  }
  assert.ok(!result.error, `${name}: ${result.error?.message}`);
  if (expected.output !== undefined) assert.equal(Buffer.from(result.ok).toString('hex'), expected.output, name);
  if (expected.length !== undefined) assert.equal(result.ok.length, expected.length, name);
  if (expected.sha256) assert.equal(sha(result.ok), expected.sha256, name);
  if (expected.values) assert.deepEqual(result.ok, expected.values, name);
};

test('TfFastCompression round trips decode byte exact', () => {
  assert.equal(lz.roundTrips.length, 7);
  for (const v of lz.roundTrips) {
    const framed = new Uint8Array(Buffer.from(v.framed, 'base64'));
    assert.equal(framed.length, v.framedLength, v.name);
    const out = decompressFast(framed, v.max);
    assert.equal(out.length, v.expectedLength, v.name);
    assert.equal(sha(out), v.expectedSha256, v.name);
  }
});

test('LZ4 hand cases: extensions, overlaps, chunks, leniencies and every error', () => {
  assert.equal(lz.handCases.length, 27);
  for (const v of lz.handCases)
    expect(
      outcome(() => decompressFast(hex(v.input), v.max)),
      v.result,
      v.name,
    );
  expect(
    outcome(() => decompressFast(hex(lz.cap.input), lz.cap.max)),
    lz.cap.result,
    lz.cap.name,
  );
});

test('LZ4 output buffer is capped at src.length * 255 + 64 whatever max claims', () => {
  // A max of 2^40 bytes could never be allocated; the cap keeps the buffer to what 20 input bytes can produce.
  const out = decompressFast(hex(lz.cap.input), 2 ** 40);
  assert.equal(out.length, lz.cap.result.length);
  assert.ok(out.buffer.byteLength <= hex(lz.cap.input).length * 255 + 64);
});

test('TOKENS section of the OpenUSD triangle fixture', () => {
  const f = lz.fixture,
    file = new Uint8Array(readFileSync(new URL(f.path, repo))),
    packed = file.subarray(f.packedOffset, f.packedOffset + f.packedSize);
  assert.equal(packed[0], f.chunkCountByte);
  const out = decompressFast(packed, f.rawSize);
  assert.equal(out.length, f.outputLength);
  assert.equal(sha(out), f.outputSha256);
  assert.deepEqual(new TextDecoder().decode(out).split('\0').slice(0, f.tokenCount), f.tokens);
});

test('LZ4 decodes what the test writer encodes', () => {
  let seed = 7;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed >>> 24;
  };
  const inputs = [
    Buffer.alloc(0),
    Buffer.from('abcabcabcabcabcabcabcabc-tail-data'),
    Buffer.from('points normals faceVertexCounts faceVertexIndices '.repeat(40)),
    Buffer.alloc(70000, 9),
    Buffer.from(Array.from({ length: 5000 }, (_, i) => (i % 97 < 50 ? noise() : i & 7))),
  ];
  for (const raw of inputs) {
    const framed = new Uint8Array(Buffer.concat([Buffer.from([0]), lz4(raw)]));
    assert.deepEqual(Buffer.from(decompressFast(framed, raw.length)), raw);
  }
});

test('integer coding: every stream in the repository .usdc files', () => {
  assert.equal(ic.fixtures.length, 3);
  for (const file of ic.fixtures) {
    assert.equal(file.streams.length, 8, file.path);
    for (const [i, s] of file.streams.entries())
      assert.deepEqual(decodeInts(hex(s.decoded), s.count, s.wide), s.values, `${file.path} stream ${i}`);
  }
});

test('integer coding: hand streams and error cases', () => {
  assert.equal(ic.hand.length, 7);
  for (const v of [...ic.hand, ...ic.errors])
    expect(
      outcome(() => decodeInts(hex(v.input), v.count, v.wide)),
      v.result,
      v.name,
    );
});

test('integer coding: encode then decode random sequences (narrow and wide)', () => {
  // Encoder from the format description: deltas, the most frequent as the common value, the smallest code that fits.
  const encode = (values, wide) => {
    const width = wide ? 8 : 4,
      deltas = values.map((v, i) => (wide ? v - (values[i - 1] ?? 0) : (v - (values[i - 1] ?? 0)) | 0)),
      counts = new Map();
    for (const d of deltas) counts.set(d, (counts.get(d) ?? 0) + 1);
    const common = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0,
      head = Buffer.alloc(width),
      codes = Buffer.alloc((values.length * 2 + 7) >> 3),
      parts = [];
    if (wide) head.writeBigInt64LE(BigInt(common));
    else head.writeInt32LE(common);
    deltas.forEach((d, i) => {
      let code = 0;
      if (d !== common)
        for (code = 1; code < 3; code++) {
          const bits = (width >> (3 - code)) * 8;
          if (d >= -(2 ** (bits - 1)) && d < 2 ** (bits - 1)) break;
        }
      codes[i >> 2] |= code << ((i & 3) * 2);
      if (code) {
        const bytes = width >> (3 - code),
          b = Buffer.alloc(bytes);
        if (bytes === 8) b.writeBigInt64LE(BigInt(d));
        else b.writeIntLE(d, 0, bytes);
        parts.push(b);
      }
    });
    return new Uint8Array(Buffer.concat([head, codes, ...parts]));
  };
  let seed = 3;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  for (let trial = 0; trial < 60; trial++) {
    const wide = trial % 2 === 1,
      span = [10, 1000, 2 ** 20, wide ? 2 ** 40 : 2 ** 31][trial % 4],
      values = Array.from({ length: Math.floor(rand() * 40) }, (_, i) =>
        rand() < 0.4 ? i * 3 : Math.floor((rand() - 0.5) * span),
      );
    assert.deepEqual(decodeInts(encode(values, wide), values.length, wide), values, `trial ${trial}`);
  }
});
