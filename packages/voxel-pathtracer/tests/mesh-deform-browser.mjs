// FG-17 piece 4b on the GPU, native WebGPU and the WebGL2 layer: a deforming mesh blurs as the closed-form time
// coverage of its quad (scaled, sheared across its shared diagonal, and deforming on a moving instance), and shutter 0
// and equal positions render the still bit for bit. Run from the repository root after building packages:
//   node scripts/run-with-timeout.mjs -- node packages/voxel-pathtracer/tests/mesh-deform-browser.mjs
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { legDevice } from '../../../scripts/support/compat-shim.js';
const rows = [];
for (const compat of [false, true]) {
  const context = await openBrowser({
    startPath: '/packages/voxel-pathtracer/tests/mesh-deform.html',
    port: 'free',
    ...(compat && process.platform === 'win32' ? { args: ['--use-angle=vulkan'] } : {}),
  });
  const errors = [];
  context.page.on('pageerror', (e) => errors.push(e.message));
  try {
    await context.page.waitForFunction(() => window.ready, null, { timeout: 120000 });
    const result = await context.page.evaluate((c) => window.run(c), compat);
    console.log(JSON.stringify({ compat, device: legDevice(compat, context.hardware), result }));
    assert.deepEqual(errors, []);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.messages, []);
    assert.equal(result.rows.length, 8);
    for (const row of result.rows) {
      const label = `${row.name}${row.composed ? ' (composed)' : ''}${compat ? ' (WebGL2)' : ''}`;
      if (row.name === 'equal positions are still') assert.equal(row.equal, true, label);
      else {
        assert.equal(row.finite, true, label);
        assert.ok(row.lit > 300, `${label}: the swept quad covers ${row.lit} pixels`);
        // Each pixel within 5 binomial sigma of its time coverage; the spread over the image is about 1 sigma.
        assert.ok(row.zMax < 5, `${label}: worst pixel ${row.zMax.toFixed(2)} sigma`);
        assert.ok(row.zRms < 1.25, `${label}: rms ${row.zRms.toFixed(3)} sigma`);
        assert.ok(Math.abs(row.energyRatio - 1) < 0.01, `${label}: energy ratio ${row.energyRatio}`);
        assert.equal(row.shutterZeroEqualsStill, true, `${label}: shutter 0`);
      }
    }
    rows.push({ compat, device: legDevice(compat, context.hardware), result });
  } finally {
    await context.close();
  }
}
await mkdir('test-results', { recursive: true });
await writeFile('test-results/voxel-pathtracer-mesh-deform.json', JSON.stringify(rows, null, 2));
console.log('mesh deform check passed');
