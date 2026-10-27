// The parts of scripts/quickstart-timing.mjs that need no browser: the reference scenes it derives from the README, and
// the pixel measurements it asserts with. (The whole protocol runs in `npm run check:quickstart`.)
import assert from 'node:assert/strict';
import test from 'node:test';
import { VARIANTS, findBall, sharpEdges, shadowOf } from '../scripts/quickstart-timing.mjs';
import { quickstartFiles } from '../scripts/support/doc-snippets.mjs';

const main = quickstartFiles()['main.ts'];

test('each reference scene is the README program with exactly one thing taken away', () => {
  assert.ok(main.includes('shadows.add(mesh)') && main.includes('map: checker') && main.includes('rotation.y +='));
  const noShadow = VARIANTS.noshadow(main),
    noTexture = VARIANTS.notexture(main),
    frozen = VARIANTS.frozen(main);
  assert.ok(!noShadow.includes('shadows.add(mesh)') && noShadow.includes('map: checker'));
  assert.ok(!noTexture.includes('map: checker') && noTexture.includes('shadows.add(mesh)'));
  for (const code of [frozen, noShadow, noTexture]) assert.ok(!code.includes('rotation.y +='));
  // Still one program: the texture variant keeps its colour materials and `createMesh` calls well formed.
  assert.doesNotMatch(noTexture, /\{\s*,/);
});

/** A picture of `width x height`: floor luminance 140, a teal ball box, and a darker patch. */
function picture({ patch = false } = {}) {
  const width = 200,
    height = 120,
    rgb = new Uint8Array(width * height * 3),
    lum = new Float32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const k = y * width + x;
      let [r, g, b] = [140, 140, 140];
      if (x >= 80 && x < 120 && y >= 20 && y < 60) [r, g, b] = [100, 210, 180];
      else if (patch && x >= 125 && x < 170 && y >= 62 && y < 90) [r, g, b] = [50, 50, 50];
      rgb.set([r, g, b], k * 3);
      lum[k] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
  return { width, height, rgb, lum };
}

test('the ball is found by its colour and a darker floor patch beside it is the shadow', () => {
  const off = picture(),
    on = picture({ patch: true }),
    ball = findBall(off);
  assert.deepEqual([ball.x0, ball.x1, ball.y0, ball.y1], [80, 119, 20, 59]);
  const shadow = shadowOf(on, off, ball);
  assert.equal(shadow.n, 45 * 28);
  assert.ok(shadow.cy > ball.cy && shadow.lumOn < shadow.lumOff * 0.5);
  assert.equal(shadowOf(off, off, ball).n, 0, 'no shadow when the pictures are equal');
  assert.equal(findBall({ ...off, rgb: new Uint8Array(off.rgb.length).fill(140) }), null);
});

test('sharp edges are counted only where neighbouring pixels jump', () => {
  const flat = picture(),
    stripes = picture();
  for (let y = 0; y < 120; y++) for (let x = 0; x < 200; x += 2) stripes.lum[y * 200 + x] = 235;
  assert.equal(sharpEdges(flat, 100, 110, 20), 0);
  assert.ok(sharpEdges(stripes, 100, 110, 20) > 10 * 190);
});
