import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { compatRun, compatShim, compatUrl } from '../../../scripts/support/compat-shim.js';
import { createServer } from 'vite';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

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
  const args = process.env.BROWSER_ARGS ? JSON.parse(process.env.BROWSER_ARGS) : [];
  browser = await launchBrowser({
    headless: true,
    args,
  });
  // On the WebGL2 compatibility layer (--compat) only the single-sample path: the 4x eye-dome lighting compares
  // matching coverage samples per sample (@builtin(sample_index)), and per-sample shading is out of scope on WebGL2
  // (docs/webgl2-compat-roadmap.md, "Out of scope"); the layer reads the resolved, averaged texel instead.
  for (const samples of compatRun() ? [1] : [1, 4]) {
    const page = await browser.newPage({
      viewport: { width: 700, height: 700 },
      deviceScaleFactor: 1,
      ...(samples === 1 ? { userAgent: 'iPhone Mobile' } : {}),
    });
    // --compat: the page runs on the WebGL2 compatibility layer (scripts/support/compat-shim.js).
    if (compatRun()) await page.addInitScript(compatShim, compatUrl());
    page.setDefaultTimeout(600_000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(`${server.resolvedUrls.local[0]}tests/points.html`);
    await page.waitForFunction(() => typeof window.runPointTests === 'function' && typeof window.runFeatures === 'function');
    const report = await page.evaluate(() => window.runPointTests());
    assert.equal(report.samples, samples);
    report.checks.push(...(await page.evaluate(() => window.runFeatures())));
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
  await closeAll({ browser, servers: [server] });
}
