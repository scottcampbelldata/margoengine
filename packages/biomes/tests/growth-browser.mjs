import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { compatRun, compatShim, compatUrl } from '../../../scripts/support/compat-shim.js';
import { noFileWatcher } from '../../../scripts/support/no-file-watcher.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

const server = await createServer({
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  root: fileURLToPath(new URL('../../../', import.meta.url)),
  plugins: [
    noFileWatcher(),
    {
      name: 'growth-test-page',
      configureServer(vite) {
        vite.middlewares.use('/bio02-growth-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
          response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
          response.end('<!doctype html><title>Plant growth test</title>');
        });
      },
    },
  ],
  server: {
    host: '127.0.0.1',
    port: 0,
    hmr: false,
    watch: null,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  logLevel: 'error',
});
let browser;
try {
  await server.listen();
  browser = await launchBrowser({ headless: true });
  const page = await browser.newPage();
  if (compatRun()) await page.addInitScript(compatShim, compatUrl());
  const errors = [];
  const assets = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (/growth-kernel(?:-shared)?\.wasm$/.test(path)) assets.push({ file: path.split('/').at(-1), ok: response.ok() });
  });
  await page.goto(`${server.resolvedUrls.local[0]}bio02-growth-test`);
  await page.evaluate(() => import('/packages/biomes/dist/growth.js').then(() => undefined));
  assert.deepEqual(assets, [], 'importing the optional entry must not fetch either native variant');
  const result = await page.evaluate(async () => {
    const { PlantGrowth } = await import('/packages/biomes/dist/growth.js');
    const { PhysicsWorld } = await import('/packages/physics/dist/world.js');
    const { tubes } = await import('/packages/procedural/dist/lsystem.js');
    const growth = await PlantGrowth.load();
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(growth, {
      ticksPerSeason: 60,
      plants: [
        {
          position: [0.25, 0.25, 0.25],
          species: {
            productiveSeasons: 2,
            seasonalExtension: 2,
            minimumExtension: 0.05,
            internodeLength: 0.4,
            tipRadius: 0.02,
          },
        },
      ],
      voxels: { origin: [0, 0, 0], dimensions: [4, 4, 4], size: 1 },
    });
    world.advance(30);
    const snapshot = world.takeSnapshot();
    world.advance(120);
    const expected = world.hash();
    const graph = growth.toBranches();
    const geometry = tubes(graph);
    world.restoreSnapshot(snapshot.bytes);
    world.advance(120);
    return {
      shared: crossOriginIsolated,
      season: growth.season,
      segments: graph.radii.length,
      triangles: geometry.indices.length / 3,
      replayed: world.hash() === expected,
    };
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(
    assets.map(({ file }) => file).sort(),
    result.shared ? ['growth-kernel-shared.wasm', 'growth-kernel.wasm'] : ['growth-kernel.wasm'],
  );
  assert.ok(assets.every(({ ok }) => ok));
  assert.equal(result.season, 2);
  assert.equal(result.segments, 3);
  assert.ok(result.triangles > 0);
  assert.equal(result.replayed, true);
  console.log(JSON.stringify(result));
} finally {
  await closeAll({ browser, servers: [server] });
}
