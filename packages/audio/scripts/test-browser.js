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
  // Sound must be able to start without a click for the live checks; the gesture check clicks for real anyway.
  if (!args.includes('--autoplay-policy=no-user-gesture-required')) args.push('--autoplay-policy=no-user-gesture-required');
  try {browser = await chromium.launch({headless: true, channel: channel === 'bundled' ? undefined : channel, executablePath: process.env.BROWSER_EXECUTABLE, args});}
  catch (error) {if (channel !== 'msedge' || process.env.BROWSER_ARGS || process.env.BROWSER_CHANNEL) throw error; browser = await chromium.launch({headless: true, args});}
  const page = await browser.newPage({viewport: {width: 640, height: 480}, deviceScaleFactor: 1});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
  page.on('response', response => {if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) errors.push(`${response.status()} ${response.url()}`);});
  await page.goto(`${server.resolvedUrls.local[0]}tests/audio.html`);
  await page.waitForFunction(() => typeof window.runOfflineTests === 'function');
  const report = {checks: []};
  report.offline = await page.evaluate(() => window.runOfflineTests());
  report.checks.push(...report.offline.checks);
  report.engine = await page.evaluate(() => window.runEngineTests());
  report.checks.push(...report.engine.checks);
  assert.equal(await page.evaluate(() => window.prepareGesture()), 'suspended');
  await page.mouse.click(20, 20);
  assert.equal(await page.evaluate(() => window.checkGesture()), 'running');
  report.checks.push('A suspended context resumes on the first real pointer gesture');
  report.browser = browser.version();
  assert.deepEqual(errors, []);
  await writeFile(resolve(results, 'audio-browser.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
