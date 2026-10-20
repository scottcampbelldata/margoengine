// Display P3 input colours: the matrices from the primaries, CSS color() strings, Color in P3, and clipping to sRGB.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Color,
  parseColor,
  P3_TO_SRGB,
  SRGB_TO_P3,
  linearP3ToLinearSRGB,
  linearSRGBToLinearP3,
  clipToSRGB,
  SRGBToLinear,
} from '../dist/color.js';

const close = (a, b, e, m = '') => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= e, `${m}: ${a} vs ${b}`));
const luminance = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

test('P3 to sRGB from the primaries: the published matrix, white to white, and its inverse', () => {
  // The linear Display P3 -> linear sRGB matrix to 4 decimals (each row sums to 1: white stays white).
  close(P3_TO_SRGB, [1.2249, -0.2249, 0, -0.0421, 1.0421, 0, -0.0196, -0.0786, 1.0983], 1e-4, 'matrix');
  close(linearP3ToLinearSRGB([1, 1, 1]), [1, 1, 1], 1e-12, 'white');
  const p = [0.3, 0.8, 0.1];
  close(linearSRGBToLinearP3(linearP3ToLinearSRGB(p)), p, 1e-12, 'round trip');
  close(SRGB_TO_P3.slice(0, 3), [0.8225, 0.1775, 0], 1e-4, 'inverse, first row');
  // Luminance is the same in both spaces (same white, the Y row is preserved).
  close([luminance(linearP3ToLinearSRGB([0, 1, 0]))], [0.6917], 1e-4, 'P3 green luminance');
});

test('CSS color() strings: P3 outside sRGB keeps negative channels, the rest as their space says', () => {
  const red = parseColor('color(display-p3 1 0 0)');
  close(red, [1.2249, -0.0421, -0.0196], 1e-4, 'P3 red');
  const grey = SRGBToLinear(0.5);
  close(parseColor('color(display-p3 0.5 0.5 0.5)'), [grey, grey, grey], 1e-12, 'P3 grey is sRGB grey');
  close(parseColor('color(display-p3 50% 50% 50% / 0.5)'), [grey, grey, grey], 1e-12, 'percent and alpha');
  close(parseColor('color(srgb 1 0.5 0)'), [1, SRGBToLinear(0.5), 0], 1e-12, 'srgb');
  close(parseColor('color(srgb-linear 0.2 0.4 0.6)'), [0.2, 0.4, 0.6], 1e-12, 'srgb-linear');
  close(parseColor('color(display-p3-linear 0 1 0)'), [-0.2249, 1.0421, -0.0786], 1e-4, 'p3 linear green');
  assert.throws(() => parseColor('color(rec2020 1 0 0)'), TypeError);
  assert.throws(() => parseColor('color(display-p3 1 0)'), TypeError);
  assert.throws(() => parseColor([1, -0.04, 0]), RangeError, 'linear sRGB arrays stay non-negative');
});

test('Color in Display P3: set, get, hex and style', () => {
  const c = new Color().setRGB(0, 1, 0, 'display-p3');
  close([c.r, c.g, c.b], [-0.2249, 1.0421, -0.0786], 1e-4, 'linear sRGB');
  close(c.getRGB([0, 0, 0], 'display-p3'), [0, 1, 0], 1e-9, 'back in P3');
  assert.equal(c.getHex('display-p3'), 0x00ff00);
  assert.equal(c.getHex(), 0x00ff00, 'clamped into sRGB for an sRGB hex');
  const s = new Color().setStyle('color(display-p3 1 0.5 0)');
  close(s.getRGB([0, 0, 0], 'display-p3'), [1, 0.5, 0], 1e-9, 'style');
  close(
    new Color().setHex(0xff8800, 'display-p3').getRGB([0, 0, 0], 'display-p3'),
    [1, 0x88 / 255, 0],
    1e-9,
    'hex in P3',
  );
  // sRGB behaviour is unchanged.
  close([...new Color().setRGB(0.5, 0.5, 0.5, 'srgb').toArray()], [grey(), grey(), grey()], 1e-12, 'srgb');
});
const grey = () => SRGBToLinear(0.5);

test('clipToSRGB desaturates toward luminance just enough; in-gamut and HDR colours pass', () => {
  for (const p3 of [
    [0, 1, 0],
    [1, 0, 0],
    [0, 0, 1],
    [0.1, 0.9, 0.05],
  ]) {
    const rgb = linearP3ToLinearSRGB(p3),
      clipped = clipToSRGB(rgb);
    assert.ok(Math.min(...clipped) >= 0 && Math.min(...clipped) < 1e-12, `one channel at 0: ${clipped}`);
    close([luminance(clipped)], [luminance(rgb)], 1e-12, 'luminance kept');
  }
  close(clipToSRGB([0.2, 0.5, 3]), [0.2, 0.5, 3], 0, 'inside sRGB and HDR');
  const out = new Float32Array(4);
  clipToSRGB([-0.1, 1, 0], out, 1);
  assert.equal(out[0], 0);
});
