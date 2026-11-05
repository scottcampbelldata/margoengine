// Named colour spaces and convertColor: published values, every pair of spaces, out and offset, unknown names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Color } from '../dist/color.js';
import {
  convertColor,
  SRGBColorSpace,
  LinearSRGBColorSpace,
  DisplayP3ColorSpace,
  LinearDisplayP3ColorSpace,
} from '../dist/color-space.js';

const close = (a, b, e, m = '') => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= e, `${m}: ${a} vs ${b}`));
const all = [SRGBColorSpace, LinearSRGBColorSpace, DisplayP3ColorSpace, LinearDisplayP3ColorSpace];

test('the named spaces are the CSS color() spellings', () => {
  assert.deepEqual(all, ['srgb', 'srgb-linear', 'display-p3', 'display-p3-linear']);
});

test('convertColor: published values', () => {
  // CSS Color 4: sRGB red is color(display-p3 0.9175 0.2003 0.1386).
  close(convertColor([1, 0, 0], 'srgb', 'display-p3'), [0.9175, 0.2003, 0.1386], 1e-4, 'sRGB red in P3');
  close(convertColor([0.5, 0.5, 0.5], 'srgb', 'srgb-linear'), [0.21404, 0.21404, 0.21404], 1e-5, 'mid grey decoded');
  // P3 green lies outside sRGB: its linear sRGB red and blue are negative, and it still converts back.
  close(convertColor([0, 1, 0], 'display-p3-linear', 'srgb-linear'), [-0.2249, 1.0421, -0.0786], 1e-4, 'P3 green');
  close(convertColor(convertColor([0, 1, 0], 'display-p3', 'srgb'), 'srgb', 'display-p3'), [0, 1, 0], 1e-12, 'back');
});

test('convertColor: all 16 pairs round trip and match Color', () => {
  for (const from of all)
    for (const to of all) {
      const rgb = [0.25, 0.5, 0.75];
      close(convertColor(convertColor(rgb, from, to), to, from), rgb, 1e-12, `${from} to ${to} and back`);
      const color = new Color().setRGB(rgb[0], rgb[1], rgb[2], from);
      close(convertColor(rgb, from, to), color.getRGB(undefined, to), 1e-12, `${from} to ${to} matches Color`);
    }
});

test('convertColor: same space, out, offset and in place', () => {
  const same = [0.1, 2, -3];
  assert.deepEqual(convertColor(same, 'display-p3', 'display-p3'), same, 'the same space copies exactly');
  const out = new Float64Array(5);
  assert.equal(convertColor([1, 1, 1], 'srgb', 'display-p3', out, 2), out);
  close([...out], [0, 0, 1, 1, 1], 1e-12, 'offset');
  const inPlace = [1, 0, 0];
  assert.equal(convertColor(inPlace, 'srgb', 'display-p3', inPlace), inPlace);
  close(inPlace, [0.9175, 0.2003, 0.1386], 1e-4, 'in place');
});

test('convertColor: unknown names throw', () => {
  assert.throws(() => convertColor([0, 0, 0], 'rec2020', 'srgb'), /Color space 'rec2020' is unknown/);
  assert.throws(() => convertColor([0, 0, 0], 'srgb', 'constructor'), TypeError);
});
