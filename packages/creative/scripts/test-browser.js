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
  try {browser = await chromium.launch({headless: true, channel: channel === 'bundled' ? undefined : channel, args});}
  catch (error) {if (channel !== 'msedge' || args.length || process.env.BROWSER_CHANNEL) throw error; browser = await chromium.launch({headless: true});}
  const page = await browser.newPage({viewport: {width: 800, height: 600}, deviceScaleFactor: 1});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
  await page.route('**/tests/slow-map.png', () => {});
  await page.goto(`${server.resolvedUrls.local[0]}tests/planet.html`);
  await page.waitForFunction(() => typeof window.runPlanetTests === 'function');
  const checks = await page.evaluate(() => window.runPlanetTests());
  await page.goto(`${server.resolvedUrls.local[0]}examples/earth/`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true' || document.body.dataset.error === 'true');
  assert.equal(await page.locator('body').getAttribute('data-error'), null, await page.locator('#error').textContent());
  await page.locator('#pause').click();
  assert.equal(await page.locator('#pause').getAttribute('aria-pressed'), 'true');
  await page.locator('#pause').click();
  assert.equal(await page.locator('#pause').getAttribute('aria-pressed'), 'false');
  await page.locator('#sun').focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#sun-value').textContent(), '-109°');
  await page.locator('#rotation').focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#rotation-value').textContent(), '1.1×');
  await page.locator('canvas').focus();
  for (const key of ['ArrowRight', '+', 'Home']) await page.keyboard.press(key);
  await page.locator('#reset').click();
  await page.setViewportSize({width: 520, height: 800});
  await page.waitForFunction(() => {const canvas = document.querySelector('canvas'); return canvas.width > 0 && Math.abs(canvas.width - canvas.clientWidth) <= 1;});
  assert.equal(await page.locator('body').getAttribute('data-error'), null);
  await page.setViewportSize({width: 1280, height: 900});
  checks.framePacing = await page.evaluate(() => new Promise(resolve => {
    const intervals = []; let previous;
    const frame = time => {
      if (previous !== undefined) intervals.push(time - previous);
      previous = time;
      if (intervals.length < 180) {requestAnimationFrame(frame); return;}
      const sorted = [...intervals].sort((a, b) => a - b);
      resolve({frames: intervals.length, averageFPS: 1000 * intervals.length / intervals.reduce((total, value) => total + value, 0), p50Ms: sorted[90], p95Ms: sorted[171]});
    };
    requestAnimationFrame(frame);
  }));
  await page.screenshot({path: resolve(results, 'earth-demo.png'), fullPage: true});
  await page.evaluate(() => {
    const original = GPUQueue.prototype.writeBuffer;
    window.planetZoomCheck = {minimumDistance: Infinity, restore() {GPUQueue.prototype.writeBuffer = original;}};
    GPUQueue.prototype.writeBuffer = function (...args) {
      const data = args[2];
      if (data instanceof Float32Array && data.length === 48) window.planetZoomCheck.minimumDistance = Math.min(window.planetZoomCheck.minimumDistance, Math.hypot(data[32], data[33], data[34]));
      return original.apply(this, args);
    };
  });
  const canvasBounds = await page.locator('canvas').boundingBox();
  await page.mouse.move(canvasBounds.x + canvasBounds.width / 2, canvasBounds.y + canvasBounds.height / 2);
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, -500);
  const distance = await page.evaluate(() => {const result = window.planetZoomCheck.minimumDistance; window.planetZoomCheck.restore(); return result;});
  assert.ok(distance >= 1.1 - 1e-5 && distance < 2, `Demo wheel zoom entered the atmosphere shell: ${distance}`);
  checks.minimumDemoZoomDistance = distance;
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  assert.equal(await page.locator('#viewport canvas').count(), 0, 'Demo teardown left its owned canvas');
  checks.checks.push('Earth demo startup, pause, sliders, keyboard, resize, exterior zoom limit and teardown');
  assert.deepEqual(errors, []);
  await writeFile(resolve(results, 'planet-browser.json'), JSON.stringify(checks, null, 2));
  console.log(JSON.stringify(checks, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
