import test from 'node:test';
import assert from 'node:assert/strict';
import { clearColorValue, hexColor } from '../packages/shared/clear-color.js';
import { PbrMaterial } from '../packages/core/dist/index.js';

// Core's one hex parser (packages/shared/clear-color.js, bundled into core) takes the CSS forms core documents:
// `#rgb` and `#rrggbb` (docs/conventions.md, ColorInput). `#555` once threw "Invalid Color" in PbrMaterial and
// "Invalid color" as a clear colour, because only six digits passed.

test('hexColor reads #rgb as CSS does, doubling each digit', () => {
  assert.equal(hexColor('#555'), 0x555555);
  assert.equal(hexColor('#abc'), 0xaabbcc);
  assert.equal(hexColor('#ABC'), 0xaabbcc);
  assert.equal(hexColor('#123456'), 0x123456);
});

test('hexColor refuses alpha forms and malformed strings', () => {
  // Core colours have no alpha, so `#rgba` and `#rrggbbaa` are refused rather than read with alpha dropped.
  for (const bad of ['#5555', '#55555555', '#55', '#12345', '#1234567', '555', '#gg0', '', '#'])
    assert.equal(hexColor(bad), -1, bad);
});

test('a #rgb clear colour equals its #rrggbb form', () => {
  assert.deepEqual(clearColorValue('#555'), clearColorValue('#555555'));
  assert.deepEqual(clearColorValue('#f00'), [1, 0, 0, 1]);
  assert.throws(() => clearColorValue('#5555'), { name: 'RangeError', message: 'Invalid color; use #rrggbb' });
});

test('PbrMaterial takes a #rgb colour as its #rrggbb form', () => {
  const short = new PbrMaterial({ color: '#555' }),
    long = new PbrMaterial({ color: '#555555' });
  assert.deepEqual(Array.from(short.data), Array.from(long.data));
  // sRGB 0x55 = 85/255, decoded to linear: ((85/255 + 0.055) / 1.055) ** 2.4.
  assert.ok(Math.abs(short.data[0] - ((85 / 255 + 0.055) / 1.055) ** 2.4) < 1e-6);
  short.set({ color: '#fff' });
  assert.deepEqual(Array.from(short.data.slice(0, 3)), [1, 1, 1]);
  assert.throws(() => new PbrMaterial({ color: '#5555' }), TypeError);
});
