// Real-GPU checks that core reaches the device's own limits for large scenes. Native WebGPU by default; MARGO_COMPAT=1
// (or --compat) runs the same page on the WebGL2 compatibility layer. Run from the repository root after building:
//   node scripts/gpu-lock.mjs run --owner=<you> --gpu=core-scale -- node packages/core/tests/scale.browser.mjs
// - limits: the device core makes has its adapter's maxBufferSize and maxStorageBufferBindingSize, not WebGPU's
//   256 MiB / 128 MiB defaults (before 2026-11-10 core asked only for maxTextureArrayLayers).
// - vertices: a 1,212,201-vertex plane (over the old 1,000,000 cap) that fills the view covers every pixel.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createServer } from 'vite';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { compatRun, compatShim } from '../../../scripts/support/compat-shim.js';
import { decodePNG } from '../../../tests/support/png.js';

const root = fileURLToPath(new URL('../../..', import.meta.url)),
  results = join(root, 'test-results'),
  compat = compatRun();
await mkdir(results, { recursive: true });
const cacheDir = await mkdtemp(join(results, 'core-scale-'));
const server = await createServer({
  root,
  cacheDir,
  configFile: false,
  logLevel: 'error',
  optimizeDeps: { entries: [], noDiscovery: true },
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  plugins: [
    {
      name: 'core-scale-page',
      configureServer(s) {
        s.middlewares.use('/core-scale', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end(
            '<!doctype html><body style="margin:0"><canvas style="display:block;width:64px;height:64px"></canvas>',
          );
        });
      },
    },
  ],
});

/** Each case runs in a fresh page; it returns what the Node side checks. */
const cases = {
  async limits() {
    const { Engine } = await import('/packages/core/dist/index.js');
    const engine = await Engine.create(document.querySelector('canvas'), { exactSize: [64, 64] }),
      adapter = await navigator.gpu.requestAdapter(),
      names = ['maxBufferSize', 'maxStorageBufferBindingSize', 'maxTextureArrayLayers'],
      pick = (limits) => Object.fromEntries(names.map((name) => [name, limits[name]]));
    try {
      return { device: pick(engine.gpu.limits), adapter: pick(adapter.limits) };
    } finally {
      engine.dispose();
    }
  },
  async vertices() {
    const { Engine, Geometry, PbrMaterial } = await import('/packages/core/dist/index.js');
    const side = 1100,
      row = side + 1,
      positions = new Float32Array(row * row * 3),
      normals = new Float32Array(row * row * 3),
      indices = new Uint32Array(side * side * 6);
    for (let z = 0, v = 0; z < row; z++)
      for (let x = 0; x < row; x++, v++) {
        positions.set([(x / side) * 40 - 20, 0, (z / side) * 40 - 20], v * 3);
        normals[v * 3 + 1] = 1;
      }
    for (let z = 0, i = 0; z < side; z++)
      for (let x = 0; x < side; x++, i += 6) {
        const a = z * row + x;
        indices.set([a, a + row, a + 1, a + 1, a + row, a + row + 1], i);
      }
    const geometry = new Geometry(positions, normals, indices),
      engine = await Engine.create(document.querySelector('canvas'), {
        exactSize: [64, 64],
        camera: { position: [0, 10, 0.001], target: [0, 0, 0] },
      }),
      errors = [];
    engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    window.mesh = engine.createMesh().setGeometry(geometry).setMaterial(new PbrMaterial({ color: '#ff8000' }));
    window.frame = async (visible) => {
      window.mesh.visible = visible;
      engine.render();
      await engine.gpu.queue.onSubmittedWorkDone();
      return errors;
    };
    await window.frame(true);
    return { vertices: geometry.vertices.length / 6, triangles: indices.length / 3, errors };
  },
};

const shot = async (page) => decodePNG(await page.locator('canvas').screenshot());
const checks = {
  limits({ device, adapter }) {
    assert.deepEqual(device, adapter, 'the device has its adapter limits');
    assert.ok(device.maxBufferSize >= 268435456 && device.maxStorageBufferBindingSize >= 134217728);
  },
  async vertices(result, page) {
    assert.ok(result.vertices > 1_000_000);
    assert.deepEqual(result.errors, []);
    const drawn = await shot(page);
    assert.deepEqual(await page.evaluate(() => window.frame(false)), []);
    const empty = await shot(page);
    let same = 0;
    for (let k = 0; k < drawn.data.length; k += 4)
      if (drawn.data[k] === empty.data[k] && drawn.data[k + 1] === empty.data[k + 1] && drawn.data[k + 2] === empty.data[k + 2])
        same++;
    result.uncovered = same;
    assert.equal(same, 0, 'every pixel shows the plane');
  },
};

let browser;
try {
  await server.listen();
  browser = await launchBrowser();
  for (const [name, run] of Object.entries(cases)) {
    const page = await browser.newPage(),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    if (compat) await page.addInitScript(compatShim);
    await page.goto(server.resolvedUrls.local[0] + 'core-scale');
    const result = await page.evaluate(`(${run.toString().replace(/^async \w+\(/, 'async function (')})()`);
    await checks[name](result, page);
    assert.deepEqual(errors, [], name);
    console.log(JSON.stringify({ case: name, compat, ...result }));
    await page.close();
  }
  console.log(`core scale checks passed${compat ? ' (compat)' : ''}`);
} finally {
  await closeAll({ browser, servers: [server] });
  await rm(cacheDir, { recursive: true, force: true });
}
