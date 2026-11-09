import assert from 'node:assert/strict';
import test from 'node:test';
import { OIT_SCENE, pictureError, srgbByte, tracePixel } from '../scripts/oit-scene.mjs';

const over = (panes) => {
  const sorted = [...panes].sort((a, b) => a.z - b.z);
  let r = 0;
  let g = 0;
  let b = 0;
  for (const pane of sorted) {
    const a = pane.alpha;
    r = pane.color[0] * a + r * (1 - a);
    g = pane.color[1] * a + g * (1 - a);
    b = pane.color[2] * a + b * (1 - a);
  }
  return [srgbByte(r), srgbByte(g), srgbByte(b)];
};

test('sRGB of a half-red pane over black is the IEC encoding', () => {
  const linear = 0.5;
  const encoded = 1.055 * linear ** (1 / 2.4) - 0.055;
  assert.equal(srgbByte(linear), Math.round(encoded * 255));
  const scene = {
    ...OIT_SCENE,
    panes: [{ z: 0, color: [1, 0, 0], alpha: 0.5 }],
  };
  const hit = tracePixel(scene, (scene.width / 2) | 0, (scene.height / 2) | 0);
  assert.equal(hit.layers, 1);
  assert.deepEqual(hit.rgb, [srgbByte(0.5), 0, 0]);
});

test('the five panes sort far to near and the corner is the clear colour', () => {
  const x = (OIT_SCENE.width / 2) | 0;
  const y = (OIT_SCENE.height / 2) | 0;
  const center = tracePixel(OIT_SCENE, x, y);
  assert.equal(center.layers, 5);
  assert.deepEqual(center.rgb, over(OIT_SCENE.panes));
  const reversed = { ...OIT_SCENE, panes: [...OIT_SCENE.panes].reverse() };
  assert.deepEqual(tracePixel(reversed, x, y).rgb, center.rgb);
  const corner = tracePixel(OIT_SCENE, 0, 0);
  assert.equal(corner.layers, 0);
  assert.deepEqual(corner.rgb, [0, 0, 0]);
});

test('a picture that is the reference has no error', () => {
  const scene = { ...OIT_SCENE, width: 24, height: 16 };
  const pixels = new Uint8Array(scene.width * scene.height * 4);
  for (let y = 0; y < scene.height; y++) {
    for (let x = 0; x < scene.width; x++) {
      const ref = tracePixel(scene, x, y);
      const i = (y * scene.width + x) * 4;
      pixels[i] = ref.rgb[0];
      pixels[i + 1] = ref.rgb[1];
      pixels[i + 2] = ref.rgb[2];
      pixels[i + 3] = 255;
    }
  }
  const error = pictureError(pixels, scene);
  assert.equal(error.mae, 0);
  assert.equal(error.max, 0);
  assert.equal(error.psnr, Infinity);
  pixels[0] = 10;
  assert.ok(pictureError(pixels, scene).mae > 0);
});
