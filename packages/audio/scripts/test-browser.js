import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { createServer } from 'vite';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const results = resolve(root, 'test-results');
await mkdir(results, { recursive: true });
const server = await createServer({
  configFile: resolve(root, 'vite.config.js'),
  logLevel: 'error',
  server: { port: 0 },
});
await server.listen();
let browser;
try {
  const args = process.env.BROWSER_ARGS ? JSON.parse(process.env.BROWSER_ARGS) : [];
  // Sound must be able to start without a click for the live checks; the gesture check clicks for real anyway.
  if (!args.includes('--autoplay-policy=no-user-gesture-required'))
    args.push('--autoplay-policy=no-user-gesture-required');
  browser = await launchBrowser({
    headless: true,
    args,
  });
  const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && !response.url().endsWith('/favicon.ico'))
      errors.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(`${server.resolvedUrls.local[0]}tests/audio.html`);
  await page.waitForFunction(() => typeof window.runOfflineTests === 'function');
  const report = { checks: [] };
  report.offline = await page.evaluate(() => window.runOfflineTests());
  report.checks.push(...report.offline.checks);
  report.engine = await page.evaluate(() => window.runEngineTests());
  report.checks.push(...report.engine.checks);
  report.occlusion = await page.evaluate(() => window.runOcclusionTests());
  report.doppler = await page.evaluate(() => window.runDopplerTests());
  report.events = await page.evaluate(() => window.runEventTests());
  report.music = await page.evaluate(() => window.runMusicTests());
  report.zones = await page.evaluate(() => window.runZoneTests());
  report.ambisonics = await page.evaluate(() => window.runAmbisonicTests());
  assert.equal(await page.evaluate(() => window.prepareGesture()), 'suspended');
  await page.mouse.click(20, 20);
  assert.equal(await page.evaluate(() => window.checkGesture()), 'running');
  report.checks.push('A suspended context resumes on the first real pointer gesture');
  report.browser = browser.version();
  assert.deepEqual(errors, []);
  await writeFile(resolve(results, 'audio-browser.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await closeAll({ browser, servers: [server] });
}
