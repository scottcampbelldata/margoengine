// Real-GPU proof of the borrowed-object rule for a VoxelRenderer lightmap atlas across a device restore
// (KB-RESTORE-BORROWED1). Run from the repository root after building packages, one GPU job at a time:
// node scripts/run-with-timeout.mjs -- node packages/voxel/tests/lightmap-restore-browser-check.mjs;
// MARGO_COMPAT=1 for the WebGL2 compatibility layer. A plain atlas is dropped after engine.rebootDevice(): no
// validation error or throw, live lighting (the picture without a lightmap), one 'state' report linking #borrowed-lost,
// and a new lightmap brings the baked picture back. A (device) => texture atlas is made once per device and draws the
// baked picture after the restore with no report.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const path = '/packages/voxel/tests/lightmap-restore-browser-check.html',
  port = 5262,
  context = await openBrowser({ startPath: path, port }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const near = (a, b, label) =>
  a.forEach((v, c) =>
    assert.ok(Math.abs(v - b[c]) <= 6, `${label}: [${a.map(Math.round)}] vs [${b.map(Math.round)}]`),
  );
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  const r = await page.evaluate(() => window.check.run());
  console.log(JSON.stringify(r));
  const errors = await page.evaluate(() => window.check.errors()),
    reported = await page.evaluate(() => window.check.reported());
  assert.ok(r.restored && r.restoredAgain, 'the engine restored a new device twice');
  assert.deepEqual(errors, [], 'no validation error or throw from a frame after either restore');
  assert.ok(Math.min(...r.live.chart) > 40, `the live-lit floor is drawn and lit: ${r.live.chart}`);
  const redness = ([red, green]) => red / Math.max(green, 1);
  assert.ok(redness(r.baked.chart) > redness(r.baked.open) * 1.5, `the chart draws the red baked light: ${r.baked.chart}`);
  near(r.baked.open, r.live.open, 'the floor off the chart stays live-lit');
  near(r.lost.chart, r.live.chart, 'a lost plain atlas leaves the live-lit floor');
  assert.equal(r.reportedLost, 1, `one report for the lost atlas: ${JSON.stringify(reported)}`);
  assert.match(reported[0], /^state VoxelRenderer lightmap texture lost with the device.*#borrowed-lost/);
  near(r.replaced.chart, r.baked.chart, 'a new lightmap brings the baked light back');
  near(r.fn.chart, r.baked.chart, 'the function atlas draws the baked light');
  near(r.fnAfter.chart, r.baked.chart, 'the function atlas is back after the restore');
  assert.equal(r.made, 2, 'the function atlas is made once per device');
  assert.equal(reported.length, 1, `no report for the function atlas: ${JSON.stringify(reported)}`);
  assert.deepEqual(pageErrors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/voxel-lightmap-restore-browser-check.json', JSON.stringify({ hardware, r }, null, 1));
  console.log('voxel lightmap restore browser check passed');
} finally {
  await context.close();
}
