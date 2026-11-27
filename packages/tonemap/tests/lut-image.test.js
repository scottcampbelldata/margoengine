// Strip LUT pictures (@margoengine/tonemap/lut-image): each pixel encodes its own grid indices, so a wrong tile, row or
// column order shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { parseLUTImage } from '../dist/lut-image.js';
import { Tonemap } from '../dist/index.js';
import { decodePNG } from '../../decoders/dist/png.js';
import { pngParts } from '../../shared/png.js';
import { gpuHarness } from '../../../tests/support/postfx-gpu.js';

const N = 5;
/** The picture of an N³ LUT whose entry (r, g, b) is (r, g, b) * step, as a horizontal or vertical strip. */
function strip({ across = true, channels = 4, Type = Uint8Array, step = 50, flip = false } = {}) {
  const width = across ? N * N : N,
    height = across ? N : N * N,
    data = new Type(width * height * channels).fill(9);
  for (let b = 0; b < N; b++)
    for (let g = 0; g < N; g++)
      for (let r = 0; r < N; r++) {
        const row = flip ? N - 1 - g : g,
          x = across ? b * N + r : r,
          y = across ? row : b * N + row;
        data.set([r * step, g * step, b * step], (y * width + x) * channels);
      }
  return { width, height, data };
}
/** The RGBA LUT samples of that picture, red varying fastest, each index times `scale`. */
const expected = (scale) =>
  Float32Array.from({ length: N ** 3 * 4 }, (_, i) => {
    const entry = Math.floor(i / 4),
      c = i % 4;
    return c === 3 ? 1 : (Math.floor(entry / N ** c) % N) * scale;
  });

test('parseLUTImage reads horizontal and vertical strips, RGB or RGBA, 8-bit, 16-bit and float', () => {
  for (const across of [true, false])
    for (const channels of [3, 4])
      for (const [Type, step, max] of [
        [Uint8Array, 50, 255],
        [Uint8ClampedArray, 50, 255],
        [Uint16Array, 12000, 65535],
        [Float32Array, 0.25, 1],
      ]) {
        const lut = parseLUTImage(strip({ across, channels, Type, step }));
        assert.equal(lut.size, N);
        assert.deepEqual([...lut.domainMin, ...lut.domainMax], [0, 0, 0, 1, 1, 1]);
        assert.deepEqual(lut.data, expected(step / max), `${across} ${channels} ${Type.name}`);
      }
  for (const across of [true, false])
    assert.deepEqual(parseLUTImage(strip({ across, flip: true }), { flipGreen: true }).data, expected(50 / 255));
});

test('parseLUTImage takes a decodePNG result and Tonemap binds the LUT', () => {
  // The 2³ identity LUT as a 4 x 2 RGB PNG: each row is a filter byte 0, then blue slice 0 and blue slice 1.
  const rows = [0, 1].flatMap((g) => [
      0,
      ...[0, 1].flatMap((b) => [0, 1].flatMap((r) => [r, g, b].map((v) => v * 255))),
    ]),
    file = Buffer.concat(pngParts(4, 2, 2, deflateSync(Uint8Array.from(rows)))),
    lut = parseLUTImage(decodePNG(file));
  assert.equal(lut.size, 2);
  for (let i = 0; i < 8; i++) assert.deepEqual([...lut.data.slice(i * 4, i * 4 + 3)], [i & 1, (i >> 1) & 1, i >> 2]);
  const h = gpuHarness(),
    tonemap = Tonemap.attach(h.engine, {});
  tonemap.setLUT(lut);
  h.frame();
  const draw = h.pipelines.filter((p) => p.fragment?.module.code.includes('fn sampleLUT')).at(-1);
  assert.match(draw.fragment.module.code, /let edge=i32\(textureDimensions\(lut\)\.x\)-1;/, 'a 2-sample LUT is bound');
  tonemap.dispose();
});

test('parseLUTImage refuses pictures that are not strips, naming the fix', () => {
  const rgba = (width, height) => ({
    width,
    height,
    data: new Uint8Array(width * height * 4),
  });
  for (const image of [rgba(512, 512), rgba(1, 1), rgba(16, 17), rgba(66 * 66, 66)])
    assert.throws(() => parseLUTImage(image), {
      name: 'RangeError',
      message: /supply N² x N or N x N²/,
    });
  assert.throws(() => parseLUTImage({ width: 4, height: 2, data: new Uint8Array(16) }), /3 or 4 values per pixel/);
  assert.throws(() => parseLUTImage({ width: 4, height: 2, data: [0] }), {
    name: 'TypeError',
  });
  assert.throws(() => parseLUTImage(undefined), {
    name: 'TypeError',
    message: /supply a decoded image/,
  });
  const bad = strip({ Type: Float32Array, step: 0.2 });
  bad.data[0] = Number.NaN;
  assert.throws(() => parseLUTImage(bad), {
    name: 'RangeError',
    message: /finite/,
  });
});
