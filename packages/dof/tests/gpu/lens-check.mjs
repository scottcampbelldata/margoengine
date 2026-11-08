// Real-GPU check for Autofocus and DOFLens. Takes a GPU slot itself. From the repository root, after building packages:
//   node packages/dof/tests/gpu/lens-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { acquire } from '../../../../scripts/gpu-lock.mjs';
import { decodePNG } from '../../../../tests/support/png.js';

const release = await acquire({ owner: 'dof-lens' });
const context = await openBrowser({ startPath: '/packages/dof/tests/gpu/lens.html', port: 5283 }),
  { page } = context;
try {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const shot = async () => decodePNG(await page.locator('canvas').screenshot());
  // Bright pixels: their extent from a centre in each direction, inside rows or columns near a band.
  const bright = (image, top = 0, bottom = image.height) => {
    let up = Infinity,
      down = -1,
      left = Infinity,
      right = -1,
      count = 0;
    for (let y = top; y < bottom; y++)
      for (let x = 0; x < image.width; x++)
        if (image.data[(y * image.width + x) * 4] > 12) {
          count++;
          up = Math.min(up, y);
          down = Math.max(down, y);
          left = Math.min(left, x);
          right = Math.max(right, x);
        }
    return { up, down, left, right, count, height: down - up + 1, width: right - left + 1 };
  };

  const focus = await page.evaluate(() => window.check.autofocus());
  console.log('autofocus', JSON.stringify(focus));
  assert.ok(Math.abs(focus.middle - 5.5) < 0.1, `middle pixel focuses on the near box, got ${focus.middle}`);
  assert.ok(Math.abs(focus.side - 14.5) < 0.2, `side pixel focuses on the far box, got ${focus.side}`);
  assert.ok(Math.abs(focus.target - 3) < 1e-3, `world target focuses at its distance, got ${focus.target}`);

  await page.evaluate(() => window.check.blades(0));
  const round = bright(await shot());
  await page.evaluate(() => window.check.blades(3));
  const triangle = bright(await shot());
  const middle = 256;
  const lopsided = (s) => Math.abs(middle - s.up - (s.down - middle));
  console.log('round', JSON.stringify(round), 'triangle', JSON.stringify(triangle));
  assert.ok(round.width > 20, 'the near box is blurred');
  assert.ok(lopsided(round) <= 3, `a round disk is even, got ${lopsided(round)}`);
  assert.ok(lopsided(triangle) >= 6, `three blades are lopsided, got ${lopsided(triangle)}`);
  assert.ok(triangle.count < round.count, 'the polygon lies inside the disk');

  // An aperture image: all open, it matches the round disk; its left half alone spreads the near bokeh to the left.
  await page.evaluate(() => window.check.aperture(false));
  const open = bright(await shot());
  await page.evaluate(() => window.check.aperture(true));
  const half = bright(await shot());
  const sideways = (s) => middle - s.left - (s.right - middle);
  console.log('aperture open', JSON.stringify(open), 'half', JSON.stringify(half));
  assert.ok(Math.abs(open.width - round.width) <= 2 && Math.abs(sideways(open)) <= 3, 'an open aperture is the disk');
  assert.ok(sideways(half) >= 8, `a left-half aperture spreads left, got ${sideways(half)}`);
  assert.ok(Math.abs(half.height - open.height) <= 2, 'and keeps the full height');

  // Clip y of the boxes: 2.8 / (10 tan 25 degrees). The plane runs through the top box and recedes downwards, so the
  // bottom box lies in the near field, where blur spreads over the background.
  const clip = 2.8 / (10 * Math.tan((25 * Math.PI) / 180)),
    tilt = 0.5,
    t = Math.tan(tilt) * clip * Math.tan((25 * Math.PI) / 180),
    focal = 10 * (1 + t);
  await page.evaluate(([a, b]) => window.check.tilt(a, b), [tilt, focal]);
  const tilted = await shot();
  const topBox = bright(tilted, 0, 256),
    bottomBox = bright(tilted, 256, 512);
  console.log('tilt', JSON.stringify({ topBox, bottomBox, focal }));
  assert.ok(bottomBox.width > topBox.width + 10, 'the tilted plane holds the top box in focus, not the bottom one');
  await page.evaluate(([a, b]) => window.check.tilt(a, b), [0, focal]);
  const flat = await shot();
  const flatTop = bright(flat, 0, 256),
    flatBottom = bright(flat, 256, 512);
  console.log('flat', JSON.stringify({ flatTop, flatBottom }));
  assert.ok(Math.abs(flatTop.width - flatBottom.width) <= 2, 'no tilt: both boxes blur alike');
  assert.ok(flatTop.width > topBox.width + 5, 'no tilt: the top box is out of focus');

  // Anamorphic: a 2x squeeze halves the near disk's width and keeps its height (the box itself is about 18 px across,
  // its blur 15 px further each way, so 48 px becomes about 18 + 15 = 33 px wide).
  const optics = async (...args) => {
    await page.evaluate((a) => window.check.optics(...a), args);
    return shot();
  };
  const oval = bright(await optics(0, 0, 0, 2));
  console.log('anamorphic', JSON.stringify(oval));
  assert.ok(Math.abs(oval.height - round.height) <= 2, 'the oval keeps the disk height');
  assert.ok(oval.width <= round.width - 10 && oval.width >= 26, `the oval is narrower, got ${oval.width}`);
  const polygon = bright(await optics(0, 0, 0, 2, 6));
  assert.ok(Math.abs(polygon.height - oval.height) <= 6 && polygon.width < round.width - 8, 'six blades squeezed too');
  // Cat's eye: a box towards the top-right corner, measured along the diagonal (radial) and across it (tangential).
  const spans = (image) => {
    const along = [Infinity, -Infinity],
      across = [Infinity, -Infinity];
    for (let y = 0; y < image.height; y++)
      for (let x = 0; x < image.width; x++)
        if (image.data[(y * image.width + x) * 4] > 12) {
          const r = (x - y) / Math.SQRT2,
            t = (x + y) / Math.SQRT2;
          along[0] = Math.min(along[0], r);
          along[1] = Math.max(along[1], r);
          across[0] = Math.min(across[0], t);
          across[1] = Math.max(across[1], t);
        }
    return { radial: along[1] - along[0], tangential: across[1] - across[0] };
  };
  const plainCorner = spans(await optics(0.9, 0.9, 0, 1, undefined, 0.03)),
    eyeCorner = spans(await optics(0.9, 0.9, 1.5, 1, undefined, 0.03)),
    eyeMiddle = bright(await optics(0, 0, 1.5, 1));
  console.log('cat eye', JSON.stringify({ plainCorner, eyeCorner, eyeMiddle }));
  assert.ok(Math.abs(plainCorner.radial - plainCorner.tangential) <= 3, 'without cat eye the corner disk is round');
  // The box sits 0.65 of the way to the corner, so the barrel circle is 0.97 radii off: the shared lens is 1.03 radii
  // wide along the radius and 1.75 long across it, about 23 and 34 px with the 5.5 px box's own 7.8 px diagonal.
  assert.ok(eyeCorner.radial <= eyeCorner.tangential * 0.85, 'the cat eye is narrow across the radius');
  assert.ok(eyeCorner.radial <= plainCorner.radial - 8, 'narrower than the plain disk there');
  assert.ok(Math.abs(eyeMiddle.width - round.width) <= 2, 'and round at the frame centre');

  // Temporal DOF: the half-resolution gather against the full one. Mean absolute difference over all channels of the
  // 512 x 512 frame; the box in focus (the middle 40 x 40) must be untouched, byte for byte.
  const diff = (a, b, x0 = 0, y0 = 0, x1 = a.width, y1 = a.height) => {
    let sum = 0,
      n = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++)
        for (let c = 0; c < 3; c++, n++)
          sum += Math.abs(a.data[(y * a.width + x) * 4 + c] - b.data[(y * a.width + x) * 4 + c]);
    return sum / n;
  };
  const temporal = async (on, taa, frames) => {
    await page.evaluate(([a, b, c]) => window.check.temporal(a, b, c), [on, taa, frames]);
    return shot();
  };
  const next = async () => {
    await page.evaluate(() => window.check.more(1));
    return shot();
  };
  const full = await temporal(false, false, 4),
    fullNext = await next(),
    halfImage = await temporal(true, false, 4),
    halfNext = await next(),
    fullTaa = await temporal(false, true, 40),
    halfTaa = await temporal(true, true, 40);
  const numbers = {
    half: diff(halfImage, full),
    focus: diff(halfImage, full, 236, 236, 276, 276),
    fullSteady: diff(full, fullNext),
    turn: diff(halfImage, halfNext),
    taa: diff(halfTaa, fullTaa),
    taaFocus: diff(halfTaa, fullTaa, 236, 236, 276, 276),
  };
  console.log('temporal', JSON.stringify(numbers));
  // Bounds: blur at half resolution moves single edge pixels by up to a level's worth on average over the frame; in
  // focus the join takes the full-resolution scene as it is.
  assert.ok(numbers.half < 1 && numbers.taa < 1, 'the half gather stays within a level of the full one on average');
  assert.equal(numbers.focus, 0, 'in focus, the temporal frame is the sharp scene');
  assert.equal(numbers.taaFocus, 0, 'and under TAA too');
  assert.equal(numbers.fullSteady, 0, 'the full gather repeats itself frame to frame');
  assert.ok(numbers.turn > 0, 'the temporal taps turn from one frame to the next');

  assert.deepEqual(await page.evaluate(() => window.check.errors), []);
  assert.deepEqual(pageErrors, []);
  console.log('dof lens check passed');
} finally {
  // fixed-wait: a bounded close, so a browser that hangs while closing cannot hold the GPU slot past 15 s
  await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 15000).unref())]);
  await release();
}
