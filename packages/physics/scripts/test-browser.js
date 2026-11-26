import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { createServer } from 'vite';
import { noFileWatcher } from '../../../scripts/support/no-file-watcher.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { compatRun, compatShim, compatUrl } from '../../../scripts/support/compat-shim.js';

const thermalOnly = process.argv.includes('--thermal-only');
const swimOnly = process.argv.includes('--swim-only');
const root = fileURLToPath(new URL('..', import.meta.url));
const results = resolve(root, 'test-results');
await mkdir(results, { recursive: true });
const server = await createServer({
  plugins: [noFileWatcher()],
  configFile: resolve(root, 'vite.config.js'),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
await server.listen();
let browser;
try {
  const args = process.env.BROWSER_ARGS ? JSON.parse(process.env.BROWSER_ARGS) : [];
  browser = await launchBrowser({
    headless: true,
    args,
  });
  const page = await browser.newPage({ viewport: { width: 400, height: 400 }, deviceScaleFactor: 1 });
  const errors = [];
  const thermalRequests = [];
  const swimRequests = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (/\/thermal-kernel(?:-shared)?\.wasm$/.test(url.pathname)) thermalRequests.push(url.pathname);
    if (/\/swim-kernel(?:-shared)?\.wasm$/.test(url.pathname)) swimRequests.push(url.pathname);
  });
  // MARGO_COMPAT=1: the page runs on the WebGL2 compatibility layer (scripts/support/compat-shim.js).
  if (compatRun()) await page.addInitScript(compatShim, compatUrl());
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(`${server.resolvedUrls.local[0]}tests/physics.html`);
  await page.waitForFunction(() => typeof window.runPhysicsTests === 'function', null, { timeout: 60000 });
  const report = thermalOnly || swimOnly ? { checks: [] } : await page.evaluate(() => window.runPhysicsTests());
  if (!swimOnly) {
    await page.evaluate(async () => {
      await import('/dist/thermal.js');
    });
    assert.deepEqual(thermalRequests, [], 'importing physics and the thermal entry leaves the kernel unloaded');
    const temperature = await page.evaluate(async () => {
      const { HeatConduction } = await import('/dist/thermal.js');
      const { PhysicsWorld } = await import('/dist/world.js');
      const heat = await HeatConduction.load();
      const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(heat, {
        dimensions: [1, 1, 1],
        materials: { conductivity: 0, heatCapacity: 1 },
        initialTemperature: 300,
        integration: 'implicit',
        boundaries: { xMin: { kind: 'flux', wattsPerSquareMetre: 600 } },
      });
      world.advance(1);
      return { value: heat.readTemperature()[0], shared: globalThis.crossOriginIsolated };
    });
    assert.deepEqual(
      thermalRequests.map((request) => request.split('/').at(-1)).sort(),
      temperature.shared ? ['thermal-kernel-shared.wasm', 'thermal-kernel.wasm'] : ['thermal-kernel.wasm'],
      'loading the solver fetches the builds that this browser can use',
    );
    assert.equal(temperature.value, 310);
    report.checks.push('Thermal Wasm loads on demand and advances the world in the browser');
  }
  if (!thermalOnly) {
    await page.evaluate(() => import('/dist/life.js'));
    assert.deepEqual(swimRequests, [], 'importing the swimming entry leaves both kernels unloaded');
    const reading = await page.evaluate(async () => {
      const { SwimSolver } = await import('/dist/life.js');
      const { PhysicsWorld } = await import('/dist/world.js');
      const swim = await SwimSolver.load();
      const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, 0, 0] }).add(swim, {
        bodies: [
          {
            position: [0, -1, 0],
            mass: 1,
            length: 1,
            width: 0.15,
            height: 0.15,
            tail: { amplitude: 0.08, span: 0.15, wavelength: 0.85 },
            frequency: 1.5,
          },
        ],
      });
      world.advance(12);
      const hash = world.hash();
      const saved = world.takeSnapshot();
      world.advance(24);
      world.restoreSnapshot(saved.bytes);
      return {
        velocity: swim.read(0).velocity[2],
        replayed: world.hash() === hash,
        shared: globalThis.crossOriginIsolated,
      };
    });
    assert.deepEqual(
      swimRequests.map((request) => request.split('/').at(-1)).sort(),
      reading.shared ? ['swim-kernel-shared.wasm', 'swim-kernel.wasm'] : ['swim-kernel.wasm'],
    );
    assert.ok(reading.velocity > 0);
    assert.equal(reading.replayed, true);
    report.checks.push('Aquatic locomotion Wasm loads on demand, propels a swimmer and restores its snapshot');
  }
  if (report.image) {
    await writeFile(resolve(results, 'physics-stack.png'), Buffer.from(report.image.split(',')[1], 'base64'));
    delete report.image;
  }
  report.browser = browser.version();
  assert.deepEqual(errors, []);
  await writeFile(resolve(results, 'physics-browser.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`${report.checks.length} browser checks passed`);
} finally {
  await closeAll({ browser, servers: [server] });
}
