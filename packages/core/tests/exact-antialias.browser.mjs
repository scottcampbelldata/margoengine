// Regression (GAP-FILM-MSAA, 2026-11-26): `exactSize` meant both "the backbuffer keeps its size" and "1 sample", so a
// fixed-size film frame could not have MSAA (the Film Studio scaled a canvas with a CSS transform instead). The two are
// now separate: `antialias: true` with `exactSize` keeps the fixed backbuffer and draws the tier's 4x MSAA. This suite
// draws a tilted white box on black into a 64 x 32 backbuffer under a 256 x 128 CSS box, on native WebGPU and on the
// WebGL2 compatibility layer: with `antialias: true` the size stays 64 x 32 over several frames and the box edges carry
// intermediate greys; with `exactSize` alone the frame keeps only the two colours (no MSAA), as before.
//   node scripts/run-with-timeout.mjs -- node packages/core/tests/exact-antialias.browser.mjs
//   (or `npm run test:gpu` in packages/core)
// MARGO_COMPAT not applicable: the script runs its own WebGL2-layer leg (install({ force: true })) beside native WebGPU.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createServer } from 'vite';
import { noFileWatcher } from '../../../scripts/support/no-file-watcher.js';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { trackPipelines } from '../../../scripts/support/gpu-ready.js';

const root = fileURLToPath(new URL('../../..', import.meta.url)),
  results = join(root, 'test-results');
await mkdir(results, { recursive: true });
const cacheDir = await mkdtemp(join(results, 'exact-antialias-'));
const server = await createServer({
  root,
  cacheDir,
  configFile: false,
  logLevel: 'error',
  optimizeDeps: { entries: [], noDiscovery: true },
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  plugins: [
    noFileWatcher(),
    {
      name: 'exact-antialias-page',
      configureServer(s) {
        s.middlewares.use('/exact-antialias', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><body style="margin:0"></body>');
        });
      },
    },
  ],
});
let browser;
try {
  await server.listen();
  browser = await launchBrowser();
  for (const mode of ['native', 'compat']) {
    const page = await browser.newPage(),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(trackPipelines);
    await page.goto(server.resolvedUrls.local[0] + 'exact-antialias');
    const result = await page.evaluate(async (mode) => {
      const { Engine, box } = await import('/packages/core/dist/index.js');
      const { sceneSamples } = await import('/packages/core/dist/quality.js');
      const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
      if (mode === 'compat') {
        const { install } = await import('/packages/webgl2-compat/dist/index.js');
        const installed = await install({ force: true });
        if (!installed.installed) throw new Error(installed.reason);
      }
      const draw = async (antialias) => {
        const canvas = document.createElement('canvas');
        canvas.style.cssText = 'width:256px;height:128px';
        document.body.append(canvas);
        const engine = await Engine.create(canvas, {
          exactSize: [64, 32],
          ...(antialias === undefined ? {} : { antialias }),
          camera: { position: [0, 0, 6], target: [0, 0, 0] },
        });
        engine.onError = (e) => {
          throw e;
        };
        const device = engine.gpu;
        device.pushErrorScope('validation');
        try {
          const mesh = engine
            .createMesh()
            .setGeometry(box(3, 3, 0.1))
            .setRotation([0, 0, 0.5]);
          mesh.material.set({ color: '#ffffff', roughness: 1, metalness: 0 });
          engine.scene.background = '#000000';
          const frame = async () => {
            engine.render();
            await device.queue.onSubmittedWorkDone();
          };
          await waitForPipelines(frame);
          const sizes = [];
          for (let i = 0; i < 3; i++) {
            await frame();
            sizes.push([canvas.width, canvas.height]);
          }
          // Read right after a frame, in the same task, so the drawing buffer is still there.
          engine.render();
          const copy = document.createElement('canvas');
          copy.width = canvas.width;
          copy.height = canvas.height;
          const context = copy.getContext('2d');
          context.drawImage(canvas, 0, 0);
          const pixels = context.getImageData(0, 0, copy.width, copy.height).data,
            colors = new Set();
          let lit = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
            if (pixels[i] > 0) lit++;
          }
          await device.queue.onSubmittedWorkDone();
          const error = await device.popErrorScope();
          if (error) throw new Error(error.message);
          return { samples: sceneSamples(engine), sizes, colors: colors.size, lit };
        } finally {
          engine.dispose();
          canvas.remove();
        }
      };
      return { mode, antialiased: await draw(true), exact: await draw(undefined) };
    }, mode);
    assert.deepEqual(errors, [], `${mode}: no page errors`);
    console.log(JSON.stringify(result));
    const { antialiased, exact } = result;
    for (const [name, run] of Object.entries({ antialiased, exact })) {
      assert.deepEqual(
        run.sizes,
        [
          [64, 32],
          [64, 32],
          [64, 32],
        ],
        `${mode} ${name}: the backbuffer stays 64 x 32`,
      );
      assert.ok(run.lit > 64, `${mode} ${name}: the box is drawn (${run.lit} lit pixels)`);
    }
    assert.equal(antialiased.samples, 4, `${mode}: antialias: true with exactSize draws 4 samples`);
    // A 4x MSAA edge resolves to 0, 1/4, 2/4, 3/4 or all of the face colour: greys between black and the face.
    assert.ok(antialiased.colors > 2, `${mode}: antialiased edges carry greys (${antialiased.colors} colours)`);
    assert.equal(exact.samples, 1, `${mode}: exactSize alone stays single-sampled`);
    assert.equal(exact.colors, 2, `${mode}: exactSize alone shows only the face colour and the background`);
    await page.close();
  }
} finally {
  await closeAll({ browser, servers: [server] });
  await rm(cacheDir, { recursive: true, force: true });
}
