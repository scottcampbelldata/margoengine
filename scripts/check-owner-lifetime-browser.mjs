import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './browser.js';
import { OWNER_FIXTURES, selectOwnerPackages } from './support/owner-lifetime-registry.mjs';
import { showHelp } from './support/help.mjs';

if (
  !showHelp(
    'usage: node scripts/check-owner-lifetime-browser.mjs --packages=a,b [--entry=name ...]\n' +
      'With --entry (one package only, repeatable) the leaf runs just the fixture entries of those names, in fixture order.',
  )
) {
  const names =
    process.argv
      .find((a) => a.startsWith('--packages='))
      ?.slice(11)
      .split(',') ?? Object.keys(OWNER_FIXTURES);
  const { selected } = selectOwnerPackages(names);
  const named = process.argv.filter((a) => a.startsWith('--entry=')).map((a) => a.slice(8));
  const entry = named.length ? named : undefined;
  if (entry !== undefined && selected.length !== 1)
    throw new Error('OWNER_ENTRY_NEEDS_ONE_PACKAGE: --entry selects within one package');
  process.chdir(fileURLToPath(new URL('..', import.meta.url)));
  const timer = setTimeout(() => {
    console.error('OWNER_GPU_TIMEOUT: 180 seconds');
    process.exit(1); // process.exit: the watchdog ends a run that is still going past its hard limit
  }, 180000);
  // A package whose fixture imports dependencies the plain page does not (React) brings its own start page next to the
  // fixture, owner-lifetime.html, so the dev server bundles them before the page loads instead of reloading it mid-leaf.
  const own =
    selected.length === 1 && OWNER_FIXTURES[selected[0]].replace(/owner-lifetime\.fixture\.js$/, 'owner-lifetime.html');
  const startPath = own && existsSync(own) ? `/${own}` : '/tests/modern-game.html';
  const browser = await openBrowser({ startPath, port: 'free' });
  const errors = [],
    receipt = { results: [], failures: [], errors };
  browser.page.on('pageerror', (e) => errors.push(e.message));
  browser.page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  // A module the page could not load fails page.evaluate with only "Failed to fetch dynamically imported module" for the
  // importing file (2026-11-12, culling/DynamicInstances, known-bugs): the failed
  // request and every error answer are kept, and printed when a leaf ends that way, so the module and status are named.
  const network = [];
  browser.page.on('requestfailed', (r) => network.push(`failed ${r.url()}: ${r.failure()?.errorText}`));
  browser.page.on('response', (r) => {
    if (r.status() >= 400) network.push(`${r.status()} ${r.url()}`);
  });
  try {
    for (const name of selected) {
      const result = await browser.page
        .evaluate(
          async ({ name, path, entry }) => {
            const { fixtures } = await import('/' + path);
            const { exerciseLifetime, leafEntries, lifecycleCases } = await import('/tests/support/owner-lifetime.js');
            const { browserLifetimeAdapter } = await import('/tests/support/owner-lifetime-browser.js');
            const results = [],
              failures = [],
              entryRows = [];
            // Entries load by plain URL, as the package's own cross-entry imports do. The fixture's own import() of a
            // variable gets Vite's ?import query, a second module instance that breaks class and brand checks.
            const base = new URL('/' + path, location.href);
            const entries = leafEntries(await fixtures((file) => import(new URL(file, base).href)), entry);
            for (const fixture of entries) {
              const start = performance.now(),
                passed = results.length,
                failed = failures.length;
              for (const target of ['default', 'secondary'])
                for (const mode of lifecycleCases) {
                  if (target === 'default' && mode === 'scene') continue;
                  try {
                    results.push({
                      package: name,
                      ...(await exerciseLifetime(fixture, browserLifetimeAdapter, { target, mode })),
                    });
                  } catch (error) {
                    failures.push({ package: name, fixture: fixture.name, target, mode, error: error.stack });
                  }
                }
              entryRows.push({
                name: fixture.name,
                passed: results.length - passed,
                failed: failures.length - failed,
                seconds: (performance.now() - start) / 1000,
              });
            }
            return { results, failures, entryRows };
          },
          { name, path: OWNER_FIXTURES[name], entry },
        )
        .catch((error) => {
          for (const line of [...network, ...errors]) console.error(`OWNER_GPU_PAGE: ${line}`);
          throw error;
        });
      receipt.results.push(...result.results);
      receipt.failures.push(...result.failures);
      // A leaf of named entries prints one line per entry with its time, so a slow entry is named in the log.
      if (entry === undefined)
        console.log(`GPU owner/lifetime ${name}: ${result.results.length} passed, ${result.failures.length} failed`);
      else
        for (const row of result.entryRows)
          console.log(
            `GPU owner/lifetime ${name}/${row.name}: ${row.passed} passed, ${row.failed} failed ` +
              `(${row.seconds.toFixed(1)} s)`,
          );
      for (const failure of result.failures) console.error(JSON.stringify(failure));
      for (const error of errors) console.error(`OWNER_GPU_PAGE: ${error}`);
    }
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/owner-lifetime-browser.json', JSON.stringify(receipt, null, 2) + '\n');
    if (receipt.failures.length || errors.length)
      throw new Error(`OWNER_GPU_FAILED: ${receipt.failures.length} cases, ${errors.length} browser errors`);
    console.log(`GPU owner/lifetime PASS: ${receipt.results.length} cases, real device loss and recovery`);
  } finally {
    clearTimeout(timer);
    await browser.close();
  }
}
