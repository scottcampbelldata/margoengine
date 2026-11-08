// SPZ and SOG writers (@margoengine/splats/data) against real captures: a decode of each writer's file matches the
// cloud up to the format's quantisation, and re-encoding a real SPZ version 3 file gives back its bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { encodeSog, encodeSpz, encodeSplat, parsePly, parseSog, parseSpz } from '../dist/data.js';
import { encodeWebpLossless } from '../src/webp.ts';
import { decodeWebpLossless } from '@margoengine/decoders/webp-lossless';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

/** Largest absolute difference per attribute between two clouds in the same order. */
function difference(a, b) {
  assert.equal(a.positions.length, b.positions.length, 'splat count');
  const out = {};
  for (const key of ['positions', 'covariances', 'colors', 'sphericalHarmonics']) {
    assert.equal(a[key]?.length, b[key]?.length, `${key} length`);
    let max = 0;
    for (let i = 0; i < (a[key]?.length ?? 0); i++) max = Math.max(max, Math.abs(a[key][i] - b[key][i]));
    out[key] = max;
  }
  return out;
}

test('encodeWebpLossless writes files the WebP decoder reads back exactly', () => {
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) / 2 ** 24;
  for (const [w, h, fill] of [
    [1, 1, () => random() * 256],
    [37, 11, () => random() * 256],
    [64, 64, () => -Math.log(random() + 1e-9) * 6],
    [9, 9, () => 42],
    [16, 3, (i) => (i % 3 ? 7 : 200)],
  ]) {
    const pixels = Uint8Array.from({ length: w * h * 4 }, (_, i) => Math.min(255, fill(i))),
      image = decodeWebpLossless(encodeWebpLossless(pixels, w, h));
    assert.deepEqual([image.width, image.height], [w, h]);
    assert.deepEqual(image.data, pixels, `${w} x ${h}`);
  }
  assert.throws(() => encodeWebpLossless(new Uint8Array(4), 0, 1), RangeError);
  assert.throws(() => encodeWebpLossless(new Uint8Array(3), 1, 1), RangeError);
});

test('encodeSpz of a real capture decodes to the cloud within the format steps', async () => {
  const cloud = parsePly(fixture('raccoon-v2.ply')),
    bytes = await encodeSpz(cloud),
    back = await parseSpz(bytes),
    d = difference(cloud, back);
  // Positions: the cloud's coordinates fit 16 fractional bits (half a step 7.6e-6); colours and opacity one byte.
  assert.ok(d.positions <= 2 ** -17 + 1e-7, `positions ${d.positions}`);
  assert.ok(d.colors < 0.02, `colours ${d.colors}`);
  assert.equal(back.sphericalHarmonics.length, cloud.sphericalHarmonics.length, 'SH degree kept');
  assert.equal(bytes[0], 0x1f, 'a gzip stream');
  // The capture's own SPZ export of the same cloud is the size to match (degree 3 SH dominate both).
  const reference = fixture('raccoon-v3.spz').length;
  assert.ok(bytes.length < reference * 1.1, `${bytes.length} bytes against the reference export's ${reference}`);
  assert.ok(bytes.length < fixture('raccoon-v2.ply').length / 5, 'a fifth of the PLY at most');
});

