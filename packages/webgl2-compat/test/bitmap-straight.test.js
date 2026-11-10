import assert from 'node:assert/strict';
import test from 'node:test';
import { CompatQueue } from '../dist/device.js';

test('whole straight-alpha bitmap uploads retain their original image and transparent RGB', () => {
  const own = Object.getOwnPropertyDescriptor(globalThis, 'ImageBitmap');
  class Bitmap {
    width = 61;
    height = 23;
  }
  Object.defineProperty(globalThis, 'ImageBitmap', { configurable: true, value: Bitmap });
  try {
    for (const target of [1, 2, 3]) {
      const image = new Bitmap(),
        uploads = [];
      const gl = {
        TEXTURE_2D: 1,
        TEXTURE_CUBE_MAP: 2,
        TEXTURE_CUBE_MAP_POSITIVE_X: 20,
        RGBA: 8,
        UNSIGNED_BYTE: 9,
        pixelStorei() {},
        texSubImage2D(...args) {
          uploads.push(args);
        },
        texSubImage3D(...args) {
          uploads.push(args);
        },
      };
      const device = {
        destroyed: false,
        gl,
        enum: (name) => gl[name],
        state: { scratch() {} },
        replayer: { sync() {} },
      };
      const texture = {
        texture: {},
        target,
        storageInfo: { kind: 'float', renderable: true, format: 'RGBA', type: 'UNSIGNED_BYTE' },
        dimension: '2d',
        read() {},
        wrote() {},
      };
      new CompatQueue(device).copyExternalImageToTexture(
        { source: image },
        { texture, premultipliedAlpha: false },
        [61, 23],
      );
      assert.equal(uploads[0].at(-1), image, 'no lossy canvas alpha conversion for an unchanged bitmap');
    }
  } finally {
    if (own) Object.defineProperty(globalThis, 'ImageBitmap', own);
    else delete globalThis.ImageBitmap;
  }
});
