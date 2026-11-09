import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createServer } from 'vite';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { trackPipelines } from '../../../scripts/support/gpu-ready.js';

const root = fileURLToPath(new URL('../../..', import.meta.url)),
  results = join(root, 'test-results');
await mkdir(results, { recursive: true });
const cacheDir = await mkdtemp(join(results, 'empty-geometry-'));
const server = await createServer({
  root,
  cacheDir,
  configFile: false,
  logLevel: 'error',
  optimizeDeps: { entries: [], noDiscovery: true },
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  plugins: [
    {
      name: 'empty-geometry-page',
      configureServer(s) {
        s.middlewares.use('/empty-geometry', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><canvas width="64" height="64" style="width:64px;height:64px"></canvas>');
        });
      },
    },
  ],
});
let browser;
try {
  await server.listen();
  browser = await launchBrowser();
  for (const mode of ['native', 'compat', 'preview']) {
    const page = await browser.newPage(),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(trackPipelines);
    await page.goto(server.resolvedUrls.local[0] + 'empty-geometry');
    const result = await page.evaluate(async (mode) => {
      const { Engine, Geometry, box } = await import('/packages/core/dist/index.js');
      const { meshGrid } = await import('/packages/voxel-edit/dist/mesh.js');
      const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
      const options = { exactSize: [64, 64], camera: { position: [0, 0, 5], target: [0, 0, 0] } };
      if (mode === 'compat') {
        const { install } = await import('/packages/webgl2-compat/dist/index.js');
        const installed = await install({ force: true });
        if (!installed.installed) throw new Error(installed.reason);
      } else if (mode === 'preview') {
        options.backend = 'webgl2';
        options.fallback = (await import('/packages/webgl2-compat/dist/preview.js')).webglRenderer;
      }
      const engine = await Engine.create(document.querySelector('canvas'), options);
      engine.onError = (e) => {
        throw e;
      };
      let device = engine.gpu;
      if (device) device.pushErrorScope('validation');
      if (mode === 'preview') {
        engine.use((await import('/packages/webgl2-compat/dist/pick.js')).webglPicking());
      }
      const grid = { size: [1, 1, 1], voxels: new Uint8Array([1]) };
      const a = engine.createMesh().setGeometry(box()),
        b = engine.createMesh().setGeometry(box());
      b.position.x = 2;
      let selection, picking;
      if (device) {
        const { Selection, Picking } = await import('/packages/selection/dist/index.js');
        selection = Selection.attach(engine);
        selection.set([a, b]);
        picking = Picking.attach(engine, { capture: false });
        const { Shadows } = await import('/packages/shadows/dist/index.js');
        Shadows.attach(engine, { resolution: 64 });
      }
      const frame = async (culling = true) => {
        engine.render({ culling });
        if (device) await device.queue.onSubmittedWorkDone();
      };
      await waitForPipelines(frame);
      if (!(await engine.pick(32, 32))) throw new Error('Filled scene should pick a mesh');
      grid.voxels.fill(0);
      const { mesh } = meshGrid(grid),
        empty = new Geometry(mesh.positions, mesh.normals, mesh.indices);
      if (empty.bounds.some((v) => v !== 0)) throw new Error('Empty bounds are not zero');
      const original = device?.createBuffer;
      let allocations = 0;
      if (device)
        device.createBuffer = function (...args) {
          allocations++;
          return original.apply(this, args);
        };
      try {
        a.setGeometry(empty);
        b.setGeometry(empty);
      } finally {
        if (device) device.createBuffer = original;
      }
      if (allocations) throw new Error('Attaching empty geometry allocated GPU buffers');
      for (const culling of [true, false, true]) {
        a.position.x += 0.1;
        a.visible = !a.visible;
        await frame(culling);
      }
      if ((await engine.pick(32, 32)) !== null) throw new Error('Empty scene was picked');
      if (engine.stats.drawCalls !== 0) throw new Error('Empty core scene drew instances');
      if (device) {
        const error = await device.popErrorScope();
        if (error) throw new Error(error.message);
        await engine.rebootDevice();
        device = engine.gpu;
        device.pushErrorScope('validation');
        await waitForPipelines(frame);
        if ((await engine.pick(32, 32)) !== null) throw new Error('Empty scene was picked after device replacement');
      }
      a.visible = true;
      a.setGeometry(box());
      await waitForPipelines(frame);
      a.position.x = 0;
      await frame();
      if (!(await engine.pick(32, 32))) throw new Error('Refilled scene was not pickable');
      a.setGeometry(empty);
      b.setGeometry(empty);
      await frame();
      selection?.dispose();
      picking?.dispose();
      a.dispose();
      b.dispose();
      if (device) {
        const error = await device.popErrorScope();
        if (error) throw new Error(error.message);
      }
      engine.dispose();
      engine.dispose();
      return { mode, allocations, emptyVertices: mesh.positions.length, emptyTriangles: mesh.indices.length / 3 };
    }, mode);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify(result));
    await page.close();
  }
} finally {
  await closeAll({ browser, servers: [server] });
  await rm(cacheDir, { recursive: true, force: true });
}
