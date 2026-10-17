// Run against an existing package build, using MARGO_GPU_LOCK for the shared physical adapter.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';
import { decodePNG } from '../tests/support/png.js';

const beautyOnly = process.argv.includes('--beauty-only'),
  release = await acquire({ owner: 'section-loaded-asset-tests' }),
  output = 'test-results/section-loaded-asset',
  report = { beautyOnly, hardware: null, checks: [], failures: [], samples: [] },
  // Hand-derived projection: screen x=192+64*worldX, y=128-64*worldY.
  points = { beautyRemoved: [176, 112], beautyKept: [208, 112], shadowRemoved: [240, 112], shadowKept: [304, 112] },
  pixel = (image, [x, y]) => Array.from(image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)),
  distance = (a, b) => Math.max(...a.map((value, channel) => Math.abs(value - b[channel]))),
  brightness = (rgb) => rgb.reduce((sum, value) => sum + value, 0) / 3;
let browser;
function check(name, pass, actual) {
  report.checks.push({ name, pass, actual });
  if (!pass) report.failures.push(`${name}: ${JSON.stringify(actual)}`);
}
try {
  await mkdir(output, { recursive: true });
  browser = await openBrowser({
    startPath: `/tests/section-loaded-asset.html?samples=1&shadows=${!beautyOnly}`,
    port: 5219,
  });
  report.hardware = browser.hardware;
  assert.equal(browser.hardware.webgpu?.fallback, false, 'Physical WebGPU adapter required');
  const { page } = browser,
    pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  for (const samples of [1, 4]) {
    if (samples === 4)
      await page.goto(`http://127.0.0.1:5219/tests/section-loaded-asset.html?samples=4&shadows=${!beautyOnly}`);
    await page.waitForFunction(() => window.sectionLoadedAsset);
    async function capture(name, enabled, caster = true, visible = true) {
      const state = await page.evaluate(
          ([enabled, caster, visible]) => sectionLoadedAsset.frame(enabled, caster, visible),
          [enabled, caster, visible],
        ),
        image = await decodePNG(await page.locator('canvas').screenshot({ path: `${output}/${samples}x-${name}.png` }));
      assert.equal(state.sampleCount, samples, 'Actual render sample count');
      assert.equal(state.primitives, 1, 'Real Box.glb primitive loaded');
      assert.equal(state.coreGeometry, false, 'Loaded caster must use its glTF-pro draw path');
      assert.ok(state.vertices >= 24 && state.indices >= 36, 'Real loaded triangle buffers');
      return {
        state,
        pixels: Object.fromEntries(Object.entries(points).map(([key, point]) => [key, pixel(image, point)])),
      };
    }
    const full = await capture('full', false),
      clipped = await capture('clipped', true),
      lit = await capture('no-caster', true, false),
      blank = await capture('no-model', true, false, false),
      restored = await capture('restored', false),
      f = full.pixels,
      c = clipped.pixels,
      l = lit.pixels,
      b = blank.pixels;
    // Omitting the section hook on a PBR primitive must fail these two beauty assertions.
    check(
      `${samples}x loaded glTF beauty: removed half matches empty scene`,
      distance(c.beautyRemoved, b.beautyRemoved) <= 2,
      { clipped: c.beautyRemoved, blank: b.beautyRemoved },
    );
    check(
      `${samples}x loaded glTF beauty: removed half changes from full asset`,
      distance(f.beautyRemoved, c.beautyRemoved) >= 30,
      { full: f.beautyRemoved, clipped: c.beautyRemoved },
    );
    check(
      `${samples}x loaded glTF beauty: retained half stays rendered`,
      distance(f.beautyKept, c.beautyKept) <= 2 && distance(c.beautyKept, b.beautyKept) >= 30,
      { full: f.beautyKept, clipped: c.beautyKept, blank: b.beautyKept },
    );
    // The oblique light projects both shadow samples onto x>0, so the receiver survives clipping.
    if (!beautyOnly) {
      check(
        `${samples}x loaded glTF shadow: baseline casts on removed-half probe`,
        brightness(l.shadowRemoved) - brightness(f.shadowRemoved) >= 30,
        { full: f.shadowRemoved, lit: l.shadowRemoved },
      );
      check(
        `${samples}x loaded glTF shadow: removed half becomes lit`,
        distance(c.shadowRemoved, l.shadowRemoved) <= 3,
        {
          clipped: c.shadowRemoved,
          lit: l.shadowRemoved,
        },
      );
      check(
        `${samples}x loaded glTF shadow: retained half stays dark`,
        distance(c.shadowKept, f.shadowKept) <= 3 && brightness(l.shadowKept) - brightness(c.shadowKept) >= 30,
        { full: f.shadowKept, clipped: c.shadowKept, lit: l.shadowKept },
      );
    }
    check(
      `${samples}x loaded glTF section: disabling restores beauty and shadow`,
      Object.keys(points).every((key) => distance(restored.pixels[key], f[key]) <= 2),
      { full: f, restored: restored.pixels },
    );
    report.samples.push({ samples, state: full.state, full: f, clipped: c, lit: l, blank: b });
    await page.evaluate(() => sectionLoadedAsset.dispose());
  }
  check('No browser errors', pageErrors.length === 0, pageErrors);
  await writeFile(`${output}/gpu.json`, JSON.stringify(report, null, 2) + '\n');
  for (const { name, pass, actual } of report.checks)
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(actual)}`);
  console.log(
    `Checks ${report.checks.length}; passed ${report.checks.length - report.failures.length}; failed ${report.failures.length}`,
  );
  assert.deepEqual(report.failures, [], 'Loaded glTF section beauty and directional shadow assertions');
} finally {
  await browser?.page.evaluate(() => window.sectionLoadedAsset?.dispose()).catch(() => {});
  await browser?.close();
  release();
}
