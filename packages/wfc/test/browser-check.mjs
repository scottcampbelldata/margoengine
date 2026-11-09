import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
const server = await createServer({
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  configFile: false,
  // This suite serves only its middleware page, not the repository's unrelated HTML entries.
  optimizeDeps: { entries: [], noDiscovery: true, include: [] },
  plugins: [
    {
      name: 'wfc-test-page',
      configureServer(server) {
        server.middlewares.use('/c69', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><title>WFC backend checks</title>');
        });
      },
    },
  ],
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  logLevel: 'error',
});
let browser;
try {
  await server.listen();
  browser = await launchBrowser();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.resolvedUrls.local[0] + 'c69');
  const { outputs: result, workers } = await page.evaluate(async () => {
    const { OverlappingModel } = await import('/packages/wfc/dist/overlapping.js');
    const { ConstrainedWFC } = await import('/packages/wfc/dist/constraints.js');
    const { buildSocketTiles } = await import('/packages/wfc/dist/sockets.js');
    const { HeapWFC, ChunkedWFC } = await import('/packages/wfc/dist/chunks.js');
    const { WFCWorkerSolve } = await import('/packages/wfc/dist/worker.js');
    const outputs = [];
    const workers = [];
    for (const route of ['webgpu', 'webgl2']) {
      const canvas = document.createElement('canvas');
      let device;
      if (route === 'webgpu') {
        device = await (await navigator.gpu.requestAdapter()).requestDevice();
        device.pushErrorScope('validation');
        canvas.getContext('webgpu').configure({ device, format: navigator.gpu.getPreferredCanvasFormat() });
      } else if (!canvas.getContext('webgl2')) throw new Error('Missing WebGL2');
      const m = new OverlappingModel({ data: [0, 0, 0, 0], width: 2, height: 2 }, { N: 2 });
      const image = m.solve(8, 8, { pins: [{ position: [7, 7], value: 0 }], ground: { value: 0, rows: 2 } });
      const variants = buildSocketTiles([0, 1].map(() => ({ sockets: Array(6).fill('open'), rotations: 'cube' })));
      const sockets = new ConstrainedWFC([3, 2, 1], variants).solve({ pins: [{ position: [0, 0, 0], tile: 47 }] });
      if (sockets[0] !== 47) throw new Error('Wide socket pin failed');
      const ids = [0, 1];
      const local = ids.map(() => ({ neighbors: Array.from({ length: 6 }, () => ids) }));
      const simd = await HeapWFC.create([8, 8, 1], local, { backend: 'wasm' });
      const heap = simd.solve({ seed: 7 });
      if (simd.backend !== 'wasm' || heap.join() !== new HeapWFC([8, 8, 1], local).solve({ seed: 7 }).join())
        throw new Error('SIMD heap parity failed');
      for (const backend of ['typescript', 'wasm']) {
        let running = true,
          observedWork = false,
          frames = 0,
          handle;
        const frame = () => {
          if (!running) return;
          if (device) {
            const encoder = device.createCommandEncoder();
            const pass = encoder.beginRenderPass({
              colorAttachments: [
                {
                  view: canvas.getContext('webgpu').getCurrentTexture().createView(),
                  clearValue: [0.2, 0.3, 0.4, 1],
                  loadOp: 'clear',
                  storeOp: 'store',
                },
              ],
            });
            pass.end();
            device.queue.submit([encoder.finish()]);
          } else {
            const gl = canvas.getContext('webgl2');
            gl.clearColor(0.2, 0.3, 0.4, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            if (gl.getError()) throw new Error('Worker frame WebGL2 error');
          }
          if (observedWork) frames++;
          handle = requestAnimationFrame(frame);
        };
        handle = requestAnimationFrame(frame);
        const job = new WFCWorkerSolve([512, 512, 1], local, { backend, seed: 7, timeout: 60000 });
        const progress = (async () => {
          for await (const p of job) {
            if (p.backend !== backend) throw new Error('Worker backend changed');
            if (p.decisions > 0 && p.decisions < 512 * 512) observedWork = true;
          }
        })();
        let cells;
        try {
          [cells] = await Promise.all([job.result, progress]);
        } finally {
          running = false;
          cancelAnimationFrame(handle);
          job.dispose();
        }
        if (!observedWork || frames < 1) throw new Error(`Worker blocked ${route} frames on ${backend}: ${frames}`);
        const expected = new HeapWFC([512, 512, 1], local).solve({ seed: 7 });
        if (cells.join() !== expected.join()) throw new Error('Worker seed stream changed');
        const controller = new AbortController();
        const aborted = new WFCWorkerSolve([512, 512, 1], local, { backend, signal: controller.signal });
        const rejected = aborted.result.then(
          () => {
            throw new Error('Abort returned cells');
          },
          (e) => {
            if (e !== 'worker-stop') throw e;
          },
        );
        for await (const p of aborted)
          if (p.decisions > 0) {
            controller.abort('worker-stop');
            break;
          }
        await rejected;
        aborted.dispose();
        workers.push({ route, backend, activeFrames: frames, cells: cells.length, abort: 'terminated' });
      }
      const world = new ChunkedWFC(
        [3, 2, 1],
        ids.map((t) => ({ neighbors: Array.from({ length: 6 }, () => [t ^ 1]) })),
        7,
      );
      const left = await world.solveChunk([-1, 0, 0]),
        right = await world.solveChunk([0, 0, 0]);
      for (let y = 0; y < 2; y++) if ((left[2 + 3 * y] ^ right[3 * y]) !== 1) throw new Error('Chunk seam failed');
      world.dispose();
      const global = new ConstrainedWFC(
        [4, 3, 1],
        ids.map(() => ({ neighbors: Array.from({ length: 6 }, () => ids) })),
        {
          connected: [1],
          counts: [{ tiles: [1], min: 8, max: 8 }],
          paths: [{ from: [0, 0, 0], to: [3, 2, 0], tiles: [1] }],
        },
      ).solve({ seed: 7 });
      if (global[0] !== 1 || global[11] !== 1 || [...global].filter((t) => t === 1).length !== 8)
        throw new Error('Global constraints failed');
      let failed = false;
      try {
        m.solve(8, 8, { pins: [{ position: [7, 7], value: 1 }], attempts: 1 });
      } catch (e) {
        failed = e.code === 'failed' && /https:/.test(e.message);
      }
      if (!failed) throw new Error('Unsatisfiable pin accepted');
      if (device) {
        const error = await device.popErrorScope();
        if (error) throw new Error(error.message);
        canvas.getContext('webgpu').unconfigure();
        device.destroy();
      }
      outputs.push({ route, image: [...image], global: [...global], sockets: [...sockets], heap: [...heap] });
    }
    return { outputs, workers };
  });
  assert.deepEqual(result[0].image, Array(64).fill(0));
  assert.deepEqual(result[1].image, result[0].image);
  assert.deepEqual(result[1].global, result[0].global);
  assert.deepEqual(result[1].sockets, result[0].sockets);
  assert.deepEqual(result[1].heap, result[0].heap);
  assert.deepEqual(errors, []);
  const evidence = {
    machine: hostname(),
    recorded: new Date().toISOString(),
    routes: result.map((r) => r.route),
    pixels: 64,
    errors: 0,
    workers,
  };
  if (process.argv.includes('--record'))
    writeFileSync(
      new URL('../../../docs/whitepaper/results/batch-69-worker.json', import.meta.url),
      JSON.stringify(evidence, null, 2) + '\n',
    );
  console.log(JSON.stringify(evidence));
} finally {
  await closeAll({ browser, servers: [server] });
}
