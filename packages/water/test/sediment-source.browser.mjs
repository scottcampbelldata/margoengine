import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' });
const { page } = browser;
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

try {
  const result = await page.evaluate(async () => {
    const [
      { EngineKernel },
      { PhysicsWorld },
      { TerrainBed },
      { ShallowWaterSolver },
      { SedimentTransport },
      { Water },
      { Flood },
    ] = await Promise.all([
      import('/packages/core/dist/index.js'),
      import('/packages/physics/dist/world.js'),
      import('/packages/physics/dist/earth.js'),
      import('/packages/physics/dist/hydro.js'),
      import('/packages/physics/dist/sediment.js'),
      import('/packages/water/dist/index.js'),
      import('/packages/water/dist/flood.js'),
    ]);

    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:128px;height:96px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 4,
      camera: { position: [24, 25, 35], target: [20, 0, 12], near: 0.1, far: 500 },
    });
    const device = engine.gpu;
    const columns = 4,
      rows = 3,
      width = 40,
      depth = 24;
    const shape = { columns, rows, width, depth, centre: [width / 2, depth / 2] };
    const sediment = await SedimentTransport.load();
    const bed = new TerrainBed();
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
      .add(bed, { ...shape, elevations: () => 0 })
      .add(new ShallowWaterSolver(), { bed: bed.bed, depth: 1 })
      .add(sediment, { grid: shape, suspendedMass: 20, settlingVelocity: 0 });

    device.pushErrorScope('validation');
    const uncaptured = [];
    device.addEventListener('uncapturederror', (e) => uncaptured.push(e.error.message));
    const terrain = device.createTexture({
      size: [16, 16],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: terrain }, new Float32Array(16 * 16), { bytesPerRow: 64 }, [16, 16]);
    const water = Water.attach(engine, {
      height: -50,
      size: [60, 45],
      segments: 16,
      waves: [{ direction: [1, 0], amplitude: 0, wavelength: 10 }],
      terrain: { heightmap: () => terrain, origin: [0, 0], size: [width, depth] },
      fill: () => 1,
    });
    let uploads = 0;
    let peak = 0;
    const flood = Flood.attach(engine, {
      surface: water,
      sediment: {
        source: {
          concentrationSize: sediment.concentrationSize,
          copyConcentrations(out) {
            sediment.copyConcentrations(out);
            uploads++;
            peak = Math.max(peak, ...out);
          },
        },
      },
    });
    const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    const frame = async () => {
      engine.render({ delta: 1 / 60 });
      await device.queue.onSubmittedWorkDone();
    };
    await waitForPipelines(frame);
    await flood.settle();
    const still = async () => {
      for (let i = 0; i < 5; i++) {
        engine.render({ delta: 0 });
        await device.queue.onSubmittedWorkDone();
      }
      engine.render({ delta: 0 });
      const pixels = new OffscreenCanvas(canvas.width, canvas.height).getContext('2d');
      pixels.drawImage(canvas, 0, 0);
      return pixels.getImageData(0, 0, canvas.width, canvas.height).data;
    };

    const clear = await still();
    const initialPeak = peak;
    world.advance(1);
    const dirty = await still();
    let changed = 0;
    for (let i = 0; i < clear.length; i += 4) {
      const difference =
        Math.abs(clear[i] - dirty[i]) + Math.abs(clear[i + 1] - dirty[i + 1]) + Math.abs(clear[i + 2] - dirty[i + 2]);
      if (difference > 8) changed++;
    }
    const validation = await device.popErrorScope();
    const wetArea = (await flood.read()).wetArea;
    flood.dispose();
    water.dispose();
    terrain.destroy();
    engine.dispose();
    return { changed, initialPeak, peak, uploads, wetArea, uncaptured, validation: validation?.message ?? null };
  });

  assert.deepEqual(errors, []);
  assert.equal(result.validation, null);
  assert.deepEqual(result.uncaptured, []);
  assert.equal(result.initialPeak, 0);
  assert.equal(result.peak, 20);
  assert.ok(result.uploads >= 2);
  assert.ok(result.wetArea > 0, `the optical fixture draws wet cells: ${JSON.stringify(result)}`);
  assert.ok(result.changed > 0, `the real suspended load changes the water shading: ${JSON.stringify(result)}`);
  console.log('ok physical sediment tint', result);
} finally {
  await closeAll({ browser });
}
