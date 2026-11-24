import test from 'node:test';
import assert from 'node:assert/strict';
import { readPalette, shiftPaletteHue, paletteRamp, bayerMatrix, blueNoise, ditherMatrix, PaletteQuantize } from '../dist/palette.js';

function diagnostic(run, field, range) {
  assert.throws(run, error => {
    assert.ok(error instanceof RangeError, String(error));
    assert.ok(error.message.includes(field), error.message);
    assert.ok(error.message.includes(range), error.message);
    assert.ok(error.message.includes('https://margoengine.com/errors#pixel-palette'));
    return true;
  });
}

test('palette helper diagnostics name the argument and allowed values', () => {
  diagnostic(() => shiftPaletteHue(['#000'], NaN), 'degrees', 'finite');
  diagnostic(() => paletteRamp('#000', '#fff', 1), 'steps', 'integer of at least 2');
  diagnostic(() => paletteRamp('#000', '#fff', 2.5), 'steps', 'integer of at least 2');
  diagnostic(() => bayerMatrix(3), 'size', '2, 4 or 8');
  for (const size of [3, 257, 4.5, NaN])
    diagnostic(() => blueNoise(size), 'size', 'integer in [4, 256]');
  for (const mode of ['bayer3', 'constructor', ''])
    diagnostic(() => ditherMatrix(mode), 'dither', 'none, bayer2, bayer4, bayer8 or blue-noise');
  diagnostic(() => readPalette(['#000', [256, 0, 0]]), 'colour at index 1', '#rrggbb or three RGB bytes in [0, 255]');
});

test('palette pass diagnostics distinguish order and distance', () => {
  const options = { source: {}, target: {}, palette: ['#000', '#fff'] };
  diagnostic(() => new PaletteQuantize({ ...options, order: NaN }), 'order', 'finite');
  diagnostic(() => new PaletteQuantize({ ...options, distance: 'rgb' }), 'distance', 'oklab or srgb');
});

test('mutable spread rejects non-finite values before GPU work', () => {
  const pass = new PaletteQuantize({ source: {}, target: {}, palette: ['#000', '#fff'] });
  let execute;
  pass.setup({
    backend: 'webgpu',
    frameGraph: { add(frame) { execute = frame.execute; } },
    removePlugin() {},
    sceneOf() { return undefined; },
  });
  for (const value of [-1, NaN, Infinity, -Infinity]) {
    pass.spread = value;
    diagnostic(() => execute({ backend: 'webgpu' }), 'spread', 'finite and non-negative');
  }
  pass.dispose();
});
