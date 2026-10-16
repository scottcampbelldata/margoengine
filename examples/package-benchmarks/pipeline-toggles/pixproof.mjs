// From the repo root after build:packages and `node examples/package-benchmarks/pipeline-toggles/old-gltf.mjs`, under the GPU lock on AC:
// node examples/package-benchmarks/pipeline-toggles/pixproof.mjs - screenshots gltf-pro 15c87f1 vs working tree, same scene, compares bytes.
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { writeFile } from 'node:fs/promises';
import { decodePNG } from '../../../tests/support/png.js';
import { requireAC } from '../cad/power.mjs';
await writeFile(
  'test-results/pixproof.html',
  '<!doctype html><meta charset="utf-8"><style>body{margin:0}canvas{display:block;width:1280px;height:720px}</style><canvas id="view"></canvas><script type="module" src="/examples/package-benchmarks/pipeline-toggles/pixproof.js"></script>',
);
const server = await createServer({
  configFile: false,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 5294, strictPort: true, hmr: false, watch: { ignored: ['**'] } },
});
await server.listen();
const out = { acPowerAtStart: requireAC() },
  shots = {};
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const which of ['before', 'after', 'before']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 }),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto(`http://127.0.0.1:5294/test-results/pixproof.html?which=${which}`);
    await page.waitForFunction(() => window.result, null, { timeout: 120_000 });
    const r = await page.evaluate(() => window.result),
      png = await page.locator('canvas').screenshot();
    await writeFile(`test-results/pixproof-${which}.png`, png);
    const data = (await decodePNG(png)).data;
    if (shots[which]) out.beforeRepeatDiffers = shots[which].some((v, i) => v !== data[i]);
    shots[which] = data;
    out[which] = { gpuErrors: r.errors, pageErrors: errors };
    await page.close();
  }
  let n = 0,
    max = 0;
  for (let i = 0; i < shots.before.length; i++) {
    const d = Math.abs(shots.before[i] - shots.after[i]);
    if (d) {
      n++;
      max = Math.max(max, d);
    }
  }
  let lit = 0;
  for (let i = 0; i < shots.after.length; i += 4)
    if (shots.after[i] + shots.after[i + 1] + shots.after[i + 2] > 60) lit++;
  out.diff = { channels: n, max, of: shots.before.length, litPixels: lit };
} finally {
  await browser.close();
  await server.close();
}
out.acPowerAtEnd = requireAC();
console.log(JSON.stringify(out));
await writeFile('test-results/pixproof.json', JSON.stringify(out, null, 1));
