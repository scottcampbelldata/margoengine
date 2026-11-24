// Real-adapter check (run from the repository root): node packages/shader/test/negated-division-check.mjs
// The driver fault behind the black hole's old camera frame (docs/known-bugs.md, "Radeon 680M: a negated component of a
// constant-scaled vector loses its sign in a division"): the formulations Margo's shaders use must be exact on every
// adapter, and the fault itself is printed (present on the Radeon 680M under D3D12, absent elsewhere) without failing.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const context = await openBrowser({ startPath: '/packages/shader/test/negated-division-check.html', port: 5242 });
try {
  const { page } = context,
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForFunction(() => document.title === 'done', null, { timeout: 120000 });
  const result = await page.evaluate(() => window.result);
  assert.deepEqual(errors, []);
  const fault = ['faultAtan2', 'faultDivide'].filter((k) => result[k].worst > 1e-4);
  console.log(`negated division on ${result.adapter}: driver fault ${fault.length ? `present (${fault.join(', ')}; ${JSON.stringify(result.faultAtan2.where)})` : 'absent'}`);
  for (const [name, { used, worst, where }] of Object.entries(result)) {
    if (!used) continue;
    assert.ok(worst < 1e-4, `${name}: ${worst} off at ${JSON.stringify(where)}`);
    console.log('ok', name);
  }
} finally {
  await context.close();
}
