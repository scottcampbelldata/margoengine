// Real-GPU proof of @margoengine/voxel-edit/shaders (run from the repository root after building packages, one GPU job
// at a time: node scripts/gpu-lock.mjs run --owner=voxel-edit-shaders -- node packages/voxel-edit/tests/shaders-browser-check.mjs):
// the grow and erode presets match dilateGrid and erodeGrid cell for cell, also on 16.7 million cells; selections,
// generation, smoothing, a user brush, a compile error with its line and abort; no WebGPU validation errors.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const path = '/packages/voxel-edit/tests/shaders-browser-check.html',
  port = 5238,
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
  for (const k of ['grow1', 'grow3', 'growColor', 'erode1', 'erode2', 'big', 'tool'])
    assert.equal(r[k], 0, `${k}: ${r[k]} cells differ from the CPU operation`);
  assert.ok(r.bigChanged[0] > 100000 && r.bigChanged[0] === r.bigChanged[1], `big grid changed ${r.bigChanged}`);
  assert.deepEqual(r.selection, {
    kept: Math.floor(r.selection.half / 2),
    ran: Math.ceil(r.selection.half / 2),
    half: r.selection.half,
  });
  const cells = 48 ** 3;
  assert.ok(
    r.noise.filled > cells * 0.25 && r.noise.filled < cells * 0.75,
    `noise filled ${r.noise.filled} of ${cells}`,
  );
  assert.equal(r.noise.repeat, 0);
  assert.ok(r.noise.other > cells * 0.1, `another seed changes ${r.noise.other} cells`);
  assert.deepEqual(r.noise.colours, [0, 3]);
  assert.deepEqual(r.smooth, { interior: 1000, salt: 0 });
  // An 8-cubed shell: 512 - 216 cells, coloured 1 + y.
  assert.deepEqual(r.shell, { filled: 296, top: 8, bottom: 1, middle: 0 });
  assert.match(r.broken, /^failed: .*line 2 of the brush code.*; fix the WGSL$/);
  assert.equal(r.aborted, 'stop');
  console.log(
    `ok shader brushes: 256-cubed grow ${r.bigGpuMs.toFixed(0)} ms on the GPU, ${r.bigCpuMs.toFixed(0)} ms dilateGrid (diagnostic)`,
  );
  assert.deepEqual(await page.evaluate(() => window.check.errors()), []);
  assert.deepEqual(pageErrors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/voxel-edit-shaders-browser-check.json', JSON.stringify({ hardware, r }, null, 1));
  console.log('voxel-edit shader brush browser check passed');
} finally {
  await context.close();
}
