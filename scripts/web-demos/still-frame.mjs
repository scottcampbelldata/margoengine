#!/usr/bin/env node
// One frame of a demo with the clock stopped: node scripts/web-demos/still-frame.mjs <demo> <backend> <root> <out.raw>
// performance.now, Date.now and rAF timestamps are frozen, so every frame after ready draws the same moment; the
// canvas is captured after 20 frames and written as raw RGBA, and its SHA-256 printed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';

const [demo, backend, rootArg, out] = process.argv.slice(2);
const root = path.resolve(rootArg);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  let file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!file.startsWith(root) || !fs.existsSync(file)) return res.writeHead(404), res.end();
  res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
server.listen(0);
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--enable-unsafe-webgpu', '--window-size=1500,1000', '--disable-features=CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const now = 1000;
    performance.now = () => now;
    Date.now = () => 1764300000000;
    const raf = window.requestAnimationFrame.bind(window);
    window.__frames = 0;
    window.requestAnimationFrame = (f) => raf(() => (window.__frames++, f(now)));
  });
  await page.goto(`http://localhost:${server.address().port}/${demo}/${backend === 'webgl2' ? '?backend=webgl2' : ''}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true' || document.querySelector('[data-state="ready"]'), null, { timeout: 300000, polling: 500 });
  const start = await page.evaluate(() => window.__frames);
  await page.waitForFunction((n) => window.__frames >= n, start + 20, { timeout: 120000, polling: 100 });
  const png = await page.locator('canvas').first().screenshot();
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  fs.writeFileSync(out, data);
  console.log(`${demo} ${backend} ${path.basename(root)} ${info.width}x${info.height} ${crypto.createHash('sha256').update(data).digest('hex').slice(0, 16)}`);
} finally {
  await browser.close();
  server.close();
}
