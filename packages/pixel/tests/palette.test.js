// Node checks of @margoengine/pixel/palette: matrices, palette helpers, the CPU matcher and option errors.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bayerMatrix,
  blueNoise,
  ditherMatrix,
  nearestPaletteIndex,
  oklabFromSRGB,
  PaletteQuantize,
  paletteRamp,
  readPalette,
  shiftPaletteHue,
  sRGBFromOklab,
} from '../dist/palette.js';

test('Bayer matrices are the standard ones', () => {
  const ranks = (size) => [...bayerMatrix(size)].map((v) => v * size * size - 0.5);
  assert.deepEqual(ranks(2), [0, 2, 3, 1]);
  assert.deepEqual(ranks(4), [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]);
  const eight = ranks(8);
  assert.deepEqual(
    [...eight].sort((a, b) => a - b),
    Array.from({ length: 64 }, (_, i) => i),
    'each rank once',
  );
  assert.equal(eight[0], 0);
  assert.equal(eight[1], 32);
  assert.throws(() => bayerMatrix(3), RangeError);
});

test('blue noise ranks every pixel once and repeats for a seed', () => {
  const noise = blueNoise(16, 7),
    ranks = [...noise].map((v) => Math.round(v * 256 - 0.5)).sort((a, b) => a - b);
  assert.deepEqual(
    ranks,
    Array.from({ length: 256 }, (_, i) => i),
  );
  assert.deepEqual(blueNoise(16, 7), noise, 'deterministic');
  assert.notDeepEqual(blueNoise(16, 8), noise, 'the seed matters');
  assert.throws(() => blueNoise(3), RangeError);
});

test('blue noise has less low-frequency energy than the same values shuffled', () => {
  const size = 32,
    noise = blueNoise(size),
    lowEnergy = (m) => {
      // A 2 x 2 box filter keeps low frequencies: blue noise averages out, white noise does not.
      let sum = 0;
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const at = (ax, ay) => m[((y + ay) % size) * size + ((x + ax) % size)];
          sum += ((at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1)) / 4 - 0.5) ** 2;
        }
      return sum;
    };
  let state = 12345;
  const shuffled = [...noise];
  for (let i = shuffled.length - 1; i > 0; i--) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const k = state % (i + 1);
    [shuffled[i], shuffled[k]] = [shuffled[k], shuffled[i]];
  }
  assert.ok(lowEnergy(noise) < lowEnergy(shuffled) / 2, `${lowEnergy(noise)} vs ${lowEnergy(shuffled)}`);
});

test('the 64 x 64 tile the pass uses is ready', () => {
  const tile = ditherMatrix('blue-noise');
  assert.equal(tile.size, 64);
  assert.equal(tile.values.length, 4096);
  assert.equal(ditherMatrix('none'), undefined);
  assert.equal(ditherMatrix('bayer4').size, 4);
});

test('palettes read from hex and bytes', () => {
  assert.deepEqual(readPalette(['#ff0000', [0, 255, 0]]), [
    [1, 0, 0],
    [0, 1, 0],
  ]);
  assert.throws(() => readPalette([]), /1 to 256/);
  assert.throws(() => readPalette(new Array(257).fill('#000000')), /1 to 256/);
  assert.throws(() => readPalette(['red']), /Invalid palette colour/);
  assert.throws(() => readPalette([[300, 0, 0]]), /Invalid palette colour/);
});

test('Oklab round trips and matches published values', () => {
  const white = oklabFromSRGB(1, 1, 1);
  assert.ok(Math.abs(white[0] - 1) < 1e-4 && Math.abs(white[1]) < 1e-4 && Math.abs(white[2]) < 1e-4);
  const red = oklabFromSRGB(1, 0, 0);
  assert.ok(Math.abs(red[0] - 0.628) < 1e-3 && Math.abs(red[1] - 0.2249) < 1e-3 && Math.abs(red[2] - 0.1258) < 1e-3);
  const back = sRGBFromOklab(...oklabFromSRGB(0.2, 0.5, 0.8));
  [0.2, 0.5, 0.8].forEach((v, i) => assert.ok(Math.abs(back[i] - v) < 1e-4));
});

test('hue shift keeps lightness, zero keeps the colour, ramps hit their ends', () => {
  assert.deepEqual(shiftPaletteHue(['#336699'], 0), ['#336699']);
  assert.deepEqual(shiftPaletteHue(['#808080'], 90), ['#808080'], 'grey has no hue');
  const [turned] = shiftPaletteHue(['#336699'], 120),
    [r, g, b] = readPalette([turned])[0];
  assert.ok(Math.abs(oklabFromSRGB(r, g, b)[0] - oklabFromSRGB(0x33 / 255, 0x66 / 255, 0x99 / 255)[0]) < 0.02);
  assert.notEqual(turned, '#336699');
  const ramp = paletteRamp('#000000', '#ffffff', 3);
  assert.equal(ramp.length, 3);
  assert.equal(ramp[0], '#000000');
  assert.equal(ramp[2], '#ffffff');
  assert.throws(() => paletteRamp('#000000', '#ffffff', 1), RangeError);
  assert.throws(() => shiftPaletteHue(['#000000'], Number.NaN), RangeError);
});

test('matching picks by distance, and the dither moves it', () => {
  const palette = readPalette(['#000000', '#ffffff']);
  assert.equal(nearestPaletteIndex(0.1, 0.1, 0.1, palette, 'srgb'), 0);
  assert.equal(nearestPaletteIndex(0.9, 0.9, 0.9, palette, 'srgb'), 1);
  // Oklab lightness: sRGB 0.4 is already past the middle of black and white to the eye.
  assert.equal(nearestPaletteIndex(0.4, 0.4, 0.4, palette, 'srgb'), 0);
  assert.equal(nearestPaletteIndex(0.4, 0.4, 0.4, palette, 'oklab'), 1);
  assert.equal(nearestPaletteIndex(0.48, 0.48, 0.48, palette, 'srgb', 0.99, 0.125), 1);
  assert.equal(nearestPaletteIndex(0.48, 0.48, 0.48, palette, 'srgb', 0.01, 0.125), 0);
});

test('bad options throw', () => {
  const source = {},
    target = {};
  assert.throws(() => new PaletteQuantize({}), TypeError);
  assert.throws(() => new PaletteQuantize({ palette: [], source, target }), RangeError);
  assert.throws(() => new PaletteQuantize({ palette: ['#000'], source, target, distance: 'x' }), RangeError);
  assert.throws(
    () => new PaletteQuantize({ palette: ['#000'], swap: ['#000', '#fff'], source, target }),
    /as many colours/,
  );
});
