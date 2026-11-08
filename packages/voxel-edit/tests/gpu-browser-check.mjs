// Real-GPU proof of @margoengine/voxel-edit/gpu (run from the repository root after building packages, one GPU job at
// a time: node scripts/gpu-lock.mjs run --owner=voxel-edit-gpu -- node packages/voxel-edit/tests/gpu-browser-check.mjs):
// a chain of fills, booleans and filters on a GpuGrid gives exactly the cells of the same chain of CPU operations, on
// 37 x 29 x 41 and on 256 x 256 x 256 (16.7 million cells); a ShaderBrush runs on the resident grid; write, read and
// remap round-trip; a brush from another device and a disposed grid are refused; no WebGPU validation errors.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const path = '/packages/voxel-edit/tests/gpu-browser-check.html',
  port = 5243,
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
  for (const k of ['small', 'big']) {
    assert.equal(r[k].differ, 0, `${k}: ${r[k].differ} cells differ from the CPU chain`);
    assert.equal(r[k].clipped[0], r[k].clipped[1], `${k}: clipped ${r[k].clipped}`);
    assert.ok(r[k].filled > 0, `${k}: the chain emptied the grid`);
  }
  assert.ok(r.big.clipped[0] > 0, 'the big chain clips part of its tool');
  // An 8-cubed grid: the cells with a coordinate 0 are 512 - 7^3.
  assert.equal(r.brush, 512 - 343);
  assert.equal(r.roundTrip, 0);
  assert.equal(r.remap, r.threes);
  assert.match(r.otherDevice, /another device/);
  assert.equal(r.disposed, 'disposed');
  console.log(
    `ok GPU bulk edits: 256-cubed chain ${r.big.gpuMs.toFixed(0)} ms on the GPU, ${r.big.cpuMs.toFixed(0)} ms on the CPU (diagnostic)`,
  );
  assert.deepEqual(await page.evaluate(() => window.check.errors()), []);
  assert.deepEqual(pageErrors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/voxel-edit-gpu-browser-check.json', JSON.stringify({ hardware, r }, null, 1));
  console.log('voxel-edit GPU bulk edit browser check passed');
} finally {
  await context.close();
}
