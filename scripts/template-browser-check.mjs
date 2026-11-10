import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { join, resolve } from 'node:path';
import { preview } from 'vite';
import { launchBrowser } from './lib/browser.mjs';
import { closeAll } from './support/shutdown.mjs';
import { killTree } from './gpu-lock.mjs';
import { decodePNG } from '../tests/support/png.js';
const results = resolve(import.meta.dirname, '../test-results/template-installs');
const report = JSON.parse(readFileSync(join(results, 'report.json'))),
  browser = await launchBrowser();
const frames = [];
try {
  for (const row of report.cases) {
    let server, child, timer, url;
    try {
      if (row.name === 'next') {
        const portServer = netServer();
        await new Promise((resolve) => portServer.listen(0, '127.0.0.1', resolve));
        const port = portServer.address().port;
        await new Promise((resolve) => portServer.close(resolve));
        url = `http://127.0.0.1:${port}/`;
        child = spawn(
          process.execPath,
          [
            join(row.app, 'node_modules/next/dist/bin/next'),
            'start',
            '--hostname',
            '127.0.0.1',
            '--port',
            String(port),
          ],
          {
            cwd: row.app,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
          },
        );
        timer = setTimeout(() => killTree(child.pid), 180000);
        await new Promise((ready, fail) => {
          let output = '';
          const deadline = setTimeout(() => fail(new Error('Next server startup timeout: ' + output)), 30000);
          const observe = (data) => {
            output += data;
            if (/Ready in/.test(output)) {
              clearTimeout(deadline);
              ready();
            }
          };
          child.stdout.on('data', observe);
          child.stderr.on('data', observe);
          child.once('error', (error) => {
            clearTimeout(deadline);
            fail(error);
          });
          child.once('exit', (code) => {
            clearTimeout(deadline);
            fail(new Error('Next server exited ' + code + ': ' + output));
          });
        });
      } else {
        server = await preview({
          root: row.app,
          configFile: false,
          logLevel: 'error',
          preview: { host: '127.0.0.1', port: 0, strictPort: false },
        });
        url = server.resolvedUrls.local[0];
      }
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } }),
        errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(url + '?quality=low', { timeout: 30000 });
      const canvas = page.locator('canvas').first();
      await canvas.waitFor({ timeout: 30000 });
      let drawn = false,
        png;
      const deadline = Date.now() + 60000;
      while (!drawn && Date.now() < deadline) {
        assert.deepEqual(errors, [], row.name);
        png = await canvas.screenshot({ timeout: 10000 });
        const shot = await decodePNG(png),
          colors = new Set();
        for (let y = 0; y < shot.height; y += 8)
          for (let x = 0; x < shot.width; x += 8) {
            const at = (y * shot.width + x) * 4;
            colors.add(`${shot.data[at] >> 4},${shot.data[at + 1] >> 4},${shot.data[at + 2] >> 4}`);
          }
        drawn = colors.size > 8;
      }
      writeFileSync(join(results, row.name + '.png'), png);
      assert.ok(drawn, row.name + ': no drawn geometry');
      assert.deepEqual(errors, [], row.name);
      if (row.name === 'game') assert.match(await page.locator('#hud').innerText(), /Orbs 0 \/ 6/);
      if (row.name === 'viz') assert.match(await page.locator('body').innerText(), /300,000 stars/);
      const error = page.locator('#error');
      if (await error.count()) assert.equal(await error.textContent(), '');
      frames.push(row.name);
      await page.close();
      console.log(row.name + ': first packed template frame passed');
    } finally {
      if (server) await closeAll({ servers: [server] });
      if (timer) clearTimeout(timer);
      if (child) killTree(child.pid);
    }
  }
  writeFileSync(join(results, 'frames.json'), JSON.stringify(frames, null, 2) + '\n');
} finally {
  await closeAll({ browser });
}
