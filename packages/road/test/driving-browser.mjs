import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { compatRun, compatShim, compatUrl } from '../../../scripts/support/compat-shim.js';
import { noFileWatcher } from '../../../scripts/support/no-file-watcher.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

const server = await createServer({
  root: fileURLToPath(new URL('../../../', import.meta.url)),
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [
    noFileWatcher(),
    {
      name: 'road-driving-page',
      configureServer(vite) {
        vite.middlewares.use('/dyn04-drive-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
          response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
          response.end('<!doctype html><title>Road driving test</title>');
        });
      },
    },
  ],
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  logLevel: 'error',
});
let browser;
try {
  await server.listen();
  browser = await launchBrowser({ headless: true });
  const page = await browser.newPage();
  if (compatRun()) await page.addInitScript(compatShim, compatUrl());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${server.resolvedUrls.local[0]}dyn04-drive-test`);
  const result = await page.evaluate(async () => {
    const { Physics } = await import('/packages/physics/dist/index.js');
    const { PhysicsWorld, RigidSolver, worldMemory } = await import('/packages/physics/dist/world.js');
    const { road } = await import('/packages/road/dist/index.js');
    const { addRoadVehicle, RoadSurfaces, roadDrivePath, RoadDriver } = await import('/packages/road/dist/driving.js');
    const { Spline } = await import('/packages/splines/dist/index.js');
    const shared = globalThis.crossOriginIsolated;
    await Physics.load({ threads: shared });
    const gravity = [0, -9.81, 0];
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity, memory: worldMemory(shared) });
    const physics = new Physics(null, { arena: world.arena, gravity });
    try {
      const path = new Spline([
        [0, 0, -8],
        [0, 0, 0],
        [0, 0, 16],
      ]);
      const traction = { dry: 0.8, wet: 0.25 };
      const surfaces = new RoadSurfaces();
      const ground = surfaces.add(physics, road(path), { traction, wetness: 0.5 });
      const wheels = [-1, 1].flatMap((end) =>
        [-1, 1].map((side) => ({
          position: [0.65 * side, -0.15, end],
          radius: 0.3,
          steer: end > 0,
          suspensionStiffness: 18,
        })),
      );
      const { body, vehicle } = await addRoadVehicle(physics, null, {
        mass: 1200,
        size: [1.3, 0.36, 2.4],
        position: [0, 0.614, 0],
        groundMaterial: surfaces.sample,
        wheels,
      });
      const driver = await RoadDriver.create();
      world.add(new RigidSolver(), { physics });
      world.add(driver, {
        vehicles: [
          { body: body.row, attachment: vehicle, path: roadDrivePath(path), traction, wheelbase: 2, maxSpeed: 4 },
        ],
      });
      world.couple([driver.id, 'rigid'], 'staggered');
      const unbind = driver.bindVehicle(world, physics, 0);
      try {
        world.advance(24);
        const saved = world.takeSnapshot();
        world.advance(90);
        const expected = world.hash();
        const travelled = body.position[2];
        const contacting = vehicle.wheel(0).ground?.body === ground;
        const { grip } = vehicle.wheelGround(0);
        world.restoreSnapshot(saved.bytes);
        world.advance(90);
        return { shared, travelled, contacting, grip, replayed: world.hash() === expected };
      } finally {
        unbind();
      }
    } finally {
      physics.dispose();
    }
  });
  assert.deepEqual(errors, []);
  assert.ok(result.travelled > 1);
  assert.equal(result.contacting, true);
  assert.ok(Math.abs(result.grip - 0.525) < 1e-12);
  assert.equal(result.replayed, true);
  console.log(JSON.stringify(result));
} finally {
  await closeAll({ browser, servers: [server] });
}
