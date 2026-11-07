// The replay proof in real browsers: each must give the hashes on file, which Node and native code also give. It needs no
// WebGPU. `npm run test:replay`; REPLAY_BROWSERS or --browsers= picks them (default chromium and firefox, from Playwright;
// `default` is the browser the other suites use, so `npm run test:browser` holds it on every machine that runs the check,
// whether or not it has Firefox). REPLAY_FIREFOX
// names a firefox.exe to run in place of Playwright's own folder, for a machine whose home folder Windows will not load
// Firefox's side-by-side manifest from (docs/limits.md).
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const results = resolve(root, 'test-results');
const golden = JSON.parse(await readFile(resolve(root, 'tests/fixtures/replay-hash.json'), 'utf8'));
const chosen = process.argv.find((arg) => arg.startsWith('--browsers='))?.slice('--browsers='.length);
const browsers = (chosen ?? process.env.REPLAY_BROWSERS ?? 'chromium,firefox').split(',');
await mkdir(results, { recursive: true });
const server = await createServer({ configFile: resolve(root, 'vite.config.js'), logLevel: 'error', server: { port: 0 } });
await server.listen();
const report = [];
try {
  for (const name of browsers) {
    const executablePath = name === 'firefox' ? process.env.REPLAY_FIREFOX : undefined,
      browser = await launchBrowser({
        ...(name === 'default' ? {} : { name }),
        needs: 'none',
        headless: true,
        ...(executablePath ? { executablePath } : {}),
      });
    try {
      const page = await browser.newPage(),
        errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${server.resolvedUrls.local[0]}tests/replay.html`);
      await page.waitForFunction(() => typeof window.runReplay === 'function', null, { timeout: 60_000 });
      const { kernel, physics } = await page.evaluate(() => window.runReplay());
      assert.deepEqual(errors, []);
      assert.deepEqual(kernel, golden.kernel, `${name}: the kernel scene left the hashes on file`);
      assert.deepEqual(physics, golden.physics, `${name}: the Physics scene left the hashes on file`);
      report.push({ browser: name, version: browser.version(), steps: golden.steps, last: kernel.at(-1) });
      console.log(`${name} ${browser.version()}: ${golden.steps} steps, ${kernel.length + physics.length} hashes equal`);
    } finally {
      await closeAll({ browser });
    }
  }
  await writeFile(resolve(results, 'replay-browsers.json'), JSON.stringify(report, null, 2));
} finally {
  await closeAll({ servers: [server] });
}
