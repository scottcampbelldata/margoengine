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
  for (const samples of [1, 4]) {
    const page = await browser.newPage({viewport: {width: 400, height: 400}, deviceScaleFactor: 1, ...(samples === 1 ? {userAgent: 'iPhone Mobile'} : {})});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
    await page.goto(`${server.resolvedUrls.local[0]}tests/lines.html`);
    await page.waitForFunction(() => typeof window.runLineTests === 'function');
    const report = await page.evaluate(() => window.runLineTests());
    assert.equal(report.samples, samples);
    report.gallery = await page.evaluate(() => window.runGallery());
    assert.deepEqual(report.gallery.errors, []);
    assert.ok(report.gallery.nearPlane.clipped > 200 && report.gallery.nearPlane.mirrored === 0, `Near-plane clipping failed: ${JSON.stringify(report.gallery.nearPlane)}`);
    report.checks.push('Line crossing the camera plane is clipped at the near plane');
    await page.locator('#gallery').screenshot({path: resolve(results, samples === 4 ? 'lines-gallery.png' : 'lines-gallery-mobile.png')});
    report.browser = browser.version();
    assert.deepEqual(errors, []);
    await writeFile(resolve(results, samples === 4 ? 'lines-browser.json' : 'lines-browser-mobile.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    console.log(`${report.checks.length} browser checks passed`);
    await page.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
