#!/usr/bin/env node
// Captures gallery thumbnails from the real pages: node scripts/web-demos/thumbnail.mjs <demo> [demo...] | --all
//
// Serves demos/ locally, opens each page in Chrome with WebGPU, waits until the exhibit is marked ready
// (`data-ready` or `data-state="ready"`) plus a settle time, then crops the rendered scene (the largest visible
// canvas, with any control laid over it hidden) to the gallery's 900 x 579 card with cover fit, and writes
// demos/thumbs/<demo>.jpg.
// Options: --settle=<ms> (default 2500), --timeout=<ms> per page (default 60000), --url-suffix=<query> (e.g. ?view=x).
// Boxes laid over the scene (controls, captions, labels) are hidden for the shot; other canvases stay.
// A page that fails to become ready or shows an error keeps its old thumbnail and the run exits 1.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { closeAll } from '../support/shutdown.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const demos = path.resolve(here, '../../demos');
const WIDTH = 900,
  HEIGHT = 579;

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const settle = Number(option('settle', 2500));
const timeout = Number(option('timeout', 60000));
const suffix = option('url-suffix', '');
let names = args.filter((a) => !a.startsWith('--'));
if (args.includes('--all'))
  names = fs.readdirSync(demos).filter((n) => fs.existsSync(path.join(demos, n, 'index.html')));
if (!names.length) {
  console.error('usage: node scripts/web-demos/thumbnail.mjs <demo> [demo...] | --all [--settle=ms] [--timeout=ms]');
  process.exitCode = 2;
} else await capture();

async function capture() {
  const types = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
  };
  const server = http
    .createServer((req, res) => {
      let file = path.join(demos, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!file.startsWith(demos)) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!fs.existsSync(file)) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    })
    .listen(0);
  const { port } = server.address();

  const failed = [];
  let browser;
  try {
    // Installed Chrome has a working WebGPU adapter; Playwright's bundled Chromium is the fallback.
    const launch = { headless: false, args: ['--enable-unsafe-webgpu', '--window-size=1500,1000'] };
    browser = await chromium.launch({ ...launch, channel: 'chrome' }).catch(() => chromium.launch(launch));
    for (const name of names) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      try {
        await page.goto(`http://localhost:${port}/${name}/${suffix}`, { waitUntil: 'load', timeout });
        const state = await page
          .waitForFunction(
            () => {
              if (document.querySelector('[data-error], [data-state="error"]')) return 'error';
              return document.querySelector('[data-ready], [data-state="ready"]') ? 'ready' : false;
            },
            null,
            { timeout },
          )
          .then((h) => h.jsonValue());
        if (state !== 'ready') throw new Error('the page reported an error');
        await page.waitForTimeout(settle);
        const box = await page.evaluate(() => {
          let best = null;
          for (const c of document.querySelectorAll('canvas')) {
            const r = c.getBoundingClientRect();
            if (
              r.width * r.height > (best ? best.width * best.height : 0) &&
              getComputedStyle(c).visibility !== 'hidden'
            )
              best = { canvas: c, x: r.x, y: r.y + scrollY, width: r.width, height: r.height };
          }
          if (!best) return null;
          // Anything laid over the scene (a view button, a toolbar, a caption, a coordinates label) is page chrome, not the
          // picture: hide each box beside the canvas's own ancestors that overlaps it. Other canvases (a 2D label or trail
          // layer drawn by the scene) and boxes holding one are part of the picture and stay.
          const { canvas, ...rect } = best, area = canvas.getBoundingClientRect();
          const overlaps = (r) => r.right > area.left && r.left < area.right && r.bottom > area.top && r.top < area.bottom;
          for (let holder = canvas.parentElement; holder; holder = holder.parentElement) {
            for (const el of holder.children) {
              if (el.contains(canvas) || el.matches('canvas') || el.querySelector('canvas')) continue;
              if (overlaps(el.getBoundingClientRect())) el.style.visibility = 'hidden';
            }
          }
          return rect;
        });
        if (!box || box.width < 200) throw new Error('no rendered canvas on the page');
        const shot = await page.screenshot({ clip: box, fullPage: true });
        await sharp(shot)
          .resize(WIDTH, HEIGHT, { fit: 'cover', position: 'centre' })
          .jpeg({ quality: 84, mozjpeg: true })
          .toFile(path.join(demos, 'thumbs', `${name}.jpg`));
        console.log(`thumb ${name}`);
      } catch (error) {
        failed.push(name);
        console.error(`FAILED ${name}: ${error.message}${errors.length ? ` (${errors[0]})` : ''}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await closeAll({ browser, servers: [server] });
  }
  if (failed.length) {
    console.error(`${failed.length} kept their old thumbnail: ${failed.join(' ')}`);
    process.exitCode = 1;
  }
}
