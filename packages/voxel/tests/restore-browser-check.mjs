// Real-GPU proof that the voxel renderer survives a device restore with a caller's GpuVoxelMesher and a VoxelGI (run
// from the repository root after building packages, one GPU job at a time:
// node scripts/run-with-timeout.mjs -- node packages/voxel/tests/restore-browser-check.mjs; MARGO_COMPAT=1
// for the WebGL2 compatibility layer). After engine.rebootDevice(): frames drawn before VoxelGI.update() raise no
// validation error (KB-RESTORE-VOXGI1), the caller's mesher meshes every chunk again on the new device
// (KB-RESTORE-VOXMESH1), nothing is reported through engine.onError, and the settled picture (floor by the wall, open
// floor, the wall) matches the one before the restore.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const path = '/packages/voxel/tests/restore-browser-check.html',
  port = 5246,
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
  const errors = await page.evaluate(() => window.check.errors()),
    reported = await page.evaluate(() => window.check.reported());
  assert.ok(r.restored, 'the engine restored a new device');
  assert.deepEqual(errors, [], 'no validation error or throw from a frame after the restore');
  assert.deepEqual(reported, [], 'nothing reported through engine.onError');
  assert.ok(r.meshedAfter > r.meshedBefore, `the caller's GpuVoxelMesher meshed again: ${r.meshedBefore} -> ${r.meshedAfter}`);
  for (const key of ['nearWall', 'open', 'wall'])
    r.before[key].forEach((v, c) =>
      assert.ok(
        Math.abs(v - r.after[key][c]) <= 6,
        `${key} after the restore should match before: [${r.before[key].map(Math.round)}] -> [${r.after[key].map(Math.round)}]`,
      ),
    );
  const redness = ([red, green]) => red / Math.max(green, 1);
  assert.ok(redness(r.after.nearWall) > redness(r.after.open) * 1.05, `GI bounce still drawn: ${r.after.nearWall}`);
  assert.deepEqual(pageErrors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/voxel-restore-browser-check.json', JSON.stringify({ hardware, r }, null, 1));
  console.log('voxel restore browser check passed');
} finally {
  await context.close();
}
