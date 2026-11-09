// Correctness only. Run under the shared GPU lock with --wait-max >= 60 and a hard outer process-tree limit.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));

const context = await openBrowser({ startPath: '/packages/sciviz/tests/webgl2.html', port: 5253 });
const { page, hardware } = context;
const errors = [],
  reports = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'warning') console.log(`browser warning: ${m.text()}`);
  if (m.type() === 'error') errors.push(m.text());
});
page.setDefaultTimeout(180_000);
try {
  for (const backend of ['webgpu', 'webgl2']) {
    await page.goto(new URL(`/packages/sciviz/tests/webgl2.html?backend=${backend}`, page.url()).href);
    await page.waitForFunction(() => typeof window.runWebGLChecks === 'function');
    const report = await page.evaluate(() => window.runWebGLChecks());
    reports.push(report);
    console.log(`${backend}: ${report.checks.join('; ')}`);
  }
  assert.deepEqual(errors, []);
  const parity = [];
  for (const name of Object.keys(reports[0].images)) {
    const a = Buffer.from(reports[0].images[name].data, 'base64'),
      b = Buffer.from(reports[1].images[name].data, 'base64');
    assert.equal(a.length, b.length);
    let sum = 0,
      over = 0;
    for (let p = 0; p < a.length; p += 4) {
      const d = Math.max(...[0, 1, 2].map((c) => Math.abs(a[p + c] - b[p + c])));
      sum += d;
      if (d > 2) over++;
    }
    const mean = sum / (a.length / 4),
      share = over / (a.length / 4);
    parity.push({ name, mean, share, lit: reports[1].images[name].lit });
  }
  await mkdir('test-results/sciviz-fixes', { recursive: true });
  await writeFile(
    'test-results/sciviz-fixes/webgl2-pixels.json',
    JSON.stringify({ hardware, parity, reports }, null, 2),
  );
  // Fixed correctness bound, selected before running; all pixels, including silhouettes and background, count.
  for (const { name, share, mean } of parity)
    assert(share <= 0.001 && mean <= 0.25, `${name}: native WebGL2 parity share ${share}, mean ${mean}`);
  console.log(JSON.stringify(parity));
  console.log('native WebGL2 drawing parity passed');
} finally {
  await context.close();
}
