// Real-adapter check of computeReadback (run from the repository root after building packages, under the GPU lock):
//   node scripts/gpu-lock.mjs run --owner=<id> -- node packages/shader/test/readback-check.mjs
// One dispatch reads 4,194,304 u32 back exactly; a job on an engine that renders no frame; abort right after submit
// and while mapping; engine disposal and device loss right after submit and while mapping; a pipeline that fails
// validation. Every settled job destroyed its readback and uniform buffers, and no GPU error escaped its scope.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const context = await openBrowser({ startPath: '/packages/shader/test/readback-check.html', port: 5237 }),
  { page, hardware } = context,
  pageErrors = [],
  report = { adapter: hardware.webgpu, browser: `${hardware.browserName} ${hardware.browserVersion}` };
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const allReleased = (released, label) => {
  assert.ok(released.length > 0, `${label}: no job buffers recorded`);
  for (const [name, destroyed] of released) assert.equal(destroyed, true, `${label}: ${name} not destroyed`);
};
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const run = (name) => page.evaluate((n) => window.check[n](), name);

  const correct = (report.correct = await run('correct'));
  assert.equal(correct.wrong, 0, 'u32 values read back');
  assert.deepEqual(correct.again, [7, 10, 13, 16], 'the second job reads the GPU, not the caller-changed copy');
  assert.deepEqual(correct.floats, [0.5, 1, 2, 3], 'vec4f element 1');
  assert.equal(correct.floatsType, 'Float32Array');
  allReleased(correct.released, 'correct');
  console.log('ok correct', `${correct.ms} ms for 4,194,304 u32`);

  const engine = (report.engine = await run('engine'));
  assert.equal(engine.wrong, 0, 'engine job without a rendered frame');
  allReleased(engine.released, 'engine');
  console.log('ok engine');

  const abort = (report.abort = await run('abort'));
  assert.equal(abort.early?.name, 'AbortError', 'abort after submit');
  assert.equal(abort.mapping?.name, 'AbortError', 'abort while mapping');
  assert.match(abort.mapping.message, /stop while mapping/, 'rejects with the signal reason');
  assert.equal(abort.wrong, 0, 'the device works after aborted jobs');
  allReleased(abort.released, 'abort');
  console.log('ok abort');

  const disposal = (report.disposal = await run('disposal'));
  for (const entry of disposal.out) {
    assert.equal(entry.error?.code, 'disposed', `engine disposed at ${entry.when}: ${JSON.stringify(entry.error)}`);
    assert.equal(entry.afterwards?.code, 'disposed', `a job on a disposed engine (${entry.when})`);
    allReleased(entry.released, `disposal ${entry.when}`);
  }
  console.log('ok disposal');

  const loss = (report.loss = await run('loss'));
  for (const entry of loss.out) {
    assert.equal(entry.error?.code, 'failed', `device lost at ${entry.when}: ${JSON.stringify(entry.error)}`);
    assert.match(entry.error.message, /lost \(destroyed/, `loss reason at ${entry.when}`);
    assert.equal(entry.lostDevice?.code, 'failed', `a job on a lost device (${entry.when})`);
    assert.match(entry.lostDevice.message, /lost/);
    allReleased(entry.released, `loss ${entry.when}`);
  }
  console.log('ok loss');

  const validation = (report.validation = await run('validation'));
  assert.equal(validation.error?.code, 'failed', JSON.stringify(validation.error));
  assert.match(validation.error.message, /failed on the GPU/);
  assert.deepEqual(validation.recovered, [5, 6, 7, 8], 'the device and its error scopes stay usable');
  allReleased(validation.released, 'validation');
  console.log('ok validation');

  for (const name of ['correct', 'engine', 'abort', 'validation'])
    assert.deepEqual(report[name].errors, [], `${name}: uncaptured GPU errors`);
  assert.deepEqual(pageErrors, []);
  report.passed = true;
  console.log('compute readback GPU check passed');
} finally {
  await writeFile('test-results/readback-gpu.json', JSON.stringify(report, null, 2));
  await context.close();
}
