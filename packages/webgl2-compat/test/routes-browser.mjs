// Milestone M6 package routes check (run by `npm run test:gpu`, part of check:merge). Each package with a route of its
// own on the WebGL2 layer draws the same scene natively and on the layer (install({force: true})), in exact-pixel
// mode on the same GPU and browser: DOF (its CoC and bokeh kernels as fragment draws), splats (the depth sort as one
// CPU dispatch), CulledInstances, CulledMeshes and DynamicInstances (frustum culling on the CPU, no compute). On the layer the page
// renders until a frame's dispatches are exactly the route's, then the canvases are compared with the roadmap's
// measure (decision 4: at most 0.1% of pixels with d > 2, mean d at most 0.25, d the largest RGB difference). Neither
// side may report a page error; the layer must report no GL error. Frame times of both are printed.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const MAX_SHARE = 0.001,
  MAX_MEAN = 0.25;
const context = await openBrowser({ startPath: '/packages/webgl2-compat/test/routes.html', port: 'free' });
const { page } = context;
const origin = new URL(page.url()).origin;
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});

async function render(mode, name) {
  await page.goto(`${origin}/packages/webgl2-compat/test/routes.html?mode=${mode}&case=${name}`);
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  assert.deepEqual((await page.evaluate(() => window.check.info())).errors, [], `${mode} ${name}: page errors`);
  const route = await page.evaluate(() => window.check.route());
  const image = await decodePNG(await page.locator('canvas').screenshot());
  const ms = await page.evaluate(() => window.check.time());
  const info = await page.evaluate(() => window.check.info());
  assert.deepEqual(info.errors, [], `${mode} ${name}: page errors`);
  assert.equal(info.vendor === 'margo-webgl2', mode === 'compat', `${mode} ${name}: adapter vendor ${info.vendor}`);
  assert.equal(info.gl, 0, `${mode} ${name}: WebGL2 reported a GL error`);
  return { image, route, ms };
}

function compare(a, b) {
  let over = 0,
    sum = 0,
    max = 0,
    lit = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const d = Math.max(
      Math.abs(a.data[o] - b.data[o]),
      Math.abs(a.data[o + 1] - b.data[o + 1]),
      Math.abs(a.data[o + 2] - b.data[o + 2]),
    );
    if (d > 2) over++;
    sum += d;
    max = Math.max(max, d);
    if (b.data[o] + b.data[o + 1] + b.data[o + 2] > 60) lit++;
  }
  return { share: over / n, mean: sum / n, max, lit };
}

try {
  for (const name of ['dof', 'splats', 'instances', 'meshes', 'dynamic']) {
    const native = await render('native', name);
    const compat = await render('compat', name);
    const m = compare(native.image, compat.image);
    assert.ok(m.lit > 5000, `${name}: only ${m.lit} lit pixels; the scene must not be empty`);
    console.log(
      `${name}: ${(m.share * 100).toFixed(3)}% over 2, mean ${m.mean.toFixed(3)}, max ${m.max}; route after ` +
        `${compat.route.frames} frame(s), ${JSON.stringify(compat.route.dispatches)} per frame, ` +
        `${compat.route.stalls} stall(s); frame ${native.ms.toFixed(2)} ms native, ${compat.ms.toFixed(2)} ms on the layer`,
    );
    assert.ok(m.share <= MAX_SHARE && m.mean <= MAX_MEAN, `${name}: the layer's pixels differ from native WebGPU`);
  }
  assert.deepEqual(pageErrors, []);
  console.log('package routes check passed');
} finally {
  await context.close();
}
