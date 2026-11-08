// Real-GPU proof of @margoengine/voxel/light-rgb (run from the repository root after building packages, one GPU job at
// a time: node scripts/gpu-lock.mjs run --owner=voxel-rgb -- node packages/voxel/tests/light-rgb-browser-check.mjs):
// a dark stone room with a red torch and a blue lamp, the renderer's block light off: black without VoxelColorLight;
// with it the floor by the torch is red (red over 4 times blue), by the lamp blue (blue over 4 times red); no WebGPU
// validation errors.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const path = '/packages/voxel/tests/light-rgb-browser-check.html',
  port = 5226,
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
  const [red, blue] = r.on;
  for (const c of r.off) assert.ok(Math.max(...c) < 8, `floor without the light should be black: ${r.off}`);
  assert.ok(red[0] > 40 && red[0] > 4 * red[2], `floor by the red torch: ${red}`);
  assert.ok(blue[2] > 40 && blue[2] > 4 * blue[0], `floor by the blue lamp: ${blue}`);
  console.log(`ok coloured light: by the torch [${red.map(Math.round)}], by the lamp [${blue.map(Math.round)}]`);
  assert.deepEqual(await page.evaluate(() => window.check.errors()), []);
  assert.deepEqual(pageErrors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/voxel-light-rgb-browser-check.json', JSON.stringify({ hardware, r }, null, 1));
  console.log('voxel coloured light browser check passed');
} finally {
  await context.close();
}
