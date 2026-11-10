import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { openBrowser } from '../../../scripts/browser.js';

const only = process.argv.find((argument) => argument.startsWith('--only='))?.slice(7);
const selection = only ? only.split(',').map(decodeURIComponent) : undefined;
const context = await openBrowser({ startPath: '/packages/webgl2-compat/test/tier-packages.html', port: 'free' });
const errors = [],
  report = { status: 'running', hardware: context.hardware, rows: [] };
context.page.on('pageerror', (error) => errors.push(error.message));
context.page.setDefaultTimeout(90000);
const save = () =>
  writeFileSync(
    new URL(
      `../../../test-results/batch-273-tier-packages${selection ? '-' + selection.join('-').replace(/[^a-z0-9]+/gi, '-') : ''}.json`,
      import.meta.url,
    ),
    JSON.stringify(report, null, 2) + '\n',
  );
function compare(a, b) {
  let over = 0,
    sum = 0,
    max = 0,
    lit = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(...[0, 1, 2].map((c) => Math.abs(a[i + c] - b[i + c])));
    over += +(d > 2);
    sum += d;
    max = Math.max(max, d);
    lit += +(b[i] + b[i + 1] + b[i + 2] > 120);
  }
  return { share: over / (a.length / 4), mean: sum / (a.length / 4), max, lit };
}
try {
  await context.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const names = (await context.page.evaluate(() => window.check.names)).filter(
    (name) => !selection || selection.includes(name),
  );
  assert.ok(names.length, 'select an existing package scene with --only=<URI-encoded name>');
  for (const name of names) {
    const full = await context.page.evaluate((name) => window.check.capture('full', name), name);
    assert.equal(full.refusal, undefined, `${name}: full tier accepts the package`);
    assert.deepEqual(full.errors, [], `${name}: full errors`);
    assert.equal(full.gl, 0);
    for (const tier of ['half-float', 'ldr']) {
      const result = await context.page.evaluate(({ tier, name }) => window.check.capture(tier, name), { tier, name });
      assert.equal(result.tier, tier);
      assert.deepEqual(result.errors, [], `${name} ${tier}: errors`);
      assert.equal(result.gl, 0);
      if (['post bloom and tonemap', 'post bloom alone', 'post ssao alone', 'dof HDR'].includes(name) && tier === 'ldr') {
        assert.equal(result.refusal?.name, 'MargoError');
        assert.equal(result.refusal?.code, 'unsupported');
        assert.match(
          result.refusal.message,
          /(?:PostStack HDR\/display effects|Bloom HDR processing|SSAO geometry\/HDR processing|DOF HDR processing).*half-float.*ldr.*https:\/\//,
        );
        report.rows.push({ name, tier, refusal: result.refusal });
        save();
        console.log(name, tier, result.refusal);
        continue;
      }
      assert.equal(result.refusal, undefined, `${name} ${tier}: the package accepts this tier`);
      const metrics = compare(full.bytes, result.bytes);
      const row = { name, tier, ...metrics, errors: result.errors, gl: result.gl };
      report.rows.push(row);
      save();
      console.log(row);
      assert.ok(metrics.lit > 0, `${name} ${tier}: visible image`);
    }
  }
  assert.deepEqual(errors, []);
  report.status = report.rows.every((row) => row.refusal || (row.share <= 0.001 && row.mean <= 0.25))
    ? 'passed'
    : 'differs';
  save();
  assert.equal(report.status, 'passed', 'every package obeys the existing layer parity rule');
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  save();
  throw error;
} finally {
  await context.close();
}