test('re-encoding a real SPZ version 3 file gives back its quantised attributes', async () => {
  const file = fixture('raccoon-v3.spz'),
    original = gunzipSync(file),
    bits = original[13],
    again = gunzipSync(
      await encodeSpz(await parseSpz(file), { fractionalBits: bits, antialiased: (original[14] & 1) === 1 }),
    ),
    n = new DataView(original.buffer, original.byteOffset).getUint32(8, true),
    rest = (original.length - 16 - n * 20) / n;
  assert.equal(again.length, original.length, 'same layout');
  assert.deepEqual(again.subarray(0, 16), original.subarray(0, 16), 'same header');
  const off = (from, length) => {
    let worst = 0;
    for (let i = from; i < from + length; i++) worst = Math.max(worst, Math.abs(again[i] - original[i]));
    return worst;
  };
  const at = 16 + n * 9;
  assert.equal(off(16, n * 9), 0, 'positions');
  assert.equal(off(at, n), 0, 'opacity');
  // Colours: SplatData holds display colours in 0..1, so a byte whose display value 0.5 + C0 * dc lies outside 0..1
  // comes back clamped; every other colour byte matches within one step.
  let colourWorst = 0,
    clamped = 0;
  for (let i = at + n; i < at + n * 4; i++) {
    const display = 0.5 + 0.2820947918 * ((original[i] / 255 - 0.5) / 0.15);
    if (display < 0 || display > 1) clamped++;
    else colourWorst = Math.max(colourWorst, Math.abs(again[i] - original[i]));
  }
  assert.ok(colourWorst <= 1, `colours within one step: ${colourWorst}`);
  assert.ok(clamped < n * 3 * 0.2, `clamped colour bytes ${clamped}`);
  // Log scales: the eigen-decomposition may name the axes in another order (the rotation follows, so the Gaussian is
  // the same), so each splat's three scale bytes are compared sorted.
  let scaleWorst = 0;
  for (let i = 0; i < n; i++) {
    const p = at + n * 4 + i * 3,
      x = [...original.subarray(p, p + 3)].sort((a, b) => a - b),
      y = [...again.subarray(p, p + 3)].sort((a, b) => a - b);
    for (let k = 0; k < 3; k++) scaleWorst = Math.max(scaleWorst, Math.abs(x[k] - y[k]));
  }
  assert.ok(scaleWorst <= 1, `log scales within one step: ${scaleWorst}`);
  assert.ok(off(at + n * 11, n * rest) <= 1, `SH within one step: ${off(at + n * 11, n * rest)}`);
  // Rotations: the same quaternion within the 10-bit step, whichever sign it is stored with.
  const a = await parseSpz(file),
    b = await parseSpz(await encodeSpz(a, { fractionalBits: bits }));
  assert.ok(difference(a, b).covariances < 1e-3, `covariances ${difference(a, b).covariances}`);
});

test('encodeSog of a real capture decodes to the cloud within its codebooks', async () => {
  const cloud = await parseSog(fixture('raccoon.sog')),
    bytes = await encodeSog(cloud),
    back = await parseSog(bytes),
    d = difference(cloud, back);
  assert.equal(bytes[0], 0x50, 'a ZIP archive');
  assert.ok(d.positions < 2e-3, `positions ${d.positions}`);
  assert.ok(d.colors < 0.03, `colours ${d.colors}`);
  assert.ok(d.sphericalHarmonics < 0.08, `SH ${d.sphericalHarmonics}`);
  // The capture again through SOG gives the same cloud: the codebooks settle on the values the file holds.
  const twice = difference(back, await parseSog(await encodeSog(back)));
  assert.ok(twice.colors <= d.colors + 1e-6, 'a second pass loses no more');
  const sizes = {
    ply: fixture('raccoon-v2.ply').length,
    splat: encodeSplat(cloud).length,
    sog: bytes.length,
    spz: (await encodeSpz(cloud)).length,
  };
  assert.ok(sizes.sog < sizes.splat && sizes.spz < sizes.splat, JSON.stringify(sizes));
});

test('encodeSog groups the SH bands of more than 65,536 splats into a palette', async () => {
  const n = 70000,
    data = {
      positions: new Float32Array(n * 3),
      covariances: new Float32Array(n * 6),
      colors: new Float32Array(n * 4),
      sphericalHarmonics: new Float32Array(n * 12),
    };
  for (let i = 0; i < n; i++) {
    data.positions.set([(i % 300) * 0.01, Math.floor(i / 300) * 0.01, 0], i * 3);
    data.covariances.set([1e-4, 0, 0, 1e-4, 0, 1e-4], i * 6);
    data.colors.set([0.5, 0.5, 0.5, 1], i * 4);
    // A band-1 term that grows along the cloud, so neighbours in the palette order hold nearby values.
    for (let k = 3; k < 12; k++) data.sphericalHarmonics[i * 12 + k] = (i / n - 0.5) * 0.4;
    data.sphericalHarmonics.set([0, 0, 0], i * 12);
  }
  const back = await parseSog(await encodeSog(data));
  let worst = 0;
  for (let i = 0; i < n; i++)
    worst = Math.max(worst, Math.abs(back.sphericalHarmonics[i * 12 + 5] - data.sphericalHarmonics[i * 12 + 5]));
  assert.ok(worst < 0.01, `palette error ${worst}`);
});

test('encodeSpz checks its fixed point', async () => {
  const one = {
    positions: new Float32Array([5000, 0, 0]),
    covariances: new Float32Array([1, 0, 0, 1, 0, 1]),
    colors: new Float32Array([1, 1, 1, 1]),
  };
  await assert.rejects(encodeSpz(one, { fractionalBits: 12 }), RangeError, '5,000 does not fit 12 bits');
  await assert.rejects(encodeSpz(one, { fractionalBits: 24 }), RangeError);
  assert.equal(new Uint8Array(gunzipSync(await encodeSpz(one)))[13], 10, 'the most bits that fit');
});
