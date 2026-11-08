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
  REACH = Math.ceil(WIDTH * 3.5) + 2,
  // The box: about 74 px a world unit (2 units across, 7 away); width 0.1 smoothed is 0.1 / sqrt(3) a side, 4.3 px.
  BAND = 2;
const shot = async (share, width, style) => {
  const { errors } = await page.evaluate(([s, w, st]) => window.check.run(s, w, true, st), [share, width, style]);
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
    poses[share] = { mask, far, lined, ring };
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
  // Seam-free: a hard-edged box's hull faces part at its edges without smooth, leaving notches in the ring; with
  // smooth every copy of a corner moves the same way, so the band of BAND px round the silhouette is all outline.
  const box = async (width, smooth, style, paint) => {
    const { errors } = await page.evaluate(
      ([w, s, st, p]) => window.check.box(w, s, st, p),
      [width, smooth, style, paint],
    );
    assert.deepEqual(errors, [], `box ${width} ${smooth}`);
    return decodePNG(await page.locator('canvas').screenshot());
  };
  const plain = await box(0, true),
    mask = silhouette(plain),
    near = distance(mask, plain.width, plain.height),
    holes = {};
  for (const smooth of [false, true]) {
    const lined = await box(0.1, smooth);
    let n = 0;
    for (let i = 0; i < mask.length; i++) if (!mask[i] && near[i] <= BAND && !green(lined, i)) n++;
    holes[smooth] = n;
  }
  console.log(JSON.stringify({ box: mask.reduce((a, b) => a + b, 0), holes }));
  assert.ok(holes.false > 100, `hard edges part the hull without smooth: ${holes.false} pixels`);
  assert.equal(holes.true, 0, 'smooth closes the ring');
  // Per material: the Fox's material by name draws its own colour (red) and width, and 0 takes its line away.
  const name = await page.evaluate(() => window.check.material());
  assert.equal(typeof name, 'string', 'the Fox material has a name');
  const red = (image, i) => image.data[i * 4] > 150 && image.data[i * 4 + 1] < 90 && image.data[i * 4 + 2] < 90;
  const count = (image, test) => {
    let n = 0;
    for (let i = 0; i < image.width * image.height; i++) if (test(image, i)) n++;
    return n;
  };
  const styled = await shot(0.1, WIDTH, { materials: { [name]: { outline: WIDTH * 2, color: [1, 0, 0] } } }),
    none = await shot(0.1, WIDTH, { materials: { [name]: { outline: 0 } } }),
    plainFox = await shot(0.1, 0),
    reds = count(styled, red),
    redBefore = count(plainFox, red);
  console.log(
    JSON.stringify({ material: name, reds, redBefore, greens: count(styled, green), none: count(none, green) }),
  );
  assert.equal(count(styled, green), 0, 'the material style replaces the default colour');
  assert.ok(reds - redBefore > poses[0.1].ring * 1.3, `a red line twice as wide: ${reds - redBefore} pixels`);
  assert.equal(count(none, green), 0, 'outline 0 on the material: no line');
  // Vertex colours: alpha scales the width (0: no line), RGB tints the colour (white line, red paint: red).
  // Outside the box only: the paint tints the box itself too.
  const outside = (test) => (image, i) => !mask[i] && test(image, i),
    lineOf = async (paint, style) =>
      count(await box(0.1, true, { vertexColors: true, ...style }, paint), outside(green)),
    unpainted = await lineOf([0, 1, 0, 1]),
    thin = await lineOf([0, 1, 0, 0]),
    tinted = await box(0.1, true, { vertexColors: true, color: [1, 1, 1] }, [1, 0, 0, 1]);
  console.log(JSON.stringify({ unpainted, thin, tinted: count(tinted, outside(red)) }));
  assert.ok(unpainted > 300, `green paint keeps a green line: ${unpainted}`);
  assert.equal(thin, 0, 'alpha 0: no line');
  assert.ok(count(tinted, outside(red)) > 300, 'red paint on a white line draws red');
  assert.equal(count(tinted, outside(green)), 0);
  assert.deepEqual(pageErrors, []);
  console.log('toon models-check: ok');
} finally {
  clearTimeout(timer);
  await context.close();
  release();
}
