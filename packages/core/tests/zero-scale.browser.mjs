// Real-GPU check for KB-GLTFA B1: a mesh with a zero scale draws with no NaN pixel. Native WebGPU by default;
// MARGO_COMPAT=1 (or --compat) runs the same page on the WebGL2 compatibility layer. Run from the repository root after
// building:
//   node scripts/run-with-timeout.mjs -- node packages/core/tests/zero-scale.browser.mjs
// - flat: a unit sphere at scale (1, 0, 1) seen from above is lit like a +Y face (the centre matches a box flattened
//   to 1e-4 high within 3/255). Before 2026-11-19 core refused the scale, and the shader's sign(det) of 0 gave a zero
//   normal and a NaN colour.
// - zero: the sphere at scale (0, 0, 0) leaves every pixel as the empty scene.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createServer } from 'vite';
import { noFileWatcher } from '../../../scripts/support/no-file-watcher.js';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { compatRun, compatShim } from '../../../scripts/support/compat-shim.js';
import { trackPipelines } from '../../../scripts/support/gpu-ready.js';
import { decodePNG } from '../../../tests/support/png.js';

const root = fileURLToPath(new URL('../../..', import.meta.url)),
  results = join(root, 'test-results'),
  compat = compatRun();
await mkdir(results, { recursive: true });
const cacheDir = await mkdtemp(join(results, 'core-zero-scale-'));
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
      name: 'core-zero-scale-page',
      configureServer(s) {
        s.middlewares.use('/core-zero-scale', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end(
            '<!doctype html><body style="margin:0"><canvas style="display:block;width:64px;height:64px"></canvas>',
          );
        });
      },
    },
  ],
});

async function setup() {
  const { Engine, Geometry, PbrMaterial, box } = await import('/packages/core/dist/index.js');
  const rings = 24,
    segments = 48,
    positions = [],
    indices = [];
  for (let r = 0; r <= rings; r++)
    for (let s = 0; s <= segments; s++) {
      const v = (r / rings) * Math.PI,
        u = (s / segments) * 2 * Math.PI;
      positions.push(Math.sin(v) * Math.cos(u), Math.cos(v), Math.sin(v) * Math.sin(u));
    }
  for (let r = 0; r < rings; r++)
    for (let s = 0; s < segments; s++) {
      const a = r * (segments + 1) + s,
        b = a + segments + 1;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  const sphere = new Geometry(new Float32Array(positions), new Float32Array(positions), new Uint32Array(indices)),
    engine = await Engine.create(document.querySelector('canvas'), {
      exactSize: [64, 64],
      camera: { position: [0, 4, 0.001], target: [0, 0, 0] },
    }),
    errors = [],
    material = new PbrMaterial({ color: '#d9a066', roughness: 0.6 });
  engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  engine.onError = (e) => errors.push(e.message);
  const ball = engine.createMesh().setGeometry(sphere).setMaterial(material),
    slab = engine
      .createMesh()
      .setGeometry(box(2, 2, 2))
      .setMaterial(material)
      .setScale([1, 1e-4, 1]);
  window.show = async (which, scale) => {
    ball.visible = which === 'ball';
    slab.visible = which === 'slab';
    if (scale) ball.setScale(scale);
    engine.render();
    await engine.gpu.queue.onSubmittedWorkDone();
    return errors;
  };
  return errors;
}

const shot = async (page) => decodePNG(await page.locator('canvas').first().screenshot());
const centre = (image) => {
  const k = (32 * image.width + 32) * 4;
  return [image.data[k], image.data[k + 1], image.data[k + 2]];
};

let browser;
try {
  await server.listen();
  browser = await launchBrowser();
  const page = await browser.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  if (compat) await page.addInitScript(compatShim);
  await page.addInitScript(trackPipelines);
  await page.goto(server.resolvedUrls.local[0] + 'core-zero-scale');
  assert.deepEqual(await page.evaluate(`(${setup.toString()})()`), []);
  assert.deepEqual(await page.evaluate(() => window.show('none')), []);
  const empty = await shot(page);
  assert.deepEqual(await page.evaluate(() => window.show('slab')), []);
  const slab = centre(await shot(page));
  assert.deepEqual(await page.evaluate(() => window.show('ball', [1, 0, 1])), []);
  const flat = centre(await shot(page));
  assert.notDeepEqual(slab, centre(empty), 'the slab covers the centre');
  for (let c = 0; c < 3; c++)
    assert.ok(Math.abs(flat[c] - slab[c]) <= 3, `flattened sphere ${flat} is lit like a +Y face ${slab}`);
  assert.deepEqual(await page.evaluate(() => window.show('ball', [0, 0, 0])), []);
  const zero = await shot(page);
  let differing = 0;
  for (let k = 0; k < zero.data.length; k++) if (zero.data[k] !== empty.data[k]) differing++;
  assert.equal(differing, 0, 'a sphere scaled to zero leaves the empty scene');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ compat, slab, flat }));
  console.log(`core zero scale checks passed${compat ? ' (compat)' : ''}`);
} finally {
  await closeAll({ browser, servers: [server] });
  await rm(cacheDir, { recursive: true, force: true });
}
