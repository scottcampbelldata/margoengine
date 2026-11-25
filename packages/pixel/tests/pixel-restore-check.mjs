// Real-GPU proof of the borrowed-object rule for the source and target textures of PixelScale and PaletteQuantize across a
// device restore (KB-RESTORE-BORROWED1). Run from the repository root after building packages, one GPU job at a time:
//   node scripts/run-with-timeout.mjs -- node packages/pixel/tests/pixel-restore-check.mjs
// MARGO_COMPAT=1 for the WebGL2 compatibility layer. A plain pair is dropped after engine.rebootDevice(): no validation
// error or throw, one 'state' report each for the source and the target linking #borrowed-lost, and `setSource` and
// `setTarget` bring the picture back. A function pair is read every frame and draws after the restore with no report.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const context = await openBrowser({ startPath: '/packages/pixel/tests/pixel-restore-check.html', port: 5411 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const near = (a, b, label) => a.forEach((v, c) => assert.ok(Math.abs(v - b[c]) <= 2, `${label}: [${a}] vs [${b}]`));
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  const result = await page.evaluate(() => window.check.run()),
    errors = await page.evaluate(() => window.check.errors()),
    reported = await page.evaluate(() => window.check.reported());
  console.log(JSON.stringify(result), JSON.stringify(reported));
  assert.deepEqual(errors, [], 'no validation error or throw from a frame after the restore');
  for (const [name, r] of Object.entries(result)) {
    assert.ok(r.restored, `${name}: the engine restored a new device`);
    near(r.live, r.expected, `${name}: the live picture`);
    assert.equal(r.lostReports, 2, `${name}: one report for the lost source and one for the lost target`);
    near(r.replaced, r.expected, `${name}: new textures through the setters bring the picture back`);
    assert.equal(r.reportsAfterSetters, 2, `${name}: no report once the setters were called`);
    near(r.fn, r.expected, `${name}: the function pair draws`);
    near(r.fnAfter, r.expected, `${name}: the function pair draws after the restore`);
    assert.equal(r.reportsOther, 0, `${name}: no report for a function pair`);
  }
  assert.ok(
    reported.every((m) => /^state .*#borrowed-lost/.test(m)),
    `only borrowed-lost reports: ${reported}`,
  );
  assert.deepEqual(pageErrors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/pixel-restore-check.json', JSON.stringify({ hardware, result }, null, 1));
  console.log('pixel restore browser check passed');
} finally {
  await context.close();
}
