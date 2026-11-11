import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './browser.js';
import { OWNER_FIXTURES, selectOwnerPackages } from './support/owner-lifetime-registry.mjs';
import { exitOnHelp } from './support/help.mjs';

exitOnHelp('usage: node scripts/check-owner-lifetime-browser.mjs --packages=a,b');
const names = process.argv.find((a) => a.startsWith('--packages='))?.slice(11).split(',') ?? Object.keys(OWNER_FIXTURES);
const { selected } = selectOwnerPackages(names);
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const timer = setTimeout(() => { console.error('OWNER_GPU_TIMEOUT: 180 seconds'); process.exit(1); }, 180000);
const browser = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' });
const errors = [], receipt = { results: [], failures: [], errors };
browser.page.on('pageerror', (e) => errors.push(e.message));
browser.page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
try {
  for (const name of selected) {
    const result = await browser.page.evaluate(async ({ name, path }) => {
      const { fixtures } = await import('/' + path);
      const { exerciseLifetime, lifecycleCases } = await import('/tests/support/owner-lifetime.js');
      const { browserLifetimeAdapter } = await import('/tests/support/owner-lifetime-browser.js');
      const results = [], failures = [];
      const entries = await fixtures();
      for (const fixture of entries) for (const target of ['default', 'secondary']) for (const mode of lifecycleCases) {
        if (target === 'default' && mode === 'scene') continue;
        try { results.push({ package: name, ...await exerciseLifetime(fixture, browserLifetimeAdapter, { target, mode }) }); }
        catch (error) { failures.push({ package: name, fixture: fixture.name, target, mode, error: error.stack }); }
      }
      return { results, failures };
    }, { name, path: OWNER_FIXTURES[name] });
    receipt.results.push(...result.results);
    receipt.failures.push(...result.failures);
    console.log(`GPU owner/lifetime ${name}: ${result.results.length} passed, ${result.failures.length} failed`);
    for (const failure of result.failures) console.error(JSON.stringify(failure));
  }
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/owner-lifetime-browser.json', JSON.stringify(receipt, null, 2) + '\n');
  if (receipt.failures.length || errors.length) throw new Error(`OWNER_GPU_FAILED: ${receipt.failures.length} cases, ${errors.length} browser errors`);
  console.log(`GPU owner/lifetime PASS: ${receipt.results.length} cases, real device loss and recovery`);
} finally { clearTimeout(timer); await browser.close(); }
