// Real-GPU check of ModelOutlines (@margoengine/toon/models) on Fox.glb, a skinned glTF character posed by
// @margoengine/animation's compute deformer. Takes a GPU slot itself. From the repository root, after building packages:
//   node packages/toon/test/models-check.mjs
// The hull must draw a ring around the character's silhouette and nowhere else: every outline pixel lies within the
// outline's width in pixels (plus 2 for MSAA edges) of the character, in the bind-time pose and in a later pose. The
// later pose moves the silhouette, and the earlier pose's outline lies farther than that from it in places, so a hull
// drawn from the bind-pose vertices instead of the deformed ones fails the check.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';
import { decodePNG } from '../../../tests/support/png.js';

const release = await acquire({ owner: 'toon-models' });
const context = await openBrowser({ startPath: '/packages/toon/test/models-check.html', port: 5400 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
const timer = setTimeout(() => {
  console.error('toon models-check: over its 2 minute limit');
  process.exit(1);
}, 120_000);
const WIDTH = 1.5,
  // About 3.2 px a world unit at the Fox's distance (512 px, 60 degree field of view, 140 units away).
  REACH = Math.ceil(WIDTH * 3.5) + 2;
const shot = async (share, width) => {
  const { errors } = await page.evaluate(([s, w]) => window.check.run(s, w), [share, width]);
  assert.deepEqual(errors, [], `pose ${share}, width ${width}`);
  return decodePNG(await page.locator('canvas').screenshot());
};
// The character: pixels unlike the background (the corner pixel) in the picture without outlines.
const silhouette = (image) => {
  const { width, height, data } = image,
    mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = +[0, 1, 2].some((k) => Math.abs(data[i * 4 + k] - data[k]) > 6);
  return mask;
};
const green = (image, i) => image.data[i * 4 + 1] > 150 && image.data[i * 4] < 90 && image.data[i * 4 + 2] < 90;
// Distance in pixels (chessboard) from each pixel to the nearest masked one, by two passes.
const distance = (mask, width, height) => {
  const d = new Float32Array(mask.length).map((_, i) => (mask[i] ? 0 : 1e9));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (x) d[i] = Math.min(d[i], d[i - 1] + 1);
      if (y)
        d[i] = Math.min(
          d[i],
          d[i - width] + 1,
          x ? d[i - width - 1] + 1 : 1e9,
          x + 1 < width ? d[i - width + 1] + 1 : 1e9,
        );
    }
  for (let y = height - 1; y >= 0; y--)
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (x + 1 < width) d[i] = Math.min(d[i], d[i + 1] + 1);
      if (y + 1 < height)
        d[i] = Math.min(
          d[i],
          d[i + width] + 1,
          x + 1 < width ? d[i + width + 1] + 1 : 1e9,
          x ? d[i + width - 1] + 1 : 1e9,
        );
    }
  return d;
};
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const poses = {};
  for (const share of [0.1, 0.6]) {
    const plain = await shot(share, 0),
      lined = await shot(share, WIDTH),
      mask = silhouette(plain),
      far = distance(mask, plain.width, plain.height);
    let ring = 0,
      inside = 0,
      stray = 0,
      before = 0;
    for (let i = 0; i < mask.length; i++) {
      if (green(plain, i)) before++;
      if (!green(lined, i)) continue;
      if (mask[i]) inside++;
      else ring++;
      if (far[i] > REACH) stray++;
    }
    const body = mask.reduce((a, b) => a + b, 0);
    console.log(JSON.stringify({ share, body, ring, inside, stray, before }));
    assert.equal(before, 0, 'no outline colour without ModelOutlines');
    assert.ok(body > 5000, `the Fox is on screen: ${body} pixels`);
    // A ring about the outline's width round a silhouette several hundred pixels long.
    assert.ok(ring > 600, `pose ${share}: the outline rings the silhouette, ${ring} pixels`);
    assert.equal(stray, 0, `pose ${share}: every outline pixel within ${REACH} px of the character`);
    poses[share] = { mask, far, lined };
  }
  // The pose moved the silhouette, so a hull drawn from other vertices would show: the first pose's outline pixels
  // lie farther than REACH from the second pose's character in places.
  const a = poses[0.1],
    b = poses[0.6];
  let moved = 0,
    off = 0;
  for (let i = 0; i < a.mask.length; i++) {
    if (a.mask[i] !== b.mask[i]) moved++;
    if (green(a.lined, i) && b.far[i] > REACH) off++;
  }
  console.log(JSON.stringify({ moved, off }));
  assert.ok(moved > 500, `the clip moves the Fox: ${moved} pixels`);
  assert.ok(off > 50, `an outline of the other pose would be caught: ${off} pixels off`);
  assert.deepEqual(pageErrors, []);
  console.log('toon models-check: ok');
} finally {
  clearTimeout(timer);
  await context.close();
  release();
}
