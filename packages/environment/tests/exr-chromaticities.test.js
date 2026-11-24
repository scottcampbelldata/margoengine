// OpenEXR `chromaticities` (OpenEXR Technical Introduction, standard attributes). Known bug it guards
// (docs/known-bugs.md, fixed 2026-11-11): every decode path skipped the attribute and returned ACEScg (AP1) data as if it
// were Rec.709, so a pixel (1, 0, 0) in AP1 decoded as (1, 0, 0) instead of about (1.705, -0.130, -0.024) in linear sRGB.
import test from 'node:test';
import assert from 'node:assert/strict';
import { primariesToLinearSRGB } from '@margoengine/math/color';
import { parseEXR } from '../dist/index.js';
import { encodeEXR } from '../dist/exr-write.js';
import { parseTiledEXR } from '../dist/exr-tiled.js';
import { decodeEXR } from '../dist/exr-codecs.js';

// ACES AP1 (ACEScg) primaries and white, SMPTE ST 2065-1 / Academy S-2014-004.
const AP1 = [0.713, 0.293, 0.165, 0.83, 0.128, 0.044, 0.32168, 0.33767];
const REC709 = [0.64, 0.33, 0.3, 0.6, 0.15, 0.06, 0.3127, 0.329];
const f32 = (v) => Math.fround(v);
const expected = (rgb, primaries) => {
  const m = primariesToLinearSRGB(primaries.map(f32));
  return [0, 1, 2].map((r) => m[r * 3] * rgb[0] + m[r * 3 + 1] * rgb[1] + m[r * 3 + 2] * rgb[2]);
};
const pixel = (rgb, chromaticities) =>
  encodeEXR({
    width: 1,
    height: 1,
    channels: ['R', 'G', 'B'].map((name, i) => ({ name, type: 'FLOAT', data: new Float32Array([rgb[i]]) })),
    chromaticities,
  });
const close = (actual, wanted, label) =>
  wanted.forEach((v, i) => assert.ok(Math.abs(actual[i] - v) < 1e-5, `${label} ${i}: ${actual[i]} vs ${v}`));

// A one-tile, one-level tiled file (OpenEXR File Layout, "Tiled Chunk Layout"): FLOAT B, G, R and NONE compression.
function tiled(rgb, chromaticities) {
  const out = [];
  const u8 = (...v) => out.push(...v),
    i32 = (...v) => v.forEach((n) => out.push(...new Uint8Array(Int32Array.of(n).buffer))),
    text = (s) => u8(...Buffer.from(s, 'latin1'), 0),
    attribute = (name, type, bytes) => {
      text(name);
      text(type);
      i32(bytes.length);
      u8(...bytes);
    };
  i32(20000630, 2 | 0x200);
  const channel = (name) => [...Buffer.from(name), 0, ...new Uint8Array(Int32Array.of(2, 0, 1, 1).buffer)];
  attribute('channels', 'chlist', [...channel('B'), ...channel('G'), ...channel('R'), 0]);
  if (chromaticities)
    attribute('chromaticities', 'chromaticities', [...new Uint8Array(Float32Array.from(chromaticities).buffer)]);
  attribute('compression', 'compression', [0]);
  const box = [...new Uint8Array(Int32Array.of(0, 0, 0, 0).buffer)];
  attribute('dataWindow', 'box2i', box);
  attribute('displayWindow', 'box2i', box);
  attribute('lineOrder', 'lineOrder', [0]);
  attribute('tiles', 'tiledesc', [...new Uint8Array(Uint32Array.of(1, 1).buffer), 0]);
  u8(0);
  const offset = out.length + 8;
  out.push(...new Uint8Array(new BigUint64Array([BigInt(offset)]).buffer));
  i32(0, 0, 0, 0, 12);
  out.push(...new Uint8Array(Float32Array.of(rgb[2], rgb[1], rgb[0]).buffer));
  return Uint8Array.from(out);
}

test('parseEXR converts AP1 chromaticities to linear sRGB with the Bradford white', async () => {
  const image = parseEXR(await pixel([1, 0, 0], AP1));
  assert.deepEqual(image.primaries, AP1.map(f32));
  assert.equal(image.primariesConverted, true);
  close(image.data, expected([1, 0, 0], AP1), 'AP1 red');
  // The published figure for AP1 red in linear sRGB.
  close(
    Array.from(image.data.subarray(0, 3), (v) => Math.round(v * 1000) / 1000),
    [1.705, -0.13, -0.024],
    'rounded',
  );
  assert.equal(image.data[3], 1);
  // The white stays white.
  close(parseEXR(await pixel([1, 1, 1], AP1)).data, [1, 1, 1].map((v) => v), 'AP1 white');
});

test('a file without chromaticities, or with Rec.709 ones, decodes unchanged', async () => {
  const none = parseEXR(await pixel([0.25, 0.5, 2]));
  assert.equal(none.primaries, null);
  assert.equal(none.primariesConverted, false);
  assert.deepEqual(Array.from(none.data), [0.25, 0.5, 2, 1]);
  const rec = parseEXR(await pixel([0.25, 0.5, 2], REC709));
  assert.equal(rec.primariesConverted, false);
  assert.deepEqual(Array.from(rec.data), [0.25, 0.5, 2, 1]);
});

test('parseTiledEXR converts every level it returns', () => {
  const image = parseTiledEXR(tiled([1, 0, 0], AP1));
  assert.equal(image.primariesConverted, true);
  close(image.data, expected([1, 0, 0], AP1), 'tiled');
  close(image.levels[0].data, expected([1, 0, 0], AP1), 'tiled level 0');
  assert.equal(parseTiledEXR(tiled([1, 0, 0])).primariesConverted, false);
});

test('the prebuilt decoder path converts the same way', async () => {
  const image = await decodeEXR(await pixel([1, 0, 0], AP1));
  assert.equal(image.primariesConverted, true);
  assert.deepEqual(image.primaries, AP1.map(f32));
  close(image.data, expected([1, 0, 0], AP1), 'codecs');
  const plain = await decodeEXR(await pixel([0.25, 0.5, 2]));
  assert.equal(plain.primariesConverted, false);
  assert.deepEqual(Array.from(plain.data), [0.25, 0.5, 2, 1]);
});

test('encodeEXR refuses chromaticities that are not eight finite numbers', async () => {
  for (const bad of [[1, 2], [...AP1.slice(0, 7), Number.NaN], [...AP1.slice(0, 7), 1e39], 'AP1'])
    await assert.rejects(pixel([1, 0, 0], bad), /EXR chromaticities: pass eight finite numbers/);
});
