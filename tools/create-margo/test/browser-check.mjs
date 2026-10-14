// Real-browser check of the scaffolded app under `vite` dev, as a user first runs it. From the repository root, after
// `npm run build:packages`, with the GPU lock held: node tools/create-margo/test/browser-check.mjs
// The app goes to test-results/create-margo-app, so its imports resolve to this checkout's packages.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {decodePNG} from '../../../tests/support/png.js';

const root = resolve(import.meta.dirname, '../../..'), app = join(root, 'test-results/create-margo-app');
rmSync(app, {recursive: true, force: true});
execFileSync(process.execPath, [join(root, 'tools/create-margo/index.js'), app]);
const server = await createServer({root: app, server: {host: '127.0.0.1', port: 5241, strictPort: true}, logLevel: 'error'});
await server.listen();
const browser = await chromium.launch({channel: process.env.BROWSER_CHANNEL ?? 'msedge', headless: true});
try {
  const page = await browser.newPage({viewport: {width: 1280, height: 720}, deviceScaleFactor: 1}), errors = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => {if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text());});
  await page.goto('http://127.0.0.1:5241/?quality=low');
  console.log('adapter', JSON.stringify(await page.evaluate(async () => {const i = (await navigator.gpu?.requestAdapter())?.info; return i && {vendor: i.vendor, architecture: i.architecture, description: i.description};})));
  await page.waitForTimeout(3000);
  assert.equal(await page.locator('#error').textContent(), '', 'start error');
  // Frames delivered in 2 s while the knot spins (the light tier paces to ~60).
  const fps = await page.evaluate(() => new Promise(done => {let n = 0; const t0 = performance.now(); const tick = () => {n++; if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else done(n / ((performance.now() - t0) / 1000));}; requestAnimationFrame(tick);}));
  const overlay = await page.evaluate(() => [...document.body.children].filter(e => e.tagName === 'DIV').map(e => e.textContent).join(' | '));
  assert.ok(overlay.length > 0, 'stats overlay present');
  const png = await page.locator('canvas').first().screenshot(); writeFileSync(join(root, 'test-results/create-margo.png'), png);
  const shot = await decodePNG(png), at = (x, y) => [...shot.data.slice((y * shot.width + x) * 4, (y * shot.width + x) * 4 + 3)];
  const background = at(10, 10), knot = at(shot.width >> 1, Math.round(shot.height * 0.38));
  console.log({fps: Math.round(fps), overlay, background, knot});
  assert.ok(knot[0] > knot[2] + 30 && knot[0] > 90, `gold knot in the middle, got ${knot}`);
  assert.ok(Math.abs(knot[0] - background[0]) > 40, 'knot differs from background');
  assert.deepEqual(errors.filter(e => !/powerPreference option is currently ignored/.test(e)), []);
  console.log('create-margo browser check passed');
} finally {await browser.close(); await server.close();}
