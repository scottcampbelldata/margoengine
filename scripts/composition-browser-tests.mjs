import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';
import { pairCoverage } from './support/composition-contracts.mjs';
import { exitOnHelp } from './support/help.mjs';

exitOnHelp(
  'node scripts/composition-browser-tests.mjs [--packages=taa,dof]\nRun selected C2 rows on both backends at 1x and 4x MSAA.',
);

const matrix = JSON.parse(readFileSync(new URL('../tests/composition/generated.json', import.meta.url), 'utf8'));
const packages = process.argv
  .find((a) => a.startsWith('--packages='))
  ?.slice(11)
  .split(',')
  .map((p) => p.replace('@margoengine/', ''));
const rows = matrix.rows.filter((row) => !packages || row.members.some((m) => packages.includes(m)));
assert.ok(rows.length, 'No composition scenes selected');
const release = await acquire({ owner: 'composition-browser', waitMax: 1 });
const results = [];
let browser;
try {
  for (const compat of [false, true]) {
    browser = await openBrowser({ startPath: `/tests/composition/${rows[0].id}.html`, port: 'free', compat });
    const pageErrors = [];
    browser.page.on('pageerror', (error) => pageErrors.push(error.message));
    for (const row of rows) {
      await browser.page.goto(new URL(`/tests/composition/${row.id}.html`, browser.page.url()).href);
      await browser.page.waitForFunction(() => !!window.composition, null, { timeout: 60_000 });
      for (const samples of [1, 4]) {
        const result = await browser.page.evaluate((samples) => window.composition.run(samples), samples);
        assert.deepEqual(result.errors, [], `${row.id} ${row.members.join('+')}`);
        assert.deepEqual(pageErrors, [], `${row.id}: browser error`);
        results.push({ backend: compat ? 'webgl2-compat' : 'webgpu', ...result });
        console.log(
          `PASS ${row.id} ${compat ? 'webgl2-compat' : 'webgpu'} ${samples}x ${row.members.join('+') || '(baseline)'}`,
        );
      }
    }
    await browser.close();
    browser = undefined;
  }
  const coverage = pairCoverage(
    matrix.target,
    rows.map((r) => r.members),
  );
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/composition.json', `${JSON.stringify({ coverage, results }, null, 2)}\n`);
  console.log(`C2 passed on both backends at 1x and 4x: ${coverage.covered}/${coverage.total} pairs`);
} finally {
  await browser?.close();
  await release();
}
