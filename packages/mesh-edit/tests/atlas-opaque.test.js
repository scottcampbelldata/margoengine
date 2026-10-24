// isAtlasOpaque: a mesh may occlude only when every texel under each face's UV rectangle is fully opaque.
import assert from 'node:assert/strict';
import test from 'node:test';
import { isAtlasOpaque } from '../dist/index.js';

// A 4x4 atlas, opaque except texel (3, 3).
const atlas = () => {
  const pixels = new Uint8Array(4 * 4 * 4).fill(255);
  pixels[(3 * 4 + 3) * 4 + 3] = 128;
  return { width: 4, height: 4, pixels };
};
const quad = (u0, v0, u1, v1) => ({
  vertices: [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
  ],
  faces: [
    {
      id: 'f',
      vertices: [0, 1, 2, 3],
      uv: [
        [u0, v0],
        [u1, v0],
        [u1, v1],
        [u0, v1],
      ],
    },
  ],
});

test('faces over opaque texels are opaque', () => {
  assert.equal(isAtlasOpaque(quad(0, 0, 0.75, 0.75), atlas()), true);
  // Edges that land exactly on a texel boundary do not reach the next texel.
  assert.equal(isAtlasOpaque(quad(0.5, 0.5, 0.75, 0.75), atlas()), true);
});

test('any translucent texel under a face rectangle makes the mesh not opaque', () => {
  assert.equal(isAtlasOpaque(quad(0.5, 0.5, 1, 1), atlas()), false);
  assert.equal(isAtlasOpaque(quad(0.76, 0.76, 0.8, 0.8), atlas()), false);
});

test('refuses a texture of the wrong size', () => {
  assert.throws(() => isAtlasOpaque(quad(0, 0, 1, 1), { width: 4, height: 4, pixels: new Uint8Array(3) }), TypeError);
  assert.throws(() => isAtlasOpaque(quad(0, 0, 1, 1), { width: 0, height: 4, pixels: [] }), TypeError);
});
