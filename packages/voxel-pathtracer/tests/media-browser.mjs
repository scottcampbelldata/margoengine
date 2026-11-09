import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const results = [];
const boundary = await openBrowser({ startPath: '/packages/voxel-pathtracer/tests/media-boundary.html', port: 'free' });
try {
  await boundary.page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  const result = await boundary.page.evaluate(() => window.run());
  assert.ok(Math.abs(result.minimum - 3) < 1e-5, `root media emission minimum ${result.minimum}`);
  assert.ok(Math.abs(result.maximum - 3) < 1e-5, `root media emission maximum ${result.maximum}`);
  // Float32 camera coordinates at grazing incidence amplify their last bit by
  // 1 / abs(direction.x). These bounds include that coordinate uncertainty;
  // a repeated zero-distance boundary instead loses most of the segment.
  for (const value of result.grazingCell) assert.ok(value > 3.49 && value < 3.51, `grazing cell ${value}`);
  for (const value of result.grazingBrick) assert.ok(value > 3.65 && value < 3.75, `grazing brick ${value}`);
  results.push({ boundary: result });
} finally {
  await boundary.close();
}
for (const compat of [false, true]) {
  const context = await openBrowser({
    startPath: '/packages/voxel-pathtracer/tests/media.html',
    port: 'free',
    ...(compat && process.platform === 'win32' ? { args: ['--use-angle=vulkan'] } : {}),
  });
  const errors = [];
  context.page.on('pageerror', (e) => errors.push(e.message));
  try {
    await context.page.waitForFunction(() => window.ready, null, { timeout: 120000 });
    const result = await context.page.evaluate((compat) => window.run(compat), compat);
    console.log(JSON.stringify({ compat, hardware: context.hardware, result }));
    assert.deepEqual(errors, []);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.messages, []);
    assert.equal(result.refusal?.code, 'unsupported');
    assert.match(result.refusal.message, /https:\/\/margoengine.com\/errors#voxel-pathtracer/);
    for (const row of result.coverage) {
      assert.equal(row.finite, true, row.name);
      const tolerance =
        row.name === 'chromatic conservative furnace'
          ? 0.035
          : row.name === 'chromatic absorbing scattering'
            ? 0.02
            : 0.00001;
      for (let c = 0; c < 3; c++)
        assert.ok(
          Math.abs(row.actual[c] - row.expected[c]) < tolerance,
          `${row.name} channel ${c}: ${row.actual[c]} vs ${row.expected[c]}`,
        );
    }
    results.push({ compat, hardware: context.hardware, result });
  } finally {
    await context.close();
  }
}
const lifecycle = await openBrowser({
  startPath: '/packages/voxel-pathtracer/tests/browser-check.html?media=1',
  port: 'free',
});
try {
  await lifecycle.page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  const result = await lifecycle.page.evaluate(() => window.check.viewport());
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.messages, []);
  assert.equal(result.disabled.differing, 0);
  assert.equal(result.afterDispose.differing, 0);
  assert.equal(result.restored.differing, 0);
  assert.equal(result.newDevice, true);
  assert.ok(result.traced.differing > 1000);
  assert.equal(result.statsAfter.converged, true);
  results.push({ lifecycle: result });
} finally {
  await lifecycle.close();
}
await mkdir('test-results', { recursive: true });
await writeFile('test-results/voxel-pathtracer-media.json', JSON.stringify(results, null, 2));
console.log('media: native, compatibility, absorption, scattering, emission and shadows passed');
