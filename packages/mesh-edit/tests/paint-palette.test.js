import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../dist/index.js';
const texture = { width: 3, height: 1, pixels: [100, 180, 80, 255, 20, 30, 40, 0, 100, 180, 80, 255] };
test('public palette counting uses opaque frequency and stable RGB order without mutating pixels', () => {
  assert.equal(typeof api.dominantMeshPaintColors, 'function');
  assert.deepEqual(api.dominantMeshPaintColors(texture), ['#64b450']);
  const tie = { width: 3, height: 1, pixels: [255, 0, 0, 255, 0, 0, 255, 255, 255, 0, 0, 0] };
  assert.deepEqual(api.dominantMeshPaintColors(tie, 2), ['#0000ff', '#ff0000']);
  assert.throws(() => api.dominantMeshPaintColors(texture, NaN), /limit/i);
});
test('palette presets retain exact saturation brightness, skin and grey while mapping every source RGB', () => {
  assert.equal(typeof api.createMeshPaintPalette, 'function');
  assert.deepEqual(api.createMeshPaintPalette(texture, 'copy'), { '#64b450': '#64b450', '#141e28': '#141e28' });
  assert.deepEqual(api.createMeshPaintPalette(texture, 'blue'), { '#64b450': '#507ab4', '#141e28': '#141e28' });
  assert.throws(() => api.createMeshPaintPalette(texture, 'purple'), /preset/i);
});
test('simultaneous substitutions preserve alpha including hidden RGB and own result arrays', () => {
  assert.equal(typeof api.applyMeshPaintPalette, 'function');
  const original = structuredClone(texture),
    result = api.applyMeshPaintPalette(texture, { '#64B450': '#141e28', '#141e28': '#64b450' });
  assert.deepEqual(result.pixels, [20, 30, 40, 255, 100, 180, 80, 0, 20, 30, 40, 255]);
  assert.deepEqual(texture, original);
  result.pixels[0] = 99;
  assert.deepEqual(texture, original);
  assert.throws(() => api.applyMeshPaintPalette(texture, { 'red': '#000000' }), /six-digit/i);
});
