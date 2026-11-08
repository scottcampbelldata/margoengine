// Node checks of @margoengine/pixel/crt: defaults and option errors. The look itself is proved by crt-check.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CRT } from '../dist/crt.js';

test('the defaults are the documented ones and every look setting is a field', () => {
  const crt = new CRT({ source: {} });
  assert.deepEqual(
    [crt.curvature, crt.scanlines, crt.mask, crt.glow, crt.brightness, crt.fit],
    [0.08, 0.5, 0.2, 0.25, 1.2, 'contain'],
  );
  crt.scanlines = 1;
  assert.equal(crt.scanlines, 1);
});

test('settings out of range and a missing source are refused', () => {
  assert.throws(() => new CRT({}), TypeError);
  for (const [key, value] of [
    ['curvature', 0.6],
    ['scanlines', -0.1],
    ['mask', 2],
    ['glow', Number.NaN],
    ['brightness', 5],
  ])
    assert.throws(() => new CRT({ source: {}, [key]: value }), new RegExp(`CRT ${key} must be between`));
});
