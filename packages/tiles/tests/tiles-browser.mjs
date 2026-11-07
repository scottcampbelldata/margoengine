// Real-GPU check of @margoengine/tiles (from the repository root after building packages; takes a shared GPU slot):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/tiles/tests/tiles-browser.mjs
// tiles-browser.ts streams a generated city-scale tileset (1365 b3dm tiles over 8 km, in ECEF) through gltf-pro and
// the engine; this script checks selection, drawing, placement precision, eviction and disposal. Every case has a
// time limit. Results go to test-results/tiles-browser.json.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const CASE_TIMEOUT = 120_000;
const release = await acquire({ owner: 'tiles-browser' });
const context = await openBrowser({ startPath: '/packages/tiles/tests/tiles.html', port: 5253 });
const { page, hardware } = context,
  pageErrors = [],
  results = {},
  checks = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
page.setDefaultTimeout(CASE_TIMEOUT);
async function call(expression, name) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`tiles case ${name} took over ${CASE_TIMEOUT / 1000} s`)), CASE_TIMEOUT);
  });
  try {
    return await Promise.race([page.evaluate(expression, name), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
const check = (name, value, detail) => {
  assert.ok(value, `${name}: ${JSON.stringify(detail)}`);
  checks.push(name);
};
try {
  await page.waitForFunction(() => window.tilesFixture, null, { timeout: CASE_TIMEOUT });
  assert.equal(hardware.webgpu?.fallback, false, 'Physical WebGPU adapter required');

  const city = (results.city = await call((n) => window.tilesFixture.run(n), 'city'));
  assert.deepEqual(city.errors, [], 'city: WebGPU or engine errors');
  const depths = Object.keys(city.depths).map(Number);
  check(
    'the view settles with several levels of detail at once',
    depths.length >= 3 && Math.max(...depths) === 5,
    city,
  );
  check('only a fraction of the 1365 tiles is requested', city.requests < 700, city);
  check('the city is drawn (lit pixels) and the sky stays clear', city.lit > 480 * 270 * 0.15 && city.sky, city);
  check(
    'every on-screen leaf building is drawn where float64 maths puts it',
    city.leavesOnScreen >= 3 && city.leavesDrawn === city.leavesOnScreen,
    city,
  );
  check('ready content stays within the 80 kB budget', city.progress.bytes <= 80_000, city.progress);

  const fly = (results.fly = await call((n) => window.tilesFixture.run(n), 'fly'));
  assert.deepEqual(fly.errors, [], 'fly: WebGPU or engine errors');
  check('flying 3 km east loads the new leaves', fly.newRequests > 20 && fly.depths[5] > 0, fly);
  check(
    'and evicts old tiles (models disposed) under the budget',
    fly.unloads > 0 && fly.progress.bytes <= 80_000,
    fly,
  );
  check('the new view is drawn', fly.lit > 480 * 270 * 0.1, fly);

  const disposed = await call(() => window.tilesFixture.dispose(), 'dispose');
  check('dispose detaches the renderer without errors', !disposed.plugins && disposed.errors.length === 0, disposed);

  const grove = (results.grove = await call((n) => window.tilesFixture.run(n), 'grove'));
  assert.deepEqual(grove.errors, [], 'grove: WebGPU or engine errors');
  check(
    'i3dm: every on-screen tree of the 25 instances is drawn where float64 maths puts it',
    grove.onScreen >= 20 && grove.drawn === grove.onScreen,
    grove,
  );
  check('i3dm: the gap between trees stays background (instances, not one stretched box)', !grove.gapLit, grove);

  const real = (results.cesiumTrees = await call((n) => window.tilesFixture.run(n), 'cesium-trees'));
  assert.deepEqual(
    real.errors.filter((e) => !/^tile: Required glTF extensions are unsupported: KHR_techniques_webgl/.test(e)),
    [],
    'cesium-trees: WebGPU or engine errors',
  );
  check(
    'i3dm, real file: the 25 trees of Cesium TilesetWithTreeBillboards are drawn where float64 maths puts them',
    real.trees === 25 && real.onScreen >= 20 && real.drawn === real.onScreen,
    real,
  );

  const splat = (results.cesiumSplats = await call((n) => window.tilesFixture.run(n), 'cesium-splats'));
  assert.deepEqual(splat.errors, [], 'cesium-splats: WebGPU or engine errors');
  check(
    'splats, real file: the 27 Gaussian splats of CesiumJS sh_unit_cube are drawn in one cloud where float64 maths puts them',
    splat.splats === 27 && splat.clouds === 1 && splat.centres >= 20 && splat.drawn === splat.directDrawn && splat.differ === 0,
    splat,
  );
  check(
    'splats: a hidden splat tile leaves the cloud, and dispose frees it and draws nothing',
    splat.hidden === 0 && splat.cloudsAfter === 0 && splat.litAfter === 0,
    splat,
  );

  assert.deepEqual(pageErrors, []);
  for (const name of checks) console.log(`ok - ${name}`);
  console.log(
    `${checks.length} tiles browser checks passed (city settled in ${city.frames} frames, ${city.ms.toFixed(0)} ms)`,
  );
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/tiles-browser.json', JSON.stringify({ hardware, results, checks }, null, 2));
} finally {
  await context.close();
  release();
}
