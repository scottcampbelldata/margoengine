// Real-GPU check of DOFLens and Autofocus on the WebGL2 compatibility layer (`@margoengine/webgl2-compat`,
// install({force: true})). Takes a GPU slot itself. From the repository root, after building packages:
//   node packages/dof/tests/gpu/compat-check.mjs
// Each case of lens.js draws natively and on the layer, on the same GPU and browser, and the canvases are compared
// with the layer roadmap's measure (decision 4: at most 0.1% of pixels with d > 2, mean d at most 0.25, d the largest
// RGB difference), and every bokeh must cover the same pixels within 1 px each way. The scene before the blur ('sharp')
// and a one-sample capture ('focus 1x') must match exactly: every difference left comes from the layer reading a
// multisampled depth as one sample, which DOF's WebGL2 route widens back over silhouettes (src/compat.ts; measured
// on the M6 Mac mini, Metal: 0.02% to 0.09% of pixels with d > 2, mean d at most 0.018; before that fix the 'focus'
// case, no lens, drew a faint ring 72 px wide where native WebGPU draws 31). Autofocus must find the same focus on
// both. Temporal DOF also draws on the layer through independent half-image and tile-max passes.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { acquire } from '../../../../scripts/gpu-lock.mjs';
import { decodePNG } from '../../../../tests/support/png.js';

const MAX_SHARE = 0.001,
  MAX_MEAN = 0.25;
const release = await acquire({ owner: 'dof-compat' });
const context = await openBrowser({ startPath: '/packages/dof/tests/gpu/lens.html', port: 5289, compat: false }),
  { page } = context;
try {
  const origin = new URL(page.url()).origin,
    pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });
  const compare = (a, b) => {
    let over = 0,
      sum = 0,
      max = 0;
    const n = a.width * a.height;
    for (let i = 0; i < n; i++) {
      const o = i * 4,
        d = Math.max(
          Math.abs(a.data[o] - b.data[o]),
          Math.abs(a.data[o + 1] - b.data[o + 1]),
          Math.abs(a.data[o + 2] - b.data[o + 2]),
        );
      if (d > 2) over++;
      sum += d;
      max = Math.max(max, d);
    }
    return { share: over / n, mean: sum / n, max };
  };
  // The bright part's bounds (red above 12, as lens-check.mjs measures a bokeh), equal within 1 px each way.
  const sameExtent = (a, b) => {
    const box = (image) => {
      const e = [Infinity, Infinity, -1, -1];
      for (let y = 0; y < image.height; y++)
        for (let x = 0; x < image.width; x++)
          if (image.data[(y * image.width + x) * 4] > 12) {
            e[0] = Math.min(e[0], x);
            e[1] = Math.min(e[1], y);
            e[2] = Math.max(e[2], x);
            e[3] = Math.max(e[3], y);
          }
      return e;
    };
    const p = box(a),
      q = box(b);
    return p.every((v, k) => Math.abs(v - q[k]) <= 1);
  };
  const clip = 2.8 / (10 * Math.tan((25 * Math.PI) / 180)),
    focal = 10 * (1 + Math.tan(0.5) * clip * Math.tan((25 * Math.PI) / 180));
  const cases = [
    ['sharp', 'sharp', []],
    ['round', 'blades', [0]],
    ['blades', 'blades', [5]],
    ['aperture', 'aperture', [true]],
    ['tilt', 'tilt', [0.5, focal]],
    ['focus', 'tilt', [null, 11.53]],
    ['focus 1x', 'tilt', [null, 11.53, 32, true]],
    ['anamorphic', 'optics', [0, 0, 0, 2, 6]],
    ['cat eye', 'optics', [0.9, 0.9, 1.5, 1, undefined, 0.03]],
  ];
  const run = async (mode) => {
    await page.goto(`${origin}/packages/dof/tests/gpu/lens.html?mode=${mode}`);
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const focus = await page.evaluate(() => window.check.autofocus()),
      images = {};
    for (const [name, fn, args] of cases) {
      await page.evaluate(([f, a]) => window.check[f](...a), [fn, args]);
      images[name] = await decodePNG(await page.locator('canvas').screenshot());
    }
    const vendor = await page.evaluate(() => window.check.vendor()),
      temporal = await page.evaluate(() =>
        window.check.temporal(true, false, 2).then(
          () => 'drawn',
          (e) => e.message,
        ),
      );
    return { focus, images, vendor, temporal, errors: await page.evaluate(() => window.check.errors.splice(0)) };
  };
  const native = await run('native'),
    compat = await run('compat');
  assert.notEqual(native.vendor, 'margo-webgl2', 'native runs on WebGPU');
  assert.equal(compat.vendor, 'margo-webgl2', 'compat runs on the layer');
  console.log('autofocus', JSON.stringify({ native: native.focus, compat: compat.focus }));
  for (const key of ['middle', 'side', 'target'])
    assert.ok(Math.abs(native.focus[key] - compat.focus[key]) < 1e-3, `autofocus ${key} matches on the layer`);
  const failed = [],
    extents = [];
  for (const [name] of cases) {
    const m = compare(native.images[name], compat.images[name]);
    console.log(`dof compat ${name}: ${JSON.stringify(m)}`);
    extents.push(...(sameExtent(native.images[name], compat.images[name]) ? [] : [name]));
    failed.push(...(m.share <= MAX_SHARE && m.mean <= MAX_MEAN ? [] : [name]));
  }
  assert.deepEqual(failed, [], "the layer's pixels match native");
  console.log('extents differ', extents);
  assert.deepEqual(extents, [], 'every bokeh covers the same pixels on the layer');
  assert.equal(compare(native.images.sharp, compat.images.sharp).max, 0, 'the scene before the blur is the same');
  assert.equal(
    compare(native.images['focus 1x'], compat.images['focus 1x']).max,
    0,
    'a one-sample capture blurs the same',
  );
  assert.equal(native.temporal, 'drawn');
  assert.equal(compat.temporal, 'drawn', 'temporal DOF draws on the full layer');
  assert.deepEqual([...native.errors, ...compat.errors], []);
  assert.deepEqual(pageErrors, []);
  console.log('dof compat check passed');
} finally {
  // fixed-wait: a bounded close, so a browser that hangs while closing cannot hold the GPU slot past 15 s
  await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 15000).unref())]);
  release();
}
