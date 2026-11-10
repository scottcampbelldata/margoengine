import assert from 'node:assert/strict';
import test from 'node:test';
import { CompatQueue } from '../dist/device.js';

test('external bitmap copies apply crop, flip and alpha settings through a drawable image for every target', () => {
  const ownBitmap = Object.getOwnPropertyDescriptor(globalThis, 'ImageBitmap');
  const ownCanvas = Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas');
  const draws = [];
  class Bitmap {
    width = 4;
    height = 4;
  }
  class Canvas {
    constructor(width, height) {
      this.width = width;
      this.height = height;
    }
    getContext(type) {
      assert.equal(type, '2d');
      return { drawImage: (...args) => draws.push(args) };
    }
  }
  Object.defineProperty(globalThis, 'ImageBitmap', { configurable: true, value: Bitmap });
  Object.defineProperty(globalThis, 'OffscreenCanvas', { configurable: true, value: Canvas });
  try {
    for (const target of [1, 2, 3])
      for (const flipY of [false, true])
        for (const premultipliedAlpha of [false, true]) {
          const stores = new Map(),
            uploads = [],
            image = new Bitmap();
          const gl = {
            TEXTURE_2D: 1,
            TEXTURE_CUBE_MAP: 2,
            TEXTURE_CUBE_MAP_POSITIVE_X: 20,
            UNPACK_FLIP_Y_WEBGL: 4,
            UNPACK_PREMULTIPLY_ALPHA_WEBGL: 5,
            UNPACK_SKIP_PIXELS: 6,
            UNPACK_SKIP_ROWS: 7,
            RGBA: 8,
            UNSIGNED_BYTE: 9,
            pixelStorei(key, value) {
              stores.set(key, value);
            },
            texSubImage2D(...args) {
              uploads.push({ args, stores: new Map(stores) });
            },
            texSubImage3D(...args) {
              uploads.push({ args, stores: new Map(stores) });
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
            { source: image, origin: [1, 1], flipY },
            { texture, origin: [0, 0, target === 1 ? 0 : 1], premultipliedAlpha },
            [2, 2],
          );
          assert.equal(uploads.length, 1);
          const copied = uploads[0].args.at(-1);
          assert.ok(
            copied instanceof Canvas,
            'WebGL ignores bitmap unpack flip and alpha flags; normalize the source first',
          );
          assert.equal(copied.width, 2);
          assert.equal(copied.height, 2);
          assert.deepEqual(draws.at(-1), [image, 1, 1, 2, 2, 0, 0, 2, 2], 'crop once before upload orientation');
          assert.equal(uploads[0].stores.get(gl.UNPACK_FLIP_Y_WEBGL), flipY);
          assert.equal(uploads[0].stores.get(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL), premultipliedAlpha);
          assert.equal(uploads[0].stores.get(gl.UNPACK_SKIP_PIXELS), 0);
          assert.equal(uploads[0].stores.get(gl.UNPACK_SKIP_ROWS), 0);
          assert.equal(stores.get(gl.UNPACK_FLIP_Y_WEBGL), false);
          assert.equal(stores.get(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL), false);
          assert.equal(texture.initialized, true);
        }
  } finally {
    if (ownBitmap) Object.defineProperty(globalThis, 'ImageBitmap', ownBitmap);
    else delete globalThis.ImageBitmap;
    if (ownCanvas) Object.defineProperty(globalThis, 'OffscreenCanvas', ownCanvas);
    else delete globalThis.OffscreenCanvas;
  }
});
