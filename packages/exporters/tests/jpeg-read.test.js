// The JPEG reader against what libjpeg-turbo, through Pillow, decoded each fixture to (tests/fixtures/NOTICE.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodePNG } from '@margoengine/decoders/png';
import { decodeJPEG } from '../dist/jpeg-read.js';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`fixtures/jpeg/${name}`, import.meta.url)));

/** Largest and mean difference from Pillow's pixels, over the three colour channels. */
function compare(name) {
  const mine = decodeJPEG(fixture(`${name}.jpg`)),
    theirs = decodePNG(fixture(`${name}.png`));
  assert.equal(mine.width, theirs.width, name);
  assert.equal(mine.height, theirs.height, name);
  let worst = 0,
    sum = 0;
  for (let i = 0; i < mine.data.length; i += 4) {
    assert.equal(mine.data[i + 3], 255, 'JPEG has no alpha');
    for (let c = 0; c < 3; c++) {
      const difference = Math.abs(mine.data[i + c] - theirs.data[i + c]);
      worst = Math.max(worst, difference);
      sum += difference;
    }
  }
  return { worst, mean: sum / ((mine.data.length / 4) * 3) };
}

// Bounds: libjpeg-turbo's integer inverse DCT lands within 1 of the exact transform this reader computes (IEEE 1180, which
// it meets). One level of error in a plane moves a colour by at most 1 for luma plus 1.772 for chroma (T.871), and the
// two conversions round apart by up to 1: 1 + 1.772 + 1 < 4. Grey has no chroma: 1, plus nothing to convert. Plain RGB
// files have no conversion: 1. Chroma filtered up by 3/4 and 1/4 rounds once more in libjpeg, adding 1 level of chroma:
// 1 + 2 * 1.772 + 1 < 6. The mean of a right decode stays far under one level; a wrong table or block order does not.
const BOUNDS = {
  'baseline-444': 4,
  'baseline-422': 6,
  'baseline-420': 6,
  'progressive-444': 4,
  'progressive-420': 6,
  'restart-420': 6,
  'optimized-420': 6,
  'rgb-adobe': 1,
  grey: 1,
  'grey-progressive': 1,
};

for (const [name, bound] of Object.entries(BOUNDS))
  test(`decodeJPEG reads ${name} as libjpeg-turbo does`, () => {
    const { worst, mean } = compare(name);
    assert.ok(worst <= bound, `${name}: worst ${worst}, bound ${bound}`);
    assert.ok(mean < 1, `${name}: mean ${mean}`);
  });

test('decodeJPEG refuses CMYK and anything but an 8-bit Huffman file, by name', () => {
  assert.throws(() => decodeJPEG(fixture('cmyk.jpg')), /4 components/);
  const arithmetic = fixture('baseline-444.jpg').slice(),
    frame = arithmetic.findIndex((byte, i) => byte === 0xff && arithmetic[i + 1] === 0xc0);
  arithmetic[frame + 1] = 0xc9;
  assert.throws(() => decodeJPEG(arithmetic), /arithmetic/);
  const deep = fixture('baseline-444.jpg').slice();
  deep[frame + 4] = 12;
  assert.throws(() => decodeJPEG(deep), /12-bit/);
});

test('decodeJPEG refuses a file over maxPixels before reading its scans', () => {
  assert.throws(() => decodeJPEG(fixture('baseline-444.jpg'), { maxPixels: 100 }), RangeError);
});

test('decodeJPEG refuses a file cut inside its scan data', () => {
  const whole = fixture('baseline-420.jpg');
  assert.throws(() => decodeJPEG(whole.subarray(0, whole.length - 200)), /less data/);
});

test('decodeJPEG reads a whole file that lost only its end marker', () => {
  const whole = fixture('baseline-420.jpg'),
    bare = whole.subarray(0, whole.length - 2);
  assert.deepEqual(decodeJPEG(bare).data, decodeJPEG(whole).data);
});

test('decodeJPEG ends in a clean error or a picture on damaged bytes, never a crash or a hang', () => {
  // A fixed sequence, so a failure here repeats.
  let state = 12345;
  const next = (limit) => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state % limit;
  };
  for (const name of ['baseline-420.jpg', 'progressive-420.jpg', 'restart-420.jpg']) {
    const whole = fixture(name);
    for (let round = 0; round < 300; round++) {
      const bytes = whole.slice();
      for (let hit = 0; hit < 1 + next(8); hit++) bytes[2 + next(bytes.length - 2)] = next(256);
      try {
        const { data, width, height } = decodeJPEG(bytes, { maxPixels: 2 ** 20 });
        assert.equal(data.length, width * height * 4);
      } catch (error) {
        assert.ok(error instanceof RangeError || error.code !== undefined, `${name} round ${round}: ${error}`);
      }
    }
  }
});
