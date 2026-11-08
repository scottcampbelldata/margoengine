// Real-GPU proof of @margoengine/voxel/gpu-mesher (run from the repository root after building packages, one GPU job at
// a time: node scripts/gpu-lock.mjs run --owner=voxel-gpu-mesher -- node packages/voxel/tests/gpu-mesher-browser-check.mjs):
// every chunk of a lit terrain and of five special chunks meshed in compute shaders gives meshChunk's words in every
// layer and its visibility, also sorted from an eye and after a large edit; the slab chunk is meshed on the CPU and the
// all-air chunk answered without the GPU; a VoxelRenderer using the GPU mesher draws the worker mesher's picture; no
// WebGPU validation errors. The timings printed are diagnostic only.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const path = '/packages/voxel/tests/gpu-mesher-browser-check.html',
  port = 5228,
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
  for (const pass of ['first', 'sorted', 'edited']) {
    const { chunks, quads, bad, gpuMs, cpuMs } = r[pass];
    assert.deepEqual(bad, [], `${pass}: GPU meshes differ from meshChunk`);
    assert.equal(chunks, 23);
    assert.ok(quads > 10000, `${pass}: only ${quads} quads`);
    console.log(
      `ok ${pass}: ${chunks} chunks, ${quads} quads equal (GPU ${gpuMs.toFixed(1)} ms, meshChunk ${cpuMs.toFixed(1)} ms)`,
    );
  }
  // Three passes of 23 chunks: the slab chunk on the CPU and the air chunk empty each time, the rest on the GPU.
  assert.deepEqual({ gpu: r.stats.gpu, cpu: r.stats.cpu, empty: r.stats.empty }, { gpu: 63, cpu: 3, empty: 3 });
  assert.equal(r.stats.batches, 9); // 21 GPU chunks a pass in batches of 8
  assert.ok(r.lit > r.pixels / 10, `the terrain should fill the picture: ${r.lit} of ${r.pixels} pixels lit`);
  assert.equal(r.differ, 0, `${r.differ} pixels differ between the worker and the GPU mesher`);
  assert.ok(r.rendererStats.gpu >= 20, `renderer meshed ${r.rendererStats.gpu} chunks on the GPU`);
  assert.equal(r.disposed, 'disposed');
  console.log(`ok renderer: same picture with the GPU mesher, ${r.lit} pixels lit, draws ${r.draws}`);
  assert.deepEqual(await page.evaluate(() => window.check.errors()), []);
  assert.deepEqual(pageErrors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/voxel-gpu-mesher-browser-check.json', JSON.stringify({ hardware, r }, null, 1));
  console.log('voxel GPU mesher browser check passed');
} finally {
  await context.close();
}
