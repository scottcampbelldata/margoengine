import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

const dir = await mkdtemp(join(tmpdir(), 'margo-poisson-'));
let browser, server;
try {
  await writeFile(
    join(dir, 'index.html'),
    '<!doctype html><title>Poisson backend values</title><script type="module" src="/main.js"></script>',
  );
  await writeFile(
    join(dir, 'main.js'),
    `import {createPoissonSampler} from '@margoengine/procedural/poisson'; window.makeSampler = createPoissonSampler;`,
  );
  await build({
    root: dir,
    base: '/sampling/',
    configFile: false,
    logLevel: 'error',
    resolve: {
      alias: { '@margoengine/procedural/poisson': fileURLToPath(new URL('../dist/poisson.js', import.meta.url)) },
    },
    build: { outDir: join(dir, 'dist') },
  });
  server = await preview({
    root: dir,
    base: '/sampling/',
    configFile: false,
    logLevel: 'error',
    build: { outDir: join(dir, 'dist') },
    preview: { host: '127.0.0.1', port: 0 },
  });
  browser = await launchBrowser();
  const page = await browser.newPage(),
    errors = [],
    wasmRequests = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (/\.wasm(?:\?|$)/.test(r.url())) wasmRequests.push(r.url());
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => typeof window.makeSampler === 'function');
  assert.equal(wasmRequests.length, 0, 'importing the entry downloads no Wasm');
  const result = await page.evaluate(async () => {
    const output = [];
    for (const route of ['webgpu', 'webgl2']) {
      const canvas = document.createElement('canvas');
      let device, gl;
      if (route === 'webgpu') {
        device = await (await navigator.gpu.requestAdapter()).requestDevice();
        device.pushErrorScope('validation');
        canvas.getContext('webgpu').configure({ device, format: navigator.gpu.getPreferredCanvasFormat() });
      } else {
        gl = canvas.getContext('webgl2');
        if (!gl) throw new Error('WebGL2 context missing');
      }
      const sampler = await window.makeSampler();
      const options = { radius: 0.2, attempts: 5000, seed: 39 };
      const a = sampler.rectangle([-2, -2, 2, 2], options);
      const surface = sampler.surface(new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]), options);
      if (device) {
        const error = await device.popErrorScope();
        if (error) throw error;
        device.destroy();
        await device.lost;
      } else {
        const lost = new Promise((resolve) => canvas.addEventListener('webglcontextlost', resolve, { once: true }));
        gl.getExtension('WEBGL_lose_context').loseContext();
        await lost;
        if (!gl.isContextLost()) throw new Error('Context loss was not observed');
      }
      const after = sampler.rectangle([-2, -2, 2, 2], options);
      sampler.dispose();
      sampler.dispose();
      let disposed = false;
      try {
        sampler.rectangle([-2, -2, 2, 2], options);
      } catch (e) {
        disposed = e.code === 'disposed';
      }
      if (!disposed) throw new Error('Disposed sampler accepted work');
      output.push({ route, points: [...a.positions], surface: [...surface.positions], after: [...after.positions] });
    }
    return output;
  });
  assert.ok(wasmRequests.length >= 1);
  assert.deepEqual(result[0].points, result[1].points);
  for (const r of result) {
    assert.deepEqual(r.after, r.points);
    assert.ok(r.points.length > 300);
    for (const [p, d] of [
      [r.points, 2],
      [r.surface, 3],
    ])
      for (let i = 0; i < p.length; i += d) {
        if (d === 3) {
          assert.equal(p[i + 2], 0);
          assert.ok(p[i] >= 0 && p[i + 1] >= 0 && p[i] + p[i + 1] <= 2);
        }
        for (let j = 0; j < i; j += d) {
          let squared = 0;
          for (let k = 0; k < d; k++) squared += (p[i + k] - p[j + k]) ** 2;
          assert.ok(squared >= 0.2 ** 2);
        }
      }
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      routes: result.map((r) => r.route),
      points: result[0].points.length / 2,
      surfacePoints: result[0].surface.length / 3,
      lazyWasm: true,
      deviceLossIndependent: true,
      errors,
    }),
  );
} finally {
  await closeAll({ browser, servers: [server] });
  await rm(dir, { recursive: true, force: true });
}
