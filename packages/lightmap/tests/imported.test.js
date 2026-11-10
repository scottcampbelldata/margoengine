import test from 'node:test';
import assert from 'node:assert/strict';
import { readLightmap, applyLightmap, ImportedLightmapInstallation } from '../dist/imported.js';
test('external bakes keep linear HDR scale and copy pixels', () => {
  const data = new Uint8Array([128, 64, 32, 255]);
  const map = readLightmap({ width: 1, height: 1, data, scale: 12 });
  data[0] = 0;
  assert.equal(map.data[0], 128);
  assert.equal(map.scale, 12);
  assert.equal(readLightmap({ width: 1, height: 1, data }).scale, 1);
  assert.equal(typeof applyLightmap, 'function');
  assert.equal(typeof ImportedLightmapInstallation, 'function');
});
test('invalid external irradiance fails before GPU work', () => {
  const input = { width: 1, height: 1, data: new Uint8Array(4) };
  for (const scale of [0, -1, NaN, Infinity, 1e21]) assert.throws(() => readLightmap({ ...input, scale }), RangeError);
  for (const width of [0, 1.5, 4097, NaN]) assert.throws(() => readLightmap({ ...input, width }), RangeError);
  assert.throws(() => readLightmap({ ...input, data: new Uint8Array(3) }), RangeError);
});
