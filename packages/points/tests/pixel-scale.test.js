// PointsPlugin.pixelScale: an owner that sizes points in CSS pixels (sciviz) scales the pixel sizes as the cloud's
// uniform is written, so the drawn target gets target pixels while the material keeps the caller's values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PointCloud, PointsPlugin } from '../dist/index.js';

function uniformOf(plugin, cloud, scale) {
  const writes = [];
  plugin['device'] = { queue: { writeBuffer: (_buffer, _offset, data) => writes.push(Float32Array.from(data)) } };
  const floats = new Float32Array(64),
    r = { floats, uints: new Uint32Array(floats.buffer), written: new Float32Array(64).fill(NaN), uniform: {} };
  plugin['writeCloudUniform'](cloud, r, new Float32Array(16), false, scale);
  assert.equal(writes.length, 1);
  return writes[0];
}

test('pixel sizes and pixel clamps follow the pixel scale; the material keeps its values', () => {
  const plugin = new PointsPlugin(),
    cloud = new PointCloud({
      positions: new Float32Array(3),
      material: { size: 10, minPixelSize: 2, maxPixelSize: 64 },
    });
  assert.deepEqual([...uniformOf(plugin, cloud, 1).subarray(20, 23)], [10, 2, 64]);
  assert.deepEqual([...uniformOf(plugin, cloud, 2).subarray(20, 23)], [20, 4, 128]);
  assert.deepEqual([cloud.material.size, cloud.material.minPixelSize, cloud.material.maxPixelSize], [10, 2, 64]);
});

test('world sizes are not pixels: only their pixel clamps scale', () => {
  const plugin = new PointsPlugin(),
    cloud = new PointCloud({
      positions: new Float32Array(3),
      material: { size: 0.5, sizeUnits: 'world', minPixelSize: 1, maxPixelSize: 32 },
    });
  assert.deepEqual([...uniformOf(plugin, cloud, 2).subarray(20, 23)], [0.5, 2, 64]);
});
