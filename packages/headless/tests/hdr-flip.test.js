// HDR-FLIP (Andersson, Nilsson, Shirley and Akenine-Moller, Eurographics 2021 short paper): exposure range from the
// reference (section 2.1, Equations 2 and 3, target 0.85 for the largest and the median luminance), N = max(2,
// ceil(stop - start)) exposures, and the largest LDR-FLIP error per pixel over them (section 2.2, Equation 4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { flip, hdrFlip } from '../dist/look.js';
import { acesNarkowicz } from '../../shared/aces.js';

/** A linear RGBA float frame from an RGB function of (x, y). */
const hdr = (width, height, colour) => {
  const data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([...colour(x, y), 1], (y * width + x) * 4);
  return { width, height, data };
};
/** A seeded uniform noise source. */
const noise = (seed) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const luminance = ([r, g, b]) => 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
// A lamp-lit room: a bright lamp (luminance about 40) over a dim wall (about 0.02 to 0.1).
const room = (x, y) => (x > 24 && x < 32 && y > 4 && y < 12 ? [40, 36, 30] : [0.02 + x / 600, 0.03, 0.02 + y / 900]);

test('hdrFlip is 0 for identical frames and sets its exposures from the reference by Equations 2 and 3', () => {
  const reference = hdr(48, 32, room),
    same = hdrFlip(reference, reference, { toneMapper: 'reinhard' });
  assert.equal(same.mean, 0);
  assert.equal(same.max, 0);
  // Reinhard x / (1 + x) = 0.85 at x = 0.85 / 0.15, then c = log2(x / I).
  const pixels = Array.from({ length: 48 * 32 }, (_, i) => luminance(room(i % 48, Math.floor(i / 48)))).sort(
      (a, b) => a - b,
    ),
    largest = Math.fround(pixels.at(-1)),
    median = (Math.fround(pixels[767]) + Math.fround(pixels[768])) / 2,
    x = 0.85 / 0.15;
  assert.ok(Math.abs(same.startExposure - Math.log2(x / largest)) < 1e-6, `start ${same.startExposure}`);
  assert.ok(Math.abs(same.stopExposure - Math.log2(x / median)) < 1e-6, `stop ${same.stopExposure}`);
  assert.equal(same.exposures, Math.max(2, Math.ceil(same.stopExposure - same.startExposure)));
  // The default ACES start exposure brings the largest luminance to 0.85 through the shared Narkowicz curve.
  const aces = hdrFlip(reference, reference),
    lamp = 2 ** aces.startExposure * largest;
  assert.ok(Math.abs(acesNarkowicz([lamp, lamp, lamp])[0] - 0.85) < 1e-9);
  assert.ok(aces.startExposure < aces.stopExposure);
});

test('hdrFlip takes N = max(2, ceil(stop - start)) exposures, and given exposures as they are', () => {
  const reference = hdr(16, 16, room),
    test = hdr(16, 16, (x, y) => room(x, y).map((v) => v * 1.1));
  assert.equal(hdrFlip(test, reference, { startExposure: -1, stopExposure: 3.5 }).exposures, 5);
  assert.equal(hdrFlip(test, reference, { startExposure: -1, stopExposure: 3 }).exposures, 4);
  const single = hdrFlip(test, reference, { startExposure: 2, stopExposure: 2 });
  assert.equal(single.exposures, 2);
  assert.equal(single.startExposure, 2);
  assert.equal(single.stopExposure, 2);
  // Only one end given: the other still comes from the reference.
  const half = hdrFlip(test, reference, { startExposure: -4 });
  assert.equal(half.startExposure, -4);
  assert.equal(half.stopExposure, hdrFlip(test, reference).stopExposure);
});

