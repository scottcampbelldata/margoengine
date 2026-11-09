import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { trackPipelines } from '../../../scripts/support/gpu-ready.js';
import { decodePNG } from '../../../tests/support/png.js';

const cacheDir = await mkdtemp(join(tmpdir(), 'margo-road-'));
const server = await createServer({
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  cacheDir,
  configFile: false,
  logLevel: 'error',
  optimizeDeps: { entries: [], noDiscovery: true, include: [] },
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  plugins: [
    {
      name: 'road-check',
      configureServer(s) {
        s.middlewares.use('/road-check', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end(
            '<!doctype html><title>Road backend proof</title><style>body{margin:0}canvas{width:128px;height:128px}</style><canvas></canvas>',
          );
        });
      },
    },
  ],
});
let browser;
const failures = [];
try {
  await server.listen();
  browser = await launchBrowser();
  for (const mode of ['native', 'compat']) {
    const page = await browser.newPage({ viewport: { width: 128, height: 128 } });
    page.setDefaultTimeout(120000);
    page.on('pageerror', (e) => failures.push(e.message));
    await page.addInitScript(trackPipelines);
    await page.goto(server.resolvedUrls.local[0] + 'road-check');
    const result = await page.evaluate(async (mode) => {
      const { Engine, PbrMaterial } = await import('/packages/core/dist/index.js');
      const { junctions } = await import('/packages/road/dist/junctions.js');
      const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
      if (mode === 'compat') {
        const { install } = await import('/packages/webgl2-compat/dist/index.js');
        const installed = await install({ force: true });
        if (!installed.installed) throw new Error(installed.reason);
      }
      const engine = await Engine.create(document.querySelector('canvas'), {
        backend: 'webgpu',
        exactSize: [128, 128],
        camera: { fov: 45, position: [0, 30, 0.001], target: [0, 0, 0], near: 0.1, far: 100 },
      });
      engine.onError = (e) => {
        throw e;
      };
      const data = await junctions([
        {
          points: [
            [-10, 0],
            [10, 0],
          ],
          width: 4,
        },
        {
          points: [
            [0, -10],
            [0, 10],
          ],
          width: 4,
        },
      ]);
      const mesh = engine
        .createMesh()
        .setGeometry(data.geometry)
        .setMaterial(new PbrMaterial({ color: '#ff0000' }));
      const draw = () =>
        waitForPipelines(async () => {
          engine.render({ delta: 0 });
          await engine.gpu.queue.onSubmittedWorkDone();
        });
      window.check = {
        engine,
        mesh,
        data,
        draw,
        async reboot() {
          await engine.rebootDevice();
          await draw();
        },
        async remove() {
          mesh.dispose();
          mesh.dispose();
          await draw();
        },
        dispose() {
          engine.dispose();
          engine.dispose();
          return engine.disposed;
        },
      };
      await draw();
      return { area: data.area, backend: engine.backend, vendor: engine.gpu.adapterInfo?.vendor };
    }, mode);
    assert.equal(result.area, 144);
    assert.equal(result.backend, 'webgpu');
    assert.equal(result.vendor === 'margo-webgl2', mode === 'compat');
    const pixels = () => page.locator('canvas').screenshot().then(decodePNG);
    const first = await pixels();
    const rgb = (p, x, y) => Array.from(p.data.subarray((y * p.width + x) * 4, (y * p.width + x) * 4 + 3));
    for (const [x, y] of [
      [64, 64],
      [24, 64],
      [104, 64],
      [64, 24],
      [64, 104],
    ]) {
      const [r, g, b] = rgb(first, x, y);
      assert.ok(r > g + 30 && r > b + 30, `${mode}: road covers ${x},${y}: ${r},${g},${b}`);
    }
    assert.ok(rgb(first, 100, 100)[0] < 40, `${mode}: corner outside road stays clear`);
    await page.evaluate(() => window.check.reboot());
    assert.deepEqual((await pixels()).data, first.data, `${mode}: retained geometry survives device reboot`);
    await page.evaluate(() => window.check.remove());
    const removed = await pixels();
    assert.ok(rgb(removed, 64, 64)[0] < 40, `${mode}: disposed mesh leaves no road`);
    assert.equal(await page.evaluate(() => window.check.dispose()), true);
    console.log(
      `PASS junctions ${mode}: five road pixels, clear outside, exact reboot pixels, disposal; area ${result.area}`,
    );
    await page.close();
  }
  assert.deepEqual(failures, []);
} finally {
  await closeAll({ browser, servers: [server] });
  await rm(cacheDir, { recursive: true, force: true });
}
