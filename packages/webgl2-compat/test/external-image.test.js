import assert from 'node:assert/strict';
import test from 'node:test';
import { CompatQueue } from '../dist/device.js';

// KB0477: WebGL ignores the unpack flip and alpha flags for an ImageBitmap and uploads it as held, straight or
// premultiplied, so every bitmap copy (whole or cropped, flipped or not, either alpha) goes to the replayer's GPU
// copy, which finds the bitmap's alpha state and converts on the GPU. The pixels are checked against native WebGPU
// by features.html's bitmapCopies case (test:gpu); this pins the routing and its arguments.
test('every ImageBitmap copy takes the GPU copy with its region, flip, destination and alpha', () => {
  const own = Object.getOwnPropertyDescriptor(globalThis, 'ImageBitmap');
  class Bitmap {
    width = 61;
    height = 23;
  }
  Object.defineProperty(globalThis, 'ImageBitmap', { configurable: true, value: Bitmap });
  try {
    for (const target of [1, 2, 3])
      for (const [origin, size] of [
        [undefined, [61, 23]],
        [[2, 1], [4, 3]],
      ])
        for (const flipY of [false, true])
          for (const premultipliedAlpha of [false, true]) {
            const copies = [],
              uploads = [],
              image = new Bitmap();
            const gl = {
              pixelStorei() {},
              texSubImage2D: (...args) => uploads.push(args),
              texSubImage3D: (...args) => uploads.push(args),
            };
            const device = {
              destroyed: false,
              gl,
              enum: (name) => gl[name],
              state: { scratch() {} },
              replayer: {
                sync() {},
                attachable: (info) => info.renderable,
                copyBitmap: (...args) => copies.push(args),
              },
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
              { source: image, origin, flipY },
              { texture, origin: [3, 4, target === 1 ? 0 : 1], mipLevel: 0, premultipliedAlpha },
              size,
            );
            assert.deepEqual(uploads, [], 'no direct upload: WebGL would ignore the flip and alpha flags');
            assert.deepEqual(copies, [
              [image, [...(origin ?? [0, 0]), ...size], flipY, texture, 0, [3, 4, target === 1 ? 0 : 1], premultipliedAlpha],
            ]);
            assert.equal(texture.initialized, true);
          }
  } finally {
    if (own) Object.defineProperty(globalThis, 'ImageBitmap', own);
    else delete globalThis.ImageBitmap;
  }
});
