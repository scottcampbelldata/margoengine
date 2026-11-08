// Real-GPU proof of @margoengine/voxel/gi (run from the repository root after building packages, one GPU job at a time:
// node scripts/gpu-lock.mjs run --owner=voxel-gi -- node packages/voxel/tests/gi-browser-check.mjs): with VoxelGI the
// white floor in front of a sunlit red wall turns red from the light the wall bounces, and a thin pole casts a sun shadow
// across the floor; without it the floor there keeps its colour and no shadow is drawn; no WebGPU validation errors.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const path = '/packages/voxel/tests/gi-browser-check.html',
  port = 5231,
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
  const redness = ([red, green]) => red / Math.max(green, 1);
  assert.ok(
    redness(r.on.nearWall) > 1.05 * redness(r.off.nearWall),
    `the floor by the red wall should turn red: ${r.off.nearWall} then ${r.on.nearWall}`,
  );
  assert.ok(redness(r.on.open) < 1.1 * redness(r.off.open), `open floor stays its colour: ${r.on.open}`);
  const dip = (line) => Math.min(...line) / Math.max(...line);
  assert.ok(dip(r.across) < 0.75, `the pole should shadow the floor: ${r.across.map(Math.round)}`);
  assert.ok(dip(r.acrossOff) > 0.9, `no shadow without the effect: ${r.acrossOff.map(Math.round)}`);
  console.log(
    `ok GI: floor by the wall [${r.off.nearWall.map(Math.round)}] -> [${r.on.nearWall.map(Math.round)}], shadow dip ${dip(r.across).toFixed(2)}`,
  );
  assert.deepEqual(await page.evaluate(() => window.check.errors()), []);
  assert.deepEqual(pageErrors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/voxel-gi-browser-check.json', JSON.stringify({ hardware, r }, null, 1));
  console.log('voxel GI browser check passed');
} finally {
  await context.close();
}
