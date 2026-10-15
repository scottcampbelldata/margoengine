// Real-GPU measurements for HANDOFF 1d''/1e.f. From the repo root after build:packages, under the GPU lock on AC:
//   node examples/package-benchmarks/pipeline-toggles/toggle.mjs [stall|pixels|gpu|override]...
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { writeFile } from 'node:fs/promises';
import { decodePNG } from '../../../tests/support/png.js';
import { requireAC } from '../cad/power.mjs';

const which = process.argv.slice(2).length ? process.argv.slice(2) : ['stall', 'pixels', 'gpu', 'override'];
await writeFile(
  'test-results/toggle.html',
  '<!doctype html><meta charset="utf-8"><style>body{margin:0}canvas{display:block;width:1280px;height:720px}</style><canvas id="view"></canvas><script type="module" src="/examples/package-benchmarks/pipeline-toggles/toggle.js"></script>',
);
const server = await createServer({
  configFile: false,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 5293, strictPort: true, hmr: false, watch: { ignored: ['**'] } },
});
await server.listen();
const out = { acPowerAtStart: requireAC(), date: new Date().toISOString() };
const open = async () => {
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--disable-gpu-vsync', '--disable-frame-rate-limit'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(300_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('http://127.0.0.1:5293/test-results/toggle.html');
  await page.waitForFunction(() => window.ready);
  out.browser ??= browser.version();
  out.adapter ??= await page.evaluate(
    async () => (await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })).info.description,
  );
  return { browser, page, errors };
};
try {
  if (which.includes('stall')) {
    // A fresh browser per run, so its pipeline caches start cold; the two ways alternate.
    out.stall = [];
    for (let r = 0; r < 5; r++)
      for (const mode of r % 2 ? ['toggle', 'add'] : ['add', 'toggle']) {
        const { browser, page, errors } = await open();
        const result = await page.evaluate((m) => window.measure.stall(m), mode);
        result.pageErrors = errors;
        out.stall.push(result);
        console.log(JSON.stringify(result));
        await browser.close();
      }
  }
  if (which.includes('pixels')) {
    const { browser, page, errors } = await open(),
      shot = async () => (await decodePNG(await page.locator('canvas').screenshot())).data;
    await page.evaluate(() => window.measure.pixels(0));
    const none = await shot();
    await page.evaluate(() => window.measure.pixels(1));
    const off = await shot();
    const gpuErrors = await page.evaluate(() => window.measure.pixels(2));
    const on = await shot();
    const diff = (a, b) => {
      let n = 0,
        max = 0;
      for (let i = 0; i < a.length; i++) {
        const d = Math.abs(a[i] - b[i]);
        if (d) {
          n++;
          max = Math.max(max, d);
        }
      }
      return { channels: n, max };
    };
    out.pixels = { absentVsOff: diff(none, off), absentVsOn: diff(none, on), gpuErrors, pageErrors: errors };
    console.log(JSON.stringify(out.pixels));
    await browser.close();
  }
  if (which.includes('gpu')) {
    const { browser, page, errors } = await open();
    out.gpu = await page.evaluate(() => window.measure.gpu(6));
    out.gpu.pageErrors = errors;
    console.log(JSON.stringify(out.gpu));
    await browser.close();
  }
  if (which.includes('override')) {
    const { browser, page, errors } = await open();
    out.override = await page.evaluate(() => window.measure.override(8));
    out.override.pageErrors = errors;
    console.log(JSON.stringify(out.override));
    await browser.close();
  }
  if (which.includes('override2')) {
    const { browser, page, errors } = await open();
    out.override2 = await page.evaluate(() => window.measure.override2(10));
    out.override2.pageErrors = errors;
    console.log(JSON.stringify(out.override2));
    await browser.close();
    const second = await open(),
      shot = async () => (await decodePNG(await second.page.locator('canvas').screenshot())).data,
      shots = {};
    for (const name of ['uniform', 'noDiscard', 'rest']) {
      await second.page.evaluate((n) => window.measure.shotVariant(n), name);
      shots[name] = await shot();
    }
    const diff = (a, b) => {
      let n = 0,
        max = 0;
      for (let i = 0; i < a.length; i++) {
        const d = Math.abs(a[i] - b[i]);
        if (d) {
          n++;
          max = Math.max(max, d);
        }
      }
      return { channels: n, max };
    };
    out.override2Pixels = {
      noDiscard: diff(shots.uniform, shots.noDiscard),
      rest: diff(shots.uniform, shots.rest),
      pageErrors: second.errors,
    };
    console.log(JSON.stringify(out.override2Pixels));
    await second.browser.close();
  }
} finally {
  await server.close();
}
out.acPowerAtEnd = requireAC();
await writeFile(`test-results/toggle-${which.join('-')}.json`, JSON.stringify(out, null, 1));
