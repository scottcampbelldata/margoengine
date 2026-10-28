// Forced-compatibility parity check (roadmap milestone M2, run by `npm run test:gpu`, part of check:merge). Core's
// own WebGPU renderer draws the same scenes twice on the same GPU and browser: natively, and on the WebGL2 layer
// (install({force: true})). Each pair is read back as 8-bit RGBA and compared with the roadmap's measure (decision 4):
// per pixel d is the largest RGB channel difference; "same" is at most 0.1% of pixels with d > 2 and a mean d of at
// most 0.25. Scenes: a lit grid of instanced cubes and spheres with a mirrored mesh, a one-sided mesh and a floor, with
// core's default 4x MSAA and in exact-pixel mode (exactSize, one sample); and two views, the second with a partial
// clear (core's clear-by-draw path). Picking must pick the same meshes; a destroyed compatibility device must be
// replaced by core's device restore and draw the same picture again; WebGL2 must report no GL error.
// Run-to-run noise of each path is measured on the basic scene and printed beside the parity numbers.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const MAX_SHARE = 0.001,
  MAX_MEAN = 0.25;

const context = await openBrowser({ startPath: '/packages/webgl2-compat/test/compat-check.html', port: 'free' });
const { page } = context;
const origin = new URL(page.url()).origin;
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});

/** Loads one scene and returns its pixels (RGBA, 400 x 300) and the page's report. */
async function render(mode, scene, exact) {
  await page.goto(
    `${origin}/packages/webgl2-compat/test/compat-check.html?mode=${mode}&scene=${scene}&exact=${exact ? 1 : 0}`,
  );
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const info = await page.evaluate(() => window.check.info());
  assert.deepEqual(info.errors, [], `${mode} ${scene}: page errors`);
  assert.equal(info.vendor === 'margo-webgl2', mode === 'compat', `${mode} ${scene}: adapter vendor ${info.vendor}`);
  const image = await decodePNG(await page.locator('canvas').screenshot());
  return { image, info };
}

/** Decision 4 of the roadmap: share of pixels with d > 2 and mean d, d the largest RGB difference. */
function compare(a, b) {
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let over = 0,
    sum = 0,
    max = 0;
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
  }
  return { share: over / n, mean: sum / n, max };
}

const fmt = (m) => `${(m.share * 100).toFixed(3)}% over 2, mean ${m.mean.toFixed(3)}, max ${m.max}`;
const results = [];
try {
  for (const [scene, exact] of [
    ['basic', false],
    ['basic', true],
    ['views', false],
  ]) {
    const native = await render('native', scene, exact);
    const compat = await render('compat', scene, exact);
    assert.equal(await page.evaluate(() => window.check.glError()), 0, `${scene}: WebGL2 reported a GL error`);
    const m = compare(native.image, compat.image);
    // The picture must not be empty: a black canvas on both sides would compare equal.
    let lit = 0;
    for (let i = 0; i < compat.image.data.length; i += 4)
      if (compat.image.data[i] + compat.image.data[i + 1] + compat.image.data[i + 2] > 120) lit++;
    assert.ok(lit > 20000, `${scene}: only ${lit} lit pixels`);
    results.push(`${scene}${exact ? ' exact-pixel' : ' 4x MSAA'}: ${fmt(m)}`);
    assert.ok(
      m.share <= MAX_SHARE && m.mean <= MAX_MEAN,
      `${scene}${exact ? ' exact' : ''}: compat differs from native: ${fmt(m)}`,
    );
  }

  // Run-to-run noise of each path on the basic scene.
  for (const mode of ['native', 'compat']) {
    const a = await render(mode, 'basic', false),
      b = await render(mode, 'basic', false);
    results.push(`noise ${mode} (basic, 4x MSAA): ${fmt(compare(a.image, b.image))}`);
  }

  // Picking: the same meshes under the same pixels.
  const points = [];
  for (let y = 15; y < 300; y += 30) for (let x = 20; x < 400; x += 40) points.push([x, y]);
  const picks = {};
  for (const mode of ['native', 'compat']) {
    await render(mode, 'basic', false);
    picks[mode] = await page.evaluate((p) => window.check.pick(p), points);
  }
  assert.deepEqual(picks.compat, picks.native, 'compat picks differ from native picks');
  assert.ok(new Set(picks.native.filter(Boolean)).size >= 8, `too few meshes hit: ${picks.native}`);
  results.push(
    `picking: ${picks.compat.filter(Boolean).length} hits and ${picks.compat.filter((x) => !x).length} misses, same as native`,
  );

  // Device loss: core restores the device through the layer and draws the same picture.
  const before = await render('compat', 'basic', false);
  const lost = await page.evaluate(() => window.check.lose());
  assert.deepEqual(lost, { restored: true, vendor: 'margo-webgl2' });
  const after = await decodePNG(await page.locator('canvas').screenshot());
  const m = compare(before.image, after);
  results.push(`device loss: restored, ${fmt(m)} against before`);
  assert.ok(m.share <= MAX_SHARE && m.mean <= MAX_MEAN, `after device loss: ${fmt(m)}`);
  assert.equal(await page.evaluate(() => window.check.glError()), 0, 'restored device: GL error');

  // WGSL semantics: 32 probe cases computed from runtime inputs, bit for bit (test/semantics.html).
  await page.goto(`${origin}/packages/webgl2-compat/test/semantics.html`);
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const probe = await page.evaluate(() => window.probe());
  assert.deepEqual(probe.native.errors, [], 'semantics probe: native errors');
  assert.deepEqual(probe.compat.errors, [], 'semantics probe: compat errors');
  assert.equal(probe.compat.glError, 0, 'semantics probe: GL error');
  const differ = [];
  for (let c = 0; c < 32; c++) {
    const a = probe.native.out.slice(c * 4, c * 4 + 4),
      b = probe.compat.out.slice(c * 4, c * 4 + 4);
    if (a.some((v, i) => v !== b[i]))
      differ.push(`case ${c}: native ${a.map((v) => v.toString(16))} compat ${b.map((v) => v.toString(16))}`);
  }
  assert.deepEqual(differ, [], 'semantics probe: compat differs from native');
  results.push(
    'semantics probe: 32 cases (integer division, shifts, conversions, bit and pack built-ins, uniform layouts, loops, switch, pointers) bit-identical',
  );

  assert.deepEqual(pageErrors, []);
  console.log(`webgl2-compat parity (core on WebGL2 vs native WebGPU, same GPU):\n  ${results.join('\n  ')}`);
} finally {
  await context.close();
}
