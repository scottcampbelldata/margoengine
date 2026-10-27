// Real-GPU proof (run from the repository root after building packages, one GPU job at a time):
//   node packages/weather/tests/browser-check.mjs
// Hail draws on a real GPU, moves with time, repeats exactly for the same time and seed, leaves no trace when off,
// and the WGSL surface functions match the JavaScript ones.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const context = await openBrowser({ startPath: '/packages/weather/tests/browser-check.html', port: 5262 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.goto('http://127.0.0.1:5262/packages/weather/tests/browser-check.html');
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const r = await page.evaluate(() => window.check.run());
  assert.equal(r.validation, null);
  assert.deepEqual(r.errors, []);
  assert.ok(r.hailChanged > 150, `hail changed ${r.hailChanged} of ${r.pixels} pixels`);
  assert.equal(r.sameTime, 0, 'a frame with no time passing repeats exactly');
  assert.ok(r.movesWithTime > 150, `stones moved: ${r.movesWithTime} pixels differ after 0.35 s`);
  assert.ok(r.seedChanges > 150, `another seed draws other stones: ${r.seedChanges}`);
  assert.ok(r.lowCeiling > 0, 'a low ceiling still draws stones');
  assert.equal(r.zero, 0, 'intensity 0 draws nothing');
  assert.equal(r.afterDispose, 0, 'a disposed Hail leaves no trace');
  assert.ok(
    r.surface.cases >= 200 && r.surface.worst < 2e-5,
    `WGSL surface functions differ from JavaScript by ${r.surface.worst}`,
  );
  assert.deepEqual(pageErrors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/weather-browser-check.json', JSON.stringify({ hardware, result: r }, null, 1));
  console.log('ok weather: hail', r.hailChanged, 'pixels, moves', r.movesWithTime, ', surface worst', r.surface.worst);
} finally {
  await context.close();
}
