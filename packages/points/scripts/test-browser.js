import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const results = resolve(root, 'test-results');
await mkdir(results, { recursive: true });
const server = await createServer({
  configFile: resolve(root, 'vite.config.js'),
  logLevel: 'error',
  server: { port: 0 },
});
await server.listen();
let browser;
try {
  const channel = process.env.BROWSER_CHANNEL ?? 'msedge';
  const args = process.env.BROWSER_ARGS ? JSON.parse(process.env.BROWSER_ARGS) : [];
  try {
    browser = await chromium.launch({
      headless: true,
      channel: channel === 'bundled' ? undefined : channel,
      executablePath: process.env.BROWSER_EXECUTABLE,
      args,
    });
  } catch (error) {
    if (channel !== 'msedge' || args.length || process.env.BROWSER_CHANNEL) throw error;
    browser = await chromium.launch({ headless: true });
  }
  for (const samples of [1, 4]) {
    const page = await browser.newPage({
      viewport: { width: 700, height: 700 },
      deviceScaleFactor: 1,
      ...(samples === 1 ? { userAgent: 'iPhone Mobile' } : {}),
    });
    page.setDefaultTimeout(600_000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(`${server.resolvedUrls.local[0]}tests/points.html`);
    await page.waitForFunction(() => typeof window.runPointTests === 'function');
    const report = await page.evaluate(() => window.runPointTests());
    assert.equal(report.samples, samples);
    report.gallery = await page.evaluate(() => window.runGallery());
    assert.deepEqual(report.gallery.errors, []);
    assert.ok(report.gallery.lit > 20000, `Gallery drew too little: ${report.gallery.lit} pixels`);
    report.checks.push(
      'Gallery (EDL terrain, sphere impostors, round and textured points, atlas sprites) renders without validation errors',
    );
    await page
      .locator('#gallery')
      .screenshot({ path: resolve(results, samples === 4 ? 'points-gallery.png' : 'points-gallery-mobile.png') });
    if (samples === 4) {
      // LAS written and read back, classification colours, octree LOD under a 400,000-point budget.
      const octree = (report.octree = await page.evaluate(() => window.runOctree()));
      assert.deepEqual(octree.errors, []);
      assert.equal(octree.count, 1_200_000);
      for (const view of [octree.far, octree.close]) {
        assert.ok(view.drawn > 0 && view.drawn <= 400_000, `octree drew ${view.drawn} points`);
        assert.ok(view.lit > 0.05, `octree view drew too little: ${view.lit}`);
      }
      assert.ok(
        octree.close.depth > octree.far.depth,
        `flying in refines: ${octree.far.depth} -> ${octree.close.depth}`,
      );
      report.checks.push(
        'LAS round trip, class colours and OctreeCloud LOD stay under the point budget and refine as the camera flies in',
      );
    }
    report.browser = browser.version();
    assert.deepEqual(errors, []);
    await writeFile(
      resolve(results, samples === 4 ? 'points-browser.json' : 'points-browser-mobile.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
    console.log(`${report.checks.length} browser checks passed`);
    await page.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
