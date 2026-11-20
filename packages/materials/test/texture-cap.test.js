// KB-MATERIALS-TEXCAP1: raw RGBA8 pixels of a correct length were refused above a fixed 16,777,216-pixel count with a
// message about the data length. The size a GPU holds is the device's maxTextureDimension2D per side (WebGPU, W3C,
// "Limits"), checked at upload; construction checks only what the caller passed, one condition per message.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { CubeTexture, Texture } from '../dist/index.js';

const photo = (w, h, bytes = w * h * 4) => ({ data: new Uint8Array(bytes), width: w, height: h });

test('a 6000 x 3375 photo with the right data length is accepted and uploads on an 8192 device', () => {
  const texture = new Texture(photo(6000, 3375), { mipmaps: false }),
    gpu = mockGPU();
  gpu.device.limits.maxTextureDimension2D = 8192;
  gpu.device.createCommandEncoder = () => ({ ...gpu.encoder, finish: () => ({}) });
  const log = gpu.record(() => texture.bind(gpu.device, true));
  const made = log.filter((e) => e[0] === 'texture').map((e) => e[2].size);
  assert.deepEqual(made.at(-1).slice(0, 2), [6000, 3375]);
});

test('a size past the device limit names the size and the limit', () => {
  const texture = new Texture(photo(9000, 10), { mipmaps: false }),
    gpu = mockGPU();
  gpu.device.limits.maxTextureDimension2D = 8192;
  assert.throws(() => texture.bind(gpu.device, true), {
    name: 'RangeError',
    message: /9000 x 10 pixels; this device allows 8192 per side \(maxTextureDimension2D\)/,
  });
});

test('short data names the expected and given byte counts', () => {
  assert.throws(() => new Texture(photo(4, 4, 60)), {
    name: 'RangeError',
    message: /data is 60 bytes; RGBA8 at 4 x 4 needs width \* height \* 4 = 64 bytes/,
  });
});

test('a zero or fractional size is its own message', () => {
  assert.throws(() => new Texture({ data: new Uint8Array(16), width: 0, height: 4 }), {
    name: 'RangeError',
    message: /width and height must be whole numbers of 1 or more; got 0 x 4/,
  });
  assert.throws(() => new Texture({ data: new Uint8Array(16), width: 1.5, height: 2 }), /got 1.5 x 2/);
});

test('raw cube faces get the same checks', () => {
  const face = photo(2, 2),
    short = photo(2, 2, 8);
  assert.throws(() => new CubeTexture([face, face, face, face, face, short]), /data is 8 bytes; RGBA8 at 2 x 2 needs/);
});
