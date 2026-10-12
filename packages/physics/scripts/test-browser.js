import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const results = resolve(root, 'test-results');
// Consumers keep Rapier optional; browser checks use the monorepo test dependency.
const rapier = process.env.MARGOENGINE_RAPIER ? resolve(process.env.MARGOENGINE_RAPIER) : fileURLToPath(new URL('../../../node_modules/@dimforge/rapier3d-compat/',import.meta.url));
if (!rapier || !existsSync(resolve(rapier, 'dist/rapier.mjs'))) {
  console.log('SKIP physics browser test: set MARGOENGINE_RAPIER to an installed @dimforge/rapier3d-compat package folder');
  process.exit(0);
}
await mkdir(results, {recursive: true});
const server = await createServer({configFile: resolve(root, 'vite.config.js'), logLevel: 'error', server: {port: 0}});
await server.listen();
let browser;
try {
  const channel = process.env.BROWSER_CHANNEL ?? 'msedge';
  const args = process.env.BROWSER_ARGS ? JSON.parse(process.env.BROWSER_ARGS) : [];
  try {browser = await chromium.launch({headless: true, channel: channel === 'bundled' ? undefined : channel, executablePath: process.env.BROWSER_EXECUTABLE, args});}
  catch (error) {if (channel !== 'msedge' || args.length || process.env.BROWSER_CHANNEL) throw error; browser = await chromium.launch({headless: true});}
  const page = await browser.newPage({viewport: {width: 400, height: 400}, deviceScaleFactor: 1});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
  await page.goto(`${server.resolvedUrls.local[0]}tests/physics.html`);
  await page.waitForFunction(() => typeof window.runPhysicsTests === 'function', null, {timeout: 60000});
  const report = await page.evaluate(() => window.runPhysicsTests());
  await writeFile(resolve(results, 'physics-stack.png'), Buffer.from(report.image.split(',')[1], 'base64'));
  delete report.image;
  report.browser = browser.version();
  assert.deepEqual(errors, []);
  await writeFile(resolve(results, 'physics-browser.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`${report.checks.length} browser checks passed`);
} finally {
  await browser?.close();
  await server.close();
}
