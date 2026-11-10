// Cross-browser oracle for Firefox installations without a native WebGPU adapter.
// Both shipped browsers use their defaults. Original dual-backend driver refusals
// stay in firefox-matrix.json; here every compatibility case is actually executed.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openNativeOracle as openNative } from './support/native-oracle.mjs';
import { openBrowser as openFirefox } from './support/firefox-bidi.mjs';
import { acquire } from '../../../scripts/gpu-lock.mjs';

export function differences(a, b, tolerance, path = '', out = []) {
  if (out.length >= 8) return out;
  if (typeof a === 'number' && typeof b === 'number') {
    const same =
      Number.isInteger(a) && Number.isInteger(b)
        ? a === b
        : Math.abs(a - b) <= tolerance || (Number.isNaN(a) && Number.isNaN(b));
    if (!same) out.push(`${path}: ${a} versus ${b}`);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: lengths ${a.length} versus ${b.length}`);
    else a.forEach((v, i) => differences(v, b[i], tolerance, `${path}[${i}]`, out));
  } else if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
      differences(a[key], b[key], tolerance, `${path}.${key}`, out);
  } else if (a !== b) out.push(`${path}: ${String(a)} versus ${String(b)}`);
  return out;
}

const strictPolicy = {
  name: 'firefox-matrix-strict-policy',
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url.endsWith('compute.html?strict'))
        response.setHeader(
          'content-security-policy',
          "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self' blob:",
        );
      next();
    });
  },
};
const report = {
  scope:
    'All feature and compute cases on shipped Firefox WebGL2 against native Chromium data. Cross-browser evidence; original same-browser tolerances retained.',
  cells: [],
};
const requested = process.argv
  .find((arg) => arg.startsWith('--fixtures='))
  ?.slice(11)
  .split(',');
const fixtures = ['features.html', 'compute.html', 'compute.html?strict'];
if (requested?.some((name) => !fixtures.includes(name))) throw new Error('Unknown matrix fixture');
const reportFile = requested
  ? 'test-results/firefox-compat-cases-selected.json'
  : 'test-results/firefox-compat-cases.json';
const release = await acquire({ owner: 'firefox-compat-reference', max: 5 });
try {
  for (const fixture of requested ?? fixtures) {
    console.log(`Starting native oracle: ${fixture}`);
    const startPath = `/packages/webgl2-compat/test/${fixture}`;
    const options = { startPath, port: 'free', compat: false, plugins: [strictPolicy] };
    const cell = { fixture, cases: [], errors: [], policyDiagnostics: [] };
    report.cells.push(cell);
    const oracle = new Map();
    let browser = await openNative(options);
    try {
      cell.nativeHardware = browser.hardware;
      await browser.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
      const names = await browser.page.evaluate(() => window.check.names());
      for (const name of names) {
        console.log(`Native oracle: ${fixture}/${name}`);
        const result = await browser.page.evaluate((name) => window.check.run(name), name);
        assert.equal(result.native.thrown, null, `${fixture}/${name}: native oracle threw`);
        assert.deepEqual(result.native.errors, []);
        oracle.set(name, { reference: result.native, tier: result.compat.result?.tier });
      }
    } finally {
      await browser.close();
    }
    browser = await openFirefox(options);
    console.log(`Starting Firefox compatibility cases: ${fixture}`);
    try {
      cell.firefoxHardware = browser.hardware;
      browser.page.on('pageerror', (error) => cell.errors.push(error.message));
      browser.page.on('console', (message) => {
        if (message.type() !== 'error') return;
        if (
          fixture.endsWith('?strict') &&
          message.text().startsWith('Content-Security-Policy:') &&
          /unsafe-eval/.test(message.text())
        )
          cell.policyDiagnostics.push(message.text());
        else cell.errors.push(message.text());
      });
      await browser.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
      const names = await browser.page.evaluate(() => window.check.names());
      assert.deepEqual(names, [...oracle.keys()], 'execute the entire original case list');
      for (const name of names) {
        const got = await browser.page.evaluate((name) => window.check.runCompat(name), name);
        const { reference: expected, tier } = oracle.get(name),
          compute = fixture.startsWith('compute');
        const tolerance = compute ? (got.result?.tolerance ?? 1e-6) : 1e-6;
        const diff = differences(
          compute ? expected.result?.values : expected.result,
          compute ? got.result?.values : got.result,
          tolerance,
        );
        if (compute && got.result?.tier !== tier) diff.push(`tier ${got.result?.tier} versus ${tier}`);
        const result = {
          name,
          expected: expected.result,
          actual: got.result,
          tolerance,
          differences: diff,
          thrown: got.thrown,
          errors: got.errors,
          gl: got.gl,
          tier: got.result?.tier,
          ok: got.thrown === null && got.errors.length === 0 && got.gl === 0 && diff.length === 0,
        };
        cell.cases.push(result);
        await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
        console.log(`${fixture}/${name}: ${result.ok ? 'PASS' : 'DIFFERENCE'} ${got.thrown ?? diff.join('; ')}`);
      }
      if (fixture.endsWith('?strict')) {
        cell.interpreter = await browser.page.evaluate(() =>
          performance.getEntriesByType('resource').some((entry) => /\/interpret-[^/]*\.js/.test(entry.name)),
        );
        assert.equal(cell.interpreter, true, 'strict policy must execute the interpreter');
        assert.equal(cell.policyDiagnostics.length, 1, 'one explicit new Function capability probe is blocked');
      }
    } finally {
      await browser.close();
    }
  }
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.cells.every((cell) => cell.errors.length === 0 && cell.cases.every((result) => result.ok))
    ? 0
    : 1;
} finally {
  release();
}
