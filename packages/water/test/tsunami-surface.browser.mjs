import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' });
const { page, hardware } = browser;
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  const result = await page.evaluate(async () => {
    const [
      { EngineKernel },
      { PhysicsWorld },
      { TsunamiSolver },
      { Water },
      { ShallowWaterSurface },
      { WaveQuery },
      { waitForPipelines },
    ] = await Promise.all([
      import('/packages/core/dist/index.js'),
      import('/packages/physics/dist/world.js'),
      import('/packages/physics/dist/tsunami.js'),
      import('/packages/water/dist/index.js'),
      import('/packages/water/dist/shallow-surface.js'),
      import('/packages/water/dist/query.js'),
      import('/scripts/support/gpu-ready.js'),
    ]);
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:456px;height:280px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 4,
      camera: { position: [0, 7, 6], target: [-0.7, -0.2, 0], fov: 42, near: 0.1, far: 40 },
    });
    const device = engine.gpu;
    device.pushErrorScope('validation');
    const uncaptured = [];
    device.addEventListener('uncapturederror', (event) => uncaptured.push(event.error.message));
    const cells = [80, 8];
    const spacing = 0.125;
    const size = cells.map((n) => n * spacing);
    const origin = size.map((extent) => -extent / 2);
    const count = cells[0] * cells[1];
    const xCentre = (i) => ((i % cells[0]) + 0.5) * spacing;
    const bathymetry = Float32Array.from({ length: count }, (_, i) => Math.max(-1, xCentre(i) / 3 - 2));
    const surface = Float64Array.from({ length: count }, (_, i) => {
      const r = (xCentre(i) - 3) / 2;
      return 0.3 * Math.max(0, 1 - r * r) ** 2;
    });
    const tsunami = await TsunamiSolver.load();
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -9.81, 0] }).add(tsunami, {
      cells,
      spacing,
      origin,
      bathymetry,
      surface,
      dischargeX: surface.map((height) => Math.sqrt(9.81) * height),
    });
    const terrain = device.createTexture({
      size: cells,
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: terrain }, bathymetry, { bytesPerRow: cells[0] * 4 }, cells);
    const water = Water.attach(engine, {
      height: -1,
      size,
      terrain: { heightmap: () => terrain, origin, size },
      segments: 160,
      waves: [{ direction: [1, 0], amplitude: 0, wavelength: 9 }],
    });
    const source = tsunami.surfaceSource();
    const mirror = ShallowWaterSurface.attach(engine, { surface: water, source });
    const draw = async () => {
      engine.render({ delta: 0 });
      await device.queue.onSubmittedWorkDone();
    };
    try {
      await waitForPipelines(draw);
      await draw();
      const shoreX = origin[0] + xCentre(48);
      const centreZ = origin[1] + 3.5 * spacing;
      const depth = { depth: 0, surface: 0, velocity: [0, 0] };
      const dryBefore = source.sample(shoreX, centreZ, depth).depth === 0;
      const before = await WaveQuery.capture(water);
      const snap = world.takeSnapshot();
      world.advance(100);
      await draw();
      const after = await WaveQuery.capture(water);
      const expected = source.sample(shoreX, centreZ, depth).surface;
      const wetDepth = depth.depth;
      const rendered = after.heightAt(shoreX, centreZ);
      const beforeHeight = before.heightAt(shoreX, centreZ);
      const hash = world.hash();
      world.restoreSnapshot(snap.bytes);
      world.advance(100);
      const replay = world.hash();
      return {
        dryBefore,
        beforeVisible: beforeHeight !== undefined,
        wetDepth,
        expected,
        rendered,
        hash,
        replay,
        error: (await device.popErrorScope())?.message ?? null,
        uncaptured,
      };
    } finally {
      mirror.dispose();
      water.dispose();
      terrain.destroy();
      engine.dispose();
    }
  });
  console.log(JSON.stringify({ backend: hardware.compat ? 'webgl2' : 'webgpu', ...result }));
  assert.ok(result.dryBefore && !result.beforeVisible, 'the original dry coast is absent from the surface query');
  assert.ok(result.wetDepth > 0.001, 'the resolved wave inundates the same shore cell');
  assert.ok(Number.isFinite(result.rendered));
  const f32Bound = 8 * 2 ** -24 * Math.max(1, Math.abs(result.expected));
  assert.ok(Math.abs(result.rendered - result.expected) < f32Bound, 'Water draws the accepted world surface');
  assert.equal(result.replay, result.hash);
  assert.deepEqual([result.error, result.uncaptured, errors], [null, [], []]);
} finally {
  await closeAll({ browser });
}
