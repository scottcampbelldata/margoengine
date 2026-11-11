import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const results = [];
const option = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const backend = option('backend'),
  phase = option('phase') ?? 'all',
  // Subsets made at once (compose.html): native trace pipelines compile side by side on the browser's worker threads.
  // The WebGL2 layer runs one GL context, where it measured slower (223 s at 8 against 43 s at 1), so it takes 1.
  given = option('parallel') === undefined ? undefined : Number(option('parallel'));
assert.ok(backend === undefined || ['native', 'compat'].includes(backend), 'backend must be native or compat');
assert.ok(['all', 'ids'].includes(phase), 'phase must be all or ids');
assert.ok(given === undefined || (Number.isInteger(given) && given >= 1 && given <= 32), 'parallel must be 1 to 32');
for (const compat of backend ? [backend === 'compat'] : [false, true]) {
  const parallel = given ?? (compat ? 1 : 8);
  const context = await openBrowser({
    startPath: '/packages/voxel-pathtracer/tests/compose.html',
    port: 'free',
    ...(compat && process.platform === 'win32' ? { args: ['--use-angle=vulkan'] } : {}),
  });
  const pageErrors = [];
  context.page.on('pageerror', (e) => pageErrors.push(e.message));
  // Trace pipelines compiling at once: subsets made together must overlap their compiles (known-bugs, "review 99
  // composed native validation"), or the 32 native compiles of about 17 s each run one after another again.
  let tracing = 0,
    overlap = 0;
  context.page.on('console', (message) => {
    if (!message.text().startsWith('compose-progress ')) return;
    console.log(message.text());
    const event = JSON.parse(message.text().slice(17));
    if (event.entry !== 'trace') return;
    if (event.phase === 'pipeline-start') overlap = Math.max(overlap, ++tracing);
    if (event.phase === 'pipeline-ready') tracing--;
  });
  console.log(JSON.stringify({ hardware: context.hardware, compat, phase }));
  try {
    await context.page.waitForFunction(() => window.ready, null, { timeout: 120000 });
    const result = await context.page.evaluate(({ compat, phase, parallel }) => window.run(compat, phase, parallel), {
      compat,
      phase,
      parallel,
    });
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
    if (!compat && parallel > 1) assert.ok(overlap >= 2, `trace pipelines compile side by side (${overlap} at once)`);
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
