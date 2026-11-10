// Run the canonical correctness drivers unchanged through the shipped Firefox's BiDi endpoint.
// BROWSER_EXECUTABLE supplies the binary; no installed path or user profile is committed.
import { registerHooks } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runLimited } from '../../../scripts/support/run-limited.mjs';

const leaves = [
  'tiers-browser.mjs',
  'tier-packages-browser.mjs',
  'package-tiers-browser.mjs',
  'compat-browser-check.mjs',
  'features-browser.mjs',
  'destroy-frame-browser.mjs',
  'compute-browser.mjs',
  'routes-browser.mjs',
  'xr-browser.mjs',
  'preview-browser-check.mjs',
  'corpus-draw-browser.mjs',
];
const leaf = process.argv.find((arg) => arg.startsWith('--leaf='))?.slice(7);
if (leaf) {
  if (!leaves.includes(leaf)) throw new Error(`Unknown matrix leaf ${leaf}`);
  const browserURL = new URL('../../../scripts/browser.js', import.meta.url).href;
  const bridgeURL = new URL('./support/firefox-bidi.mjs', import.meta.url).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (result.url === browserURL && context.parentURL !== bridgeURL) return { ...result, url: bridgeURL };
      return result;
    },
  });
  await import(new URL(leaf, import.meta.url));
} else {
  if (!process.env.BROWSER_EXECUTABLE) throw new Error('Set BROWSER_EXECUTABLE to the shipped Firefox executable');
  const selected = process.argv.slice(2).filter((arg) => arg.endsWith('.mjs'));
  const plan = selected.length ? selected : leaves;
  for (const name of plan) if (!leaves.includes(name)) throw new Error(`Unknown matrix leaf ${name}`);
  const report = {
    browser: 'Firefox',
    protocol: 'WebDriver BiDi',
    results: [],
    scope:
      'Canonical compatibility device, tier, package route, stereo and preview drivers. No headset or physical lower-tier claim.',
  };
  for (const name of plan) {
    const logFile = `test-results/firefox-matrix-${name}.log`;
    const minutes = name === 'corpus-draw-browser.mjs' ? 4 : 3;
    const command = `node scripts/gpu-lock.mjs run --owner=codex-batch273 --wait-max=60 --max=${minutes} --gpu=Firefox-canonical-correctness -- node "${fileURLToPath(import.meta.url)}" --leaf=${name}`;
    const result = await runLimited(command, {
      cwd: process.cwd(),
      env: process.env,
      limitMs: (62 + minutes) * 60000,
      logFile,
    });
    report.results.push({ name, ...result, logFile });
    await writeFile('test-results/firefox-matrix.json', JSON.stringify(report, null, 2) + '\n');
    console.log(
      `${name}: ${result.ok ? 'PASS' : 'FAIL'}${result.timedOut ? ' (hard limit, process tree killed)' : ''}`,
    );
  }
  process.exitCode = report.results.every((result) => result.ok) ? 0 : 1;
}
