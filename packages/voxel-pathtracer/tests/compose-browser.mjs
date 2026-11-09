import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const results = [];
const option = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const backend = option('backend'),
  phase = option('phase') ?? 'all';
assert.ok(backend === undefined || ['native', 'compat'].includes(backend), 'backend must be native or compat');
assert.ok(['all', 'ids'].includes(phase), 'phase must be all or ids');
for (const compat of backend ? [backend === 'compat'] : [false, true]) {
  const context = await openBrowser({
    startPath: '/packages/voxel-pathtracer/tests/compose.html',
    port: 'free',
    ...(compat && process.platform === 'win32' ? { args: ['--use-angle=vulkan'] } : {}),
  });
  const pageErrors = [];
  context.page.on('pageerror', (e) => pageErrors.push(e.message));
  context.page.on('console', (message) => {
    if (message.text().startsWith('compose-progress ')) console.log(message.text());
  });
  console.log(JSON.stringify({ hardware: context.hardware, compat, phase }));
  try {
    await context.page.waitForFunction(() => window.ready, null, { timeout: 120000 });
    const result = await context.page.evaluate(({ compat, phase }) => window.run(compat, phase), { compat, phase });
    console.log(JSON.stringify({ compat, phase, hardware: context.hardware, result }));
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.messages, []);
    assert.equal(result.subsets.length, 32);
    for (const row of result.subsets) {
      assert.equal(row.finite, true);
      assert.equal(row.firstBoundary, true, `media boundary AOV subset ${row.mask}`);
      for (let c = 0; phase === 'all' && c < 3; c++)
        assert.ok(
          Math.abs(row.actual[c] - row.expected[c]) < 0.00002,
          `subset ${row.mask}, channel ${c}: ${row.actual[c]} != ${row.expected[c]}`,
        );
    }
    assert.equal(result.triangleMarker, true);
    if (phase === 'all') {
      assert.equal(result.reflected.finite, true);
      for (let c = 0; c < 3; c++)
        assert.ok(
          Math.abs(result.reflected.actual[c] / result.reflected.reference[c] - 1) < 0.02,
          `RGB RIS shadow channel ${c}: ${JSON.stringify(result.reflected)}`,
        );
      assert.deepEqual(result.update, { actual: [1, 1, 1], revision: 2 });
    }
    results.push({ compat, phase, hardware: context.hardware, result });
  } finally {
    await context.close();
  }
}
await mkdir('test-results', { recursive: true });
await writeFile(
  `test-results/voxel-pathtracer-compose-${backend ?? 'both'}-${phase}.json`,
  JSON.stringify(results, null, 2),
);
console.log(`compose: ${backend ?? 'both'} ${phase} passed`);
