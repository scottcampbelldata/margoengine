// Real-GPU proof of @margoengine/voxel/debris (run from the repository root after building packages, one GPU job at a
// time: node scripts/gpu-lock.mjs run --owner=voxel-debris -- node packages/voxel/tests/debris-browser-check.mjs): a red
// beam on a pillar drawn by VoxelRenderer; cutting the pillar breaks the beam off as a dynamic body whose core mesh
// falls with it onto the floor: red where the beam came to rest, not where it was; no WebGPU validation errors.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const path = '/packages/voxel/tests/debris-browser-check.html',
  port = 5236,
  context = await openBrowser({ startPath: path, port }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  const r = await page.evaluate(() => window.check.run());
  console.log(JSON.stringify(r));
  // Pillar y 3 and 4 and the beam x 8 to 18: one piece, one block type, two boxes.
  assert.deepEqual(r.stats, { cells: 13, meshes: 1, boxes: 2 });
  const red = ([cr, cg, cb]) => cr > 50 && cr > 2 * cg && cr > 2 * cb;
  assert.ok(red(r.beamBefore), `the beam should be red before the cut: ${r.beamBefore}`);
  assert.ok(!red(r.beamAfter), `the beam should be gone from where it was: ${r.beamAfter}`);
  assert.ok(r.start[1] - r.end[1] > 2, `the piece should fall: ${r.start} to ${r.end}`);
  assert.ok(r.end[1] > 0.9 && r.speed < 0.1, `the piece should rest on the floor: ${r.end}, speed ${r.speed}`);
  assert.ok(Math.hypot(...r.rest.map((v, i) => v - r.end[i])) < 0.05, `the mesh follows the body: ${r.rest}`);
  assert.ok(red(r.fallen), `the fallen beam should be drawn red where it lies: ${r.fallen} at ${r.moved}`);
  const [fr, fg, fb] = r.floor;
  assert.ok(fr > 20 && Math.max(fr, fg, fb) - Math.min(fr, fg, fb) < 20, `the floor should be grey: ${r.floor}`);
  console.log(
    `ok voxel debris: beam [${r.beamBefore.map(Math.round)}] then [${r.beamAfter.map(Math.round)}], fallen [${r.fallen.map(Math.round)}]`,
  );
  assert.deepEqual(await page.evaluate(() => window.check.errors()), []);
  assert.deepEqual(pageErrors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/voxel-debris-browser-check.json', JSON.stringify({ hardware, r }, null, 1));
  console.log('voxel debris browser check passed');
} finally {
  await context.close();
}
