// Plain-data input checks shared by every exporter.
import assert from 'node:assert/strict';
import test from 'node:test';
import { exportGLB } from '../dist/index.js';

const triangle = () => ({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1] });
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);

test('a texture name must be a string', () => {
  const geometry = { ...triangle(), uvs: [0, 0, 1, 0, 0, 1] },
    material = { baseColorTexture: { image: png, mimeType: 'image/png', name: 7 } };
  assert.throws(() => exportGLB({ nodes: [{ geometry, material }] }), {
    name: 'TypeError',
    message: /baseColorTexture name must be a string/,
  });
});

test('more face records than triangles are refused before they are read', () => {
  const faceSizes = {
    length: 2 ** 40,
    get 0() {
      throw new Error('faceSizes was read');
    },
  };
  assert.throws(() => exportGLB({ nodes: [{ geometry: { ...triangle(), faceSizes } }] }), {
    name: 'RangeError',
    message: /faceSizes must cover every triangle once/,
  });
});
