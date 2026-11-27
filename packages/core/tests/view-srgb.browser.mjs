// Regression (KB-VIEW-SRGB1, 2026-11-26): a view drawn into an `-srgb` texture stored core's colours encoded twice.
// Core's shader, its clear colour and every package's pipeline write display colour (already sRGB-encoded), and an
// `-srgb` attachment encodes what is written to it once more: background #808080 stored 188 where 128 is right. Core
// now draws such a target through a view in its non-srgb twin format, so the texture stores the same bytes as a
// `rgba8unorm` target does. This suite draws the same frames into a `rgba8unorm` and a `rgba8unorm-srgb` texture (the
// latter naming its twin in `viewFormats`) and reads both back, on native WebGPU and on the WebGL2 compatibility layer,
// with 4x MSAA (the resolve) and with 1 sample:
//   - a background and a mesh in a whole view (the attachment clear);
//   - core's own clear colour with no background;
//   - two half views with their own clear colours (the drawn clear, and a later view that keeps the first);
//   - a package pipeline of its own (ColorBackground) and an HDR capture's display pass (Tonemap);
//   - again after a device restore, in new textures.
// The two read-backs must be equal byte for byte, and the background must hold its bytes as given.
//   node scripts/run-with-timeout.mjs -- node packages/core/tests/view-srgb.browser.mjs
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
const cacheDir = await mkdtemp(join(results, 'view-srgb-'));
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
      name: 'view-srgb-page',
      configureServer(s) {
        s.middlewares.use('/view-srgb', (_request, response) => {
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
    await page.goto(server.resolvedUrls.local[0] + 'view-srgb');
    const result = await page.evaluate(async (mode) => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js');
      const { sceneSamples } = await import('/packages/core/dist/quality.js');
      const { ColorBackground } = await import('/packages/environment/dist/index.js');
      const { Tonemap } = await import('/packages/tonemap/dist/index.js');
      const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
      if (mode === 'compat') {
        const { install } = await import('/packages/webgl2-compat/dist/index.js');
        const installed = await install({ force: true });
        if (!installed.installed) throw new Error(installed.reason);
      }
      const size = 64,
        formats = ['rgba8unorm', 'rgba8unorm-srgb'];
      // What each case adds to the engine, and the views it draws into `target`.
      const cases = {
        whole: (engine, target) => {
          engine.scene.background = '#808080';
          return [{ camera: engine.camera, viewport: [0, 0, 1, 1], target }];
        },
        unset: (engine, target) => [{ camera: engine.camera, viewport: [0, 0, 1, 1], target }],
        halves: (engine, target) => [
          { camera: engine.camera, viewport: [0, 0, 0.5, 1], clear: { color: '#808080' }, target },
          { camera: engine.camera, viewport: [0.5, 0, 0.5, 1], clear: { color: '#2a6cba' }, target },
        ],
        package: (engine, target) => {
          ColorBackground.attach(engine, { color: '#2a6cba' });
          return [{ camera: engine.camera, viewport: [0, 0, 1, 1], target }];
        },
        capture: (engine, target) => {
          engine.scene.background = '#808080';
          Tonemap.attach(engine);
          return [{ camera: engine.camera, viewport: [0, 0, 1, 1], target }];
        },
      };
      const run = async (name, antialias, restore) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        document.body.append(canvas);
        const engine = await Engine.create(canvas, { antialias, camera: { position: [0, 0, 6], target: [0, 0, 0] } });
        engine.stop();
        engine.onError = (e) => {
          throw e;
        };
        try {
          engine
            .createMesh()
            .setGeometry(box(1, 1, 1))
            .setMaterial(new PbrMaterial({ color: '#e0a050' }));
          const read = {};
          let views;
          const draw = async () => {
            const device = engine.gpu;
            device.pushErrorScope('validation');
            for (const format of formats) {
              // 21 is COPY_SRC | TEXTURE_BINDING | RENDER_ATTACHMENT.
              const color = device.createTexture({
                  size: [size, size],
                  format,
                  usage: 21,
                  viewFormats: format.endsWith('-srgb') ? [format.replace('-srgb', '')] : [],
                }),
                target = { color };
              views ??= cases[name](engine, target);
              const frame = async () => {
                engine.render({ delta: 0, views: views.map((view) => ({ ...view, target })) });
                await device.queue.onSubmittedWorkDone();
              };
              await waitForPipelines(frame);
              await frame();
              const buffer = device.createBuffer({ size: size * size * 4, usage: 9 }),
                encoder = device.createCommandEncoder();
              encoder.copyTextureToBuffer({ texture: color }, { buffer, bytesPerRow: size * 4 }, [size, size]);
              device.queue.submit([encoder.finish()]);
              await buffer.mapAsync(1);
              read[format] = [...new Uint8Array(buffer.getMappedRange())];
              buffer.destroy();
              color.destroy();
            }
            const error = await device.popErrorScope();
            if (error) throw new Error(error.message);
          };
          await draw();
          if (restore) {
            await engine.rebootDevice();
            await draw();
          }
          const [a, b] = formats.map((format) => read[format]),
            at = (pixels, x, y) => pixels.slice((y * size + x) * 4, (y * size + x) * 4 + 3);
          let differ = 0;
          for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differ++;
          return {
            name,
            samples: sceneSamples(engine),
            restore,
            differ,
            corner: { unorm: at(a, 2, 2), srgb: at(b, 2, 2) },
            right: { unorm: at(a, size - 3, 2), srgb: at(b, size - 3, 2) },
            centre: { unorm: at(a, size / 2, size / 2), srgb: at(b, size / 2, size / 2) },
          };
        } finally {
          engine.dispose();
          canvas.remove();
        }
      };
      const runs = [];
      for (const antialias of [true, false])
        for (const name of Object.keys(cases)) runs.push(await run(name, antialias));
      runs.push(await run('whole', true, true));
      // A target that does not name its twin in viewFormats: WebGPU refuses the view (a validation error, and nothing
      // is drawn); the WebGL2 layer makes it.
      const canvas = document.createElement('canvas');
      document.body.append(canvas);
      const engine = await Engine.create(canvas, { camera: { position: [0, 0, 6], target: [0, 0, 0] } });
      engine.stop();
      const device = engine.gpu,
        color = device.createTexture({ size: [size, size], format: 'rgba8unorm-srgb', usage: 21 });
      device.pushErrorScope('validation');
      engine.render({ delta: 0, views: [{ camera: engine.camera, viewport: [0, 0, 1, 1], target: { color } }] });
      await device.queue.onSubmittedWorkDone();
      const unnamed = (await device.popErrorScope())?.message ?? '';
      engine.dispose();
      canvas.remove();
      return { runs, unnamed };
    }, mode);
    assert.deepEqual(errors, [], `${mode}: no page errors`);
    const wrong = [];
    for (const run of result.runs) {
      const label = `${mode} ${run.name} ${run.samples}x${run.restore ? ' after a device restore' : ''}`,
        expect = (actual, expected, what) => {
          if (actual.join() !== expected.join()) wrong.push(`${label}: ${what} is ${actual}, not ${expected}`);
        };
      console.log(label, JSON.stringify(run));
      if (run.differ) wrong.push(`${label}: ${run.differ} bytes of the -srgb target differ from the rgba8unorm one`);
      if (run.name === 'whole') expect(run.corner.srgb, [128, 128, 128], 'the background #808080');
      if (run.name === 'unset') expect(run.corner.srgb, [5, 6, 9], "core's clear colour");
      if (run.name === 'halves') {
        expect(run.corner.srgb, [128, 128, 128], 'the left view #808080');
        expect(run.right.srgb, [42, 108, 186], 'the right view #2a6cba');
      }
      if (run.name === 'package') expect(run.corner.srgb, run.corner.unorm, "the package's backdrop");
      if (run.centre.srgb.join() === run.corner.srgb.join()) wrong.push(`${label}: the mesh is not drawn`);
    }
    assert.deepEqual(wrong, [], `${mode}: an -srgb view target stores what its rgba8unorm twin stores`);
    assert.deepEqual(
      [...new Set(result.runs.map((run) => run.samples))],
      [4, 1],
      `${mode}: 4x MSAA and 1 sample both ran`,
    );
    console.log(`${mode} target without viewFormats: ${result.unnamed || 'drawn'}`);
    if (mode === 'native')
      assert.match(result.unnamed, /format/i, 'WebGPU refuses a twin view of a texture that does not name it');
    else assert.equal(result.unnamed, '', 'the WebGL2 layer draws a target that does not name its twin');
    await page.close();
  }
} finally {
  await closeAll({ browser, servers: [server] });
  await rm(cacheDir, { recursive: true, force: true });
}
