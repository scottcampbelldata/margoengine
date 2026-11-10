// GPU-only half of kit-install-check. Preparation holds no GPU slot.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { preview } from 'vite';
import { launchBrowser } from './lib/browser.mjs';
import { closeAll } from './support/shutdown.mjs';
import { decodePNG } from '../tests/support/png.js';
import { RESULTS } from './kit-install-check.mjs';

const report = JSON.parse(readFileSync(join(RESULTS, 'report.json'), 'utf8'));
const browser = await launchBrowser(), frames = [];
try {
  for (const row of report.cases) {
    const variants = ['dist', ...(['game', 'web', 'viz', 'react-kit'].includes(row.name) ? ['dist-compat'] : [])];
    for (const variant of variants) {
      const server = await preview({ root: row.app, configFile: false, logLevel: 'error',
        build: { outDir: variant }, preview: { host: '127.0.0.1', port: 0, strictPort: false } });
      try {
        const page = await browser.newPage({ viewport: { width: 256, height: 256 } }), errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(server.resolvedUrls.local[0], { timeout: 30000 });
        const canvas = page.locator('canvas').first();
        await canvas.waitFor({ timeout: 30000 });
        const deadline = Date.now() + 60000;
        let nonuniform = false, png;
        while (!nonuniform && Date.now() < deadline) {
          assert.deepEqual(errors, [], `${row.name} ${variant}`);
          png = await canvas.screenshot({ timeout: 10000 });
          const { data, width, height } = await decodePNG(png);
          const colors = new Set();
          for (let y = 0; y < height; y += 4) for (let x = 0; x < width; x += 4) {
            const at = (y * width + x) * 4;
            colors.add(`${data[at] >> 4},${data[at + 1] >> 4},${data[at + 2] >> 4}`);
          }
          nonuniform = colors.size > 8;
        }
        writeFileSync(join(RESULTS, `${row.name}-${variant}.png`), png);
        assert.ok(nonuniform, `${row.name} ${variant}: no drawn geometry`);
        assert.deepEqual(errors, [], `${row.name} ${variant}`);
        frames.push(`${row.name}/${variant}`);
        await page.close();
      } finally { await closeAll({ servers: [server] }); }
    }
  }
  writeFileSync(join(RESULTS, 'frames.json'), JSON.stringify(frames, null, 2) + '\n');
  console.log(`Packed first frames: ${frames.join(', ')}`);
} finally { await closeAll({ browser }); }
