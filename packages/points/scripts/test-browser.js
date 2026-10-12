import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const results = resolve(root, 'test-results');
await mkdir(results, {recursive: true});
const server = await createServer({configFile: resolve(root, 'vite.config.js'), logLevel: 'error', server: {port: 0}});
await server.listen();
let browser;
try {
  const channel = process.env.BROWSER_CHANNEL ?? 'msedge';
  const args = process.env.BROWSER_ARGS ? JSON.parse(process.env.BROWSER_ARGS) : [];
  try {browser = await chromium.launch({headless: true, channel: channel === 'bundled' ? undefined : channel, executablePath: process.env.BROWSER_EXECUTABLE, args});}
  catch (error) {if (channel !== 'msedge' || args.length || process.env.BROWSER_CHANNEL) throw error; browser = await chromium.launch({headless: true});}
  const page = await browser.newPage({viewport: {width: 700, height: 700}, deviceScaleFactor: 1});
  page.setDefaultTimeout(600_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
  await page.goto(`${server.resolvedUrls.local[0]}tests/points.html`);
  await page.waitForFunction(() => typeof window.runPointTests === 'function');
  const report = await page.evaluate(() => window.runPointTests());
  report.gallery = await page.evaluate(() => window.runGallery());
  assert.deepEqual(report.gallery.errors, []);
  assert.ok(report.gallery.lit > 20000, `Gallery drew too little: ${report.gallery.lit} pixels`);
  report.checks.push('Gallery (EDL terrain, sphere impostors, round and textured points, atlas sprites) renders without validation errors');
  await page.locator('#gallery').screenshot({path: resolve(results, 'points-gallery.png')});
  report.browser = browser.version();
  assert.deepEqual(errors, []);
  await writeFile(resolve(results, 'points-browser.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`${report.checks.length} browser checks passed`);
} finally {
  await browser?.close();
  await server.close();
}