test('hdrFlip keeps the largest LDR-FLIP error of each pixel over the exposures (Equation 4)', () => {
  const random = noise(3),
    reference = hdr(40, 24, room),
    // Noise on the dim wall only: hidden at short exposures, plain at long ones.
    test = hdr(40, 24, (x, y) => room(x, y).map((v) => (v < 1 ? v * (0.6 + 0.8 * random()) : v))),
    full = hdrFlip(test, reference, { map: true, exposureMap: true }),
    exposures = Array.from(
      { length: full.exposures },
      (_, e) => full.startExposure + (e * (full.stopExposure - full.startExposure)) / (full.exposures - 1),
    ),
    maps = exposures.map((c) => hdrFlip(test, reference, { startExposure: c, stopExposure: c, map: true }).map);
  for (let i = 0; i < full.map.length; i++) {
    let largest = 0,
      at = exposures[0];
    for (let e = 0; e < maps.length; e++)
      if (maps[e][i] > largest) {
        largest = maps[e][i];
        at = exposures[e];
      }
    assert.equal(full.map[i], largest);
    assert.equal(full.exposureMap[i], Math.fround(at));
  }
  // The short exposure alone misses most of the wall's noise.
  const short = hdrFlip(test, reference, { startExposure: full.startExposure, stopExposure: full.startExposure });
  assert.ok(full.mean > 2 * short.mean, `full ${full.mean}, shortest exposure ${short.mean}`);
  assert.ok(full.mean > 0.1 && full.max <= 1, `mean ${full.mean}`);
});

test('hdrFlip with an identity curve at exposure 0 is the 8-bit flip of the same linear light', () => {
  const toLinear = (c) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4),
    ldr = (shift) => {
      const data = new Uint8Array(32 * 32 * 4);
      for (let i = 0; i < 32 * 32; i++) data.set([(i * 7 + shift) % 256, (i * 3) % 256, 90, 255], i * 4);
      return { width: 32, height: 32, data };
    },
    float = ({ width, height, data }) => ({
      width,
      height,
      data: Float32Array.from(data, (v, i) => (i % 4 === 3 ? 1 : toLinear(v))),
    }),
    a = ldr(0),
    b = ldr(20),
    eight = flip(a, b),
    high = hdrFlip(float(a), float(b), { toneMapper: [0, 1, 0, 0, 0, 1], startExposure: 0, stopExposure: 0 });
  assert.ok(Math.abs(high.mean - eight.mean) < 1e-6, `${high.mean} against ${eight.mean}`);
  assert.equal(high.p95, eight.p95);
});

test('hdrFlip reads half floats and refuses frames and options it cannot judge', () => {
  // Half floats of 0.5 (0x3800) and 2 (0x4000), alpha 1 (0x3c00).
  const half = (bits) => ({
      width: 4,
      height: 4,
      data: new Uint16Array(64).map((_, i) => (i % 4 === 3 ? 0x3c00 : bits)),
    }),
    floats = (value) => hdr(4, 4, () => [value, value, value]);
  const fromHalf = hdrFlip(half(0x4000), half(0x3800), { startExposure: -2, stopExposure: 1 }),
    fromFloat = hdrFlip(floats(2), floats(0.5), { startExposure: -2, stopExposure: 1 });
  assert.equal(fromHalf.mean, fromFloat.mean);
  assert.ok(fromHalf.mean > 0);
  const good = floats(1);
  assert.throws(() => hdrFlip(floats(-0.1), good), RangeError);
  assert.throws(() => hdrFlip(floats(Number.NaN), good), RangeError);
  assert.throws(() => hdrFlip(good, floats(Number.POSITIVE_INFINITY)), RangeError);
  assert.throws(
    () =>
      hdrFlip(
        good,
        hdr(2, 2, () => [1, 1, 1]),
      ),
    RangeError,
  );
  assert.throws(() => hdrFlip({ width: 4, height: 4, data: new Uint8Array(64) }, good), TypeError);
  // A black reference has no luminance to set exposures from; given exposures it is judged.
  assert.throws(() => hdrFlip(good, floats(0)), /startExposure and stopExposure/);
  assert.ok(hdrFlip(good, floats(0), { startExposure: -1, stopExposure: 1 }).mean > 0.5);
  assert.throws(() => hdrFlip(good, good, { startExposure: 2, stopExposure: 1 }), RangeError);
  assert.throws(() => hdrFlip(good, good, { stopExposure: Number.NaN }), RangeError);
  assert.throws(() => hdrFlip(good, good, { toneMapper: [1, 2, 3] }), TypeError);
  assert.throws(() => hdrFlip(good, good, { toneMapper: 'filmic' }), TypeError);
  // A curve that never reaches 0.85: y = 0.5 everywhere.
  assert.throws(() => hdrFlip(good, good, { toneMapper: [0, 0, 1, 0, 0, 2] }), RangeError);
  assert.throws(() => hdrFlip(good, good, { pixelsPerDegree: 0 }), RangeError);
});
