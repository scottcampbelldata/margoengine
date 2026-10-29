// Real-browser check of every scaffolded Vite template under `vite` dev, as a user first runs it, timed from
// `create-margo` to the first drawn frame. From the repository root, after `npm run build:packages`, with the GPU lock
// held: node tools/create-margo/test/browser-check.mjs [template ...]
// Apps go to test-results/create-margo-<template>, so their imports resolve to this checkout's packages (no install).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { decodePNG } from '../../../tests/support/png.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

const root = resolve(import.meta.dirname, '../../..');
// What each template must show once it runs: a selector and the text it holds.
const templates = {
  web: { text: null },
  game: { selector: '#hud', text: /Orbs 0 \/ 6/ },
  viz: { selector: 'body', text: /300,000 stars/ },
  react: { text: null },
};
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(templates);
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? 'msedge', headless: true });
const report = [];
try {
  for (const [i, name] of names.entries()) {
    const app = join(root, `test-results/create-margo-${name}`);
    rmSync(app, { recursive: true, force: true });
    const t0 = performance.now();
    execFileSync(process.execPath, [join(root, 'tools/create-margo/index.js'), app, '--template', name]);
    const created = performance.now();
    const port = 5241 + i;
    const server = await createServer({
      root: app,
      server: { host: '127.0.0.1', port, strictPort: true },
      logLevel: 'error',
    });
    await server.listen();
    const ready = performance.now();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 }),
        errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      await page.goto(`http://127.0.0.1:${port}/?quality=low`);
      // The first drawn frame: the canvas shows more than one colour.
      let first = 0,
        png;
      for (const deadline = performance.now() + 60_000; performance.now() < deadline; ) {
        const canvas = page.locator('canvas').first();
        if (await canvas.count()) {
          png = await canvas.screenshot();
          const shot = await decodePNG(png);
          const lum = [];
          for (let y = 0; y < shot.height; y += 24)
            for (let x = 0; x < shot.width; x += 24) {
              const o = (y * shot.width + x) * 4;
              lum.push(shot.data[o] * 0.3 + shot.data[o + 1] * 0.59 + shot.data[o + 2] * 0.11);
            }
          const mean = lum.reduce((a, b) => a + b, 0) / lum.length;
          if (Math.sqrt(lum.reduce((a, b) => a + (b - mean) ** 2, 0) / lum.length) > 8) {
            first = performance.now();
            break;
          }
        }
        await page.waitForTimeout(100);
      }
      assert.ok(first, `${name}: no drawn frame within 60 s (${errors.join('; ')})`);
      await page.waitForTimeout(2500); // let models, physics and bloom settle for the screenshot
      png = await page.locator('canvas').first().screenshot();
      writeFileSync(join(root, `test-results/create-margo-${name}.png`), png);
      const error = page.locator('#error');
      if (await error.count()) assert.equal(await error.textContent(), '', `${name}: start error`);
      const { selector, text } = templates[name];
      if (text) assert.match(await page.locator(selector).first().innerText(), text, `${name}: ${selector}`);
      if (name === 'web') {
        const shot = await decodePNG(png),
          at = (x, y) => [...shot.data.slice((y * shot.width + x) * 4, (y * shot.width + x) * 4 + 3)];
        const knot = at(shot.width >> 1, Math.round(shot.height * 0.38));
        assert.ok(knot[0] > knot[2] + 30 && knot[0] > 60, `web: gold knot in the middle, got ${knot}`);
      }
      assert.deepEqual(
        errors.filter((e) => !/powerPreference option is currently ignored/.test(e)),
        [],
        `${name}: console errors`,
      );
      const ms = (t) => Math.round(t);
      report.push(
        `${name}: create ${ms(created - t0)} ms, dev server ${ms(ready - created)} ms, first frame ${ms(first - ready)} ms after the server, ${ms(first - t0)} ms in all`,
      );
      await page.close();
    } finally {
      await closeAll({ servers: [server] });
    }
  }
  console.log(report.join('\n'));
  console.log('create-margo browser check passed');
} finally {
  await closeAll({ browser });
}
