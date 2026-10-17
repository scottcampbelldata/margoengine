// Real-GPU load of a 50,000-part OBJ (16,518,861 bytes, 300,000 quads) through parseCADAsync, then PartInstancer.
// Reuses test-results/cad-pack-50000/parts-50000.obj when its bytes match, or writes the same file. Timings are
// diagnostic (no quiet gate). Run after `npm run build:packages`; holds the shared GPU lock.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';

const file = 'test-results/cad-pack-50000/parts-50000.obj',
  digest = 'b7b86691bd1fd259',
  port = 5222;
/** 250 boxes per row, 1.2 units apart; box i is 0.8 wide and deep and 0.5 + 0.00002 i tall. */
function assembly(count = 50_000) {
  const lines = [`# Synthetic ${count}-part closed-box assembly; ${count * 12} triangles`];
  for (let i = 0; i < count; i++) {
    const x0 = (i % 250) * 1.2,
      z0 = Math.floor(i / 250) * 1.2,
      x1 = x0 + 0.8,
      z1 = z0 + 0.8,
      h = 0.5 + i * 0.00002,
      v = (x, y, z) => `v ${x.toFixed(5)} ${y.toFixed(5)} ${z.toFixed(5)}`;
    lines.push(
      `o part-${String(i).padStart(5, '0')}`,
      v(x0, 0, z0),
      v(x1, 0, z0),
      v(x1, h, z0),
      v(x0, h, z0),
      v(x0, 0, z1),
      v(x1, 0, z1),
      v(x1, h, z1),
      v(x0, h, z1),
      'f -8 -5 -6 -7',
      'f -4 -3 -2 -1',
      'f -8 -4 -1 -5',
      'f -7 -6 -2 -3',
      'f -8 -7 -3 -4',
      'f -5 -1 -2 -6',
    );
  }
  return lines.join('\n') + '\n';
}
const hash = (data) => createHash('sha256').update(data).digest('hex').slice(0, 16);
let browser, release;
try {
  let source = 'on disk';
  const existing = await readFile(file).catch(() => null);
  if (!existing || hash(existing) !== digest) {
    const text = assembly();
    assert.equal(hash(text), digest, 'generator reproduces the recorded file');
    await mkdir('test-results/cad-pack-50000', { recursive: true });
    await writeFile(file, text);
    source = 'generated';
  }
  release = await acquire({ owner: 'machinery-cad-large-tests' });
  browser = await openBrowser({ startPath: '/tests/machinery-pack.html?scenario=large&samples=4', port });
  assert.equal(browser.hardware.webgpu?.fallback, false, 'Physical WebGPU adapter required');
  const { page } = browser,
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => window.machineryPack, null, { timeout: 300_000 });
  const load = await page.evaluate(() => {
      const { bytes, parts, unique, fetchMs, parseMs } = machineryPack;
      return { bytes, parts, unique, fetchMs, parseMs };
    }),
    run = await page.evaluate(() => machineryPack.run());
  console.log(
    `Hardware: ${JSON.stringify(browser.hardware.webgpu)}; file ${source} (${load.bytes} bytes, sha256 ${digest}...)`,
  );
  console.log(
    `parseCADAsync: ${load.parts} parts, ${load.unique} unique geometries; fetch ${load.fetchMs.toFixed(0)} ms, parse + meshes ${load.parseMs.toFixed(0)} ms`,
  );
  console.log(
    `unpacked frame: ${run.unpacked.last.draws} draws, median ${run.unpacked.median.toFixed(1)} ms (min ${run.unpacked.min.toFixed(1)}, max ${run.unpacked.max.toFixed(1)}, 5 frames)`,
  );
  console.log(
    `PartInstancer attach (dedup) ${run.attachMs.toFixed(0)} ms; first packed frame (builds packs) ${run.buildMs.toFixed(0)} ms, ${run.build.draws} draws`,
  );
  console.log(
    `packed frame: ${run.packed.last.draws} draws (${run.stats.packs} packs, ${run.stats.packed} parts packed, engine.stats.drawCalls ${run.packed.last.drawCalls}), median ${run.packed.median.toFixed(1)} ms (min ${run.packed.min.toFixed(1)}, max ${run.packed.max.toFixed(1)}, 9 frames)`,
  );
  assert.equal(load.parts, 50_000);
  assert.equal(load.unique, 50_000);
  assert.equal(run.stats.packed, 50_000);
  assert.ok(run.packed.last.draws < 50_000 && run.packed.last.draws === run.stats.packs, 'one draw per pack');
  assert.deepEqual(errors, []);
  console.log('PASS 50,000-part OBJ loads through parseCADAsync and packs');
} finally {
  await browser?.page.evaluate(() => window.machineryPack?.dispose?.()).catch(() => {});
  await browser?.close();
  release?.();
}
