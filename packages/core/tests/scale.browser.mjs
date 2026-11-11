// Real-GPU checks that core reaches the device's own limits for large scenes. Native WebGPU by default; MARGO_COMPAT=1
// (or --compat) runs the same page on the WebGL2 compatibility layer. Run from the repository root after building:
//   node scripts/gpu-lock.mjs run --owner=<you> --gpu=core-scale -- node packages/core/tests/scale.browser.mjs
// - limits: the device core makes has its adapter's maxBufferSize and maxStorageBufferBindingSize, not WebGPU's
//   256 MiB / 128 MiB defaults (before 2026-11-10 core asked only for maxTextureArrayLayers).
// - vertices: a 1,212,201-vertex plane (over the old 1,000,000 cap) that fills the view covers every pixel.
// - instances: 1,200,000 boxes of one geometry (its instance buffer grows to 2,097,152 rows, 201 MB, past one 128 MiB
//   storage binding) draw with no validation error or device loss, the same pixels as the field split over two
//   geometries of 600,000 (each buffer under one binding).
// - backbuffer: a 5120 x 1440 CSS canvas keeps 5120 x 1440 backing pixels on a device whose 2D textures go past 5120
//   (before 2026-11-10 a fixed 4096 cap made it 4096 x 1152); one 1.25 times wider than the device limit is cut to the
//   limit with its aspect kept. Both draw with no validation error.
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
            '<!doctype html><body style="margin:0"><canvas style="display:block;width:64px;height:64px"></canvas>' +
              '<canvas id="b" style="display:block;width:64px;height:64px"></canvas>',
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
  async instances() {
    const { Engine, box, PbrMaterial } = await import('/packages/core/dist/index.js');
    const count = 1_200_000,
      side = Math.ceil(Math.sqrt(count)),
      camera = { fov: 50, near: 0.1, far: 4000, position: [0, 300, 900], target: [0, 0, 0] },
      material = new PbrMaterial({ color: '#4dd966', roughness: 0.5 }),
      one = box(0.6, 0.6, 0.6),
      halves = [box(0.6, 0.6, 0.6), box(0.6, 0.6, 0.6)],
      canvases = document.querySelectorAll('canvas'),
      errors = [],
      engines = [];
    for (const [k, canvas] of [...canvases].entries()) {
      const engine = await Engine.create(canvas, { exactSize: [256, 256], camera });
      engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
      engine.onError = (e) => errors.push(e.message);
      for (let n = 0; n < count; n++)
        engine
          .createMesh()
          .setGeometry(k ? halves[n & 1] : one)
          .setMaterial(material)
          .setPosition([(n % side) - side / 2, 0, Math.floor(n / side) - side / 2]);
      engines.push(engine);
    }
    for (let i = 0; i < 3; i++)
      for (const engine of engines) {
        engine.render({ culling: false });
        await engine.gpu.queue.onSubmittedWorkDone();
      }
    for (const canvas of canvases) canvas.style.width = canvas.style.height = '256px';
    const buffers = engines.map((e, k) => (k ? halves : [one]).map((g) => e.geometryBuffers(g)?.instance.size ?? 0));
    return {
      errors,
      buffers,
      binding: engines[0].gpu.limits.maxStorageBufferBindingSize,
      drawn: engines.map((e) => e.stats.visible),
    };
  },
  async backbuffer() {
    const { Engine, box, PbrMaterial } = await import('/packages/core/dist/index.js');
    const canvas = document.querySelector('canvas'),
      results = [];
    for (const wide of [5120, 0]) {
      const engine = await Engine.create(canvas, { camera: { position: [0, 0, 5], target: [0, 0, 0] } }),
        limit = engine.gpu.limits.maxTextureDimension2D,
        errors = [];
      engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
      const css = wide ? [wide, 1440] : [Math.round(limit * 1.25), 16];
      canvas.style.width = `${css[0]}px`;
      canvas.style.height = `${css[1]}px`;
      engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({ color: '#ff8000' }));
      engine.render();
      await engine.gpu.queue.onSubmittedWorkDone();
      results.push({ css, limit, backing: [canvas.width, canvas.height], dpr: devicePixelRatio, errors });
      engine.dispose();
    }
    return { results };
  },
};

const shot = async (page, selector = 'canvas') => decodePNG(await page.locator(selector).first().screenshot());
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
  async instances(result, page) {
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.drawn, [1_200_000, 1_200_000]);
    assert.ok(result.buffers[0][0] > 134217728, `one geometry's instance buffer passes one default binding`);
    const [a, b] = [await shot(page, 'canvas:first-of-type'), await shot(page, '#b')];
    let differing = 0,
      field = 0;
    for (let k = 0; k < a.data.length; k += 4) {
      if (a.data[k] !== b.data[k] || a.data[k + 1] !== b.data[k + 1] || a.data[k + 2] !== b.data[k + 2]) differing++;
      if (a.data[k + 1] > a.data[k] + 40) field++;
    }
    result.differing = differing;
    result.field = field;
    assert.equal(differing, 0, 'one geometry and two halves draw the same pixels');
    assert.ok(field > a.data.length / 4 / 4, 'the field covers the view');
  },
  backbuffer({ results: [wide, past] }) {
    assert.equal(wide.dpr, 1);
    assert.ok(wide.limit >= 8192, `a device allowing 8192 (${wide.limit})`);
    assert.deepEqual(wide.backing, [5120, 1440], 'a 5120 x 1440 canvas is not reduced');
    assert.deepEqual(past.backing, [past.limit, Math.round((16 * past.limit) / past.css[0])], 'cut to the limit, aspect kept');
    assert.deepEqual([...wide.errors, ...past.errors], []);
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
