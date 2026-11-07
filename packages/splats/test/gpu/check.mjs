// Real-GPU check of @margoengine/splats entries, run from the repository root after building packages (takes a GPU
// slot itself): node packages/splats/test/gpu/check.mjs
// ./depth: meshes drawn before a cloud hide the splats behind them (the cloud's own depth test), and with SplatDepth a
// cloud hides what later passes draw behind it, on a synthetic splat and on a real capture (raccoon, Niantic SPZ sample).
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { acquire } from '../../../../scripts/gpu-lock.mjs';
import { decodePNG } from '../../../../tests/support/png.js';

const release = await acquire({ owner: 'splats-gpu' });
const context = await openBrowser({ startPath: '/packages/splats/test/gpu/splats.html', port: 'free' }),
  { page } = context;
const report = {};
try {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 }).catch((error) => {
    throw new Error(`the page did not start: ${pageErrors.join('; ') || error.message}`);
  });
  const image = async (o) => {
    await page.evaluate((options) => window.check.build(options), o);
    const url = await page.evaluate(() => window.check.pixels());
    return decodePNG(Buffer.from(url.split(',')[1], 'base64'));
  };
  const centre = (img) => {
    const at = (img.height / 2) * img.width * 4 + img.width * 2;
    return [...img.data.subarray(at, at + 3)];
  };
  const shot = async (o) => centre(await image(o));
  const blue = [0, 0, 255];

  // ./depth, synthetic: one red splat at z 0 (opacity 0.95, sigma 0.5), meshes at z 0.5 (in front) or -0.5 (behind).
  for (const samples of [1, 4])
    for (const orthographic of [false, true]) {
      const tag = `${samples}x${orthographic ? ' orthographic' : ''}`,
        o = { samples, orthographic },
        alone = await shot(o),
        background = await shot({ ...o, none: true });
      assert.ok(alone[0] > background[0] + 100, `${tag}: the splat shows, ${alone} over ${background}`);
      // Before the cloud: the plane in front hides the splat, with or without SplatDepth; behind, the splat is on top.
      const wallFront = await shot({ ...o, before: 0.5, none: true });
      for (const depth of [false, true]) {
        assert.deepEqual(await shot({ ...o, before: 0.5, depth }), wallFront, `${tag} depth ${depth}: plane in front hides the splat`);
        const over = await shot({ ...o, before: -0.5, depth });
        assert.ok(over[0] - over[1] > 150, `${tag} depth ${depth}: the splat covers the plane behind it, ${over}`);
      }
      // After the cloud: without SplatDepth a later quad behind the splat draws over it; with it the splat hides the quad
      // exactly (the same pixels as the splat alone), and a later quad in front still draws.
      const behindOff = await shot({ ...o, after: -0.5 }),
        behindOn = await shot({ ...o, after: -0.5, depth: true }),
        frontOn = await shot({ ...o, after: 0.5, depth: true });
      report[`depth ${tag}`] = { alone, behindOff, behindOn, frontOn };
      assert.deepEqual(behindOff, blue, `${tag}: without depth the later quad covers the splat`);
      assert.deepEqual(behindOn, alone, `${tag}: with depth the splat hides the later quad behind it`);
      assert.deepEqual(frontOn, blue, `${tag}: a later quad in front of the splat still draws`);
      // Opacity is capped at 0.99, so threshold 1 writes nothing; a disposed SplatDepth writes nothing either; a splat
      // of opacity 0.4 stays under the default threshold 0.5 and writes nothing, and writes at threshold 0.3.
      assert.deepEqual(await shot({ ...o, after: -0.5, depth: true, threshold: 1 }), blue, `${tag}: threshold 1`);
      assert.deepEqual(await shot({ ...o, after: -0.5, depth: true, disposeDepth: true }), blue, `${tag}: disposed`);
      assert.deepEqual(await shot({ ...o, after: -0.5, depth: true, opacity: 0.4 }), blue, `${tag}: opacity 0.4 under 0.5`);
      assert.deepEqual(
        await shot({ ...o, after: -0.5, depth: true, opacity: 0.4, threshold: 0.3 }),
        await shot({ ...o, opacity: 0.4 }),
        `${tag}: opacity 0.4 over threshold 0.3`,
      );
      // A disposed cloud leaves SplatDepth with nothing to write and no error.
      assert.deepEqual(await shot({ ...o, after: -0.5, depth: true, disposeCloud: true }), blue, `${tag}: disposed cloud`);
    }

  // ./depth, real capture: a later plane behind the raccoon slab. Off, it covers every pixel; on, every pixel is either
  // the plane or exactly what the capture draws alone, and the capture hides the plane where it is solid.
  for (const samples of [1, 4]) {
    const alone = await image({ samples, capture: true }),
      off = await image({ samples, capture: true, afterX: 0.4 }),
      on = await image({ samples, capture: true, afterX: 0.4, depth: true }),
      front = await image({ samples, capture: true, afterX: -0.4, depth: true });
    let covered = 0,
      hidden = 0,
      offBlue = 0,
      frontBlue = 0,
      mixed = 0;
    const px = alone.width * alone.height;
    for (let i = 0; i < px; i++) {
      const a = alone.data.subarray(i * 4, i * 4 + 3),
        n = on.data.subarray(i * 4, i * 4 + 3),
        isBlue = (d) => d[0] === 0 && d[1] === 0 && d[2] === 255;
      if (a[0] + a[1] + a[2] > 30) covered++;
      if (isBlue(off.data.subarray(i * 4, i * 4 + 3))) offBlue++;
      if (isBlue(front.data.subarray(i * 4, i * 4 + 3))) frontBlue++;
      if (isBlue(n)) continue;
      if (n[0] === a[0] && n[1] === a[1] && n[2] === a[2]) hidden++;
      else mixed++;
    }
    report[`depth capture ${samples}x`] = { pixels: px, covered, hidden, offBlue, frontBlue, mixed };
    assert.equal(offBlue, px, `${samples}x: without depth the plane covers the capture`);
    assert.equal(frontBlue, px, `${samples}x: a plane in front of the capture is never hidden`);
    // MSAA can resolve an edge sample of the plane into a capture pixel; at 1x every pixel is one or the other.
    if (samples === 1) assert.equal(mixed, 0, '1x: each pixel is the plane or the capture alone');
    assert.ok(hidden > covered * 0.25, `${samples}x: the capture hides the plane where solid, ${hidden} of ${covered}`);
  }
  const errors = await page.evaluate(() => window.check.errors);
  console.log(JSON.stringify(report));
  assert.deepEqual(errors.concat(pageErrors), [], 'no GPU or shader errors');
  console.log('splats GPU check passed');
} finally {
  await context.close();
  release();
}
