import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const { page, close, hardware } = await openBrowser({ startPath: '/tools/shot/blank.html', port: 'free' });
const backend = hardware.compat ? 'WebGL2' : 'WebGPU';
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const output =
  process.env.MARGO_KEEP_SPRAY_FRAMES === '1' ? 'packages/physics/test-results/coastal-spindrift' : undefined;
if (output) await mkdir(output, { recursive: true });
const capture = async (name) =>
  decodePNG(
    await page.locator('canvas').screenshot(output ? { path: output + '/' + backend + '-' + name + '.png' } : {}),
  );

function differentPixels(spray, sea) {
  assert.equal(spray.data.length, sea.data.length);
  let changed = 0;
  let energy = 0;
  for (let i = 0; i < sea.data.length; i += 4) {
    const rgb =
      Math.abs(spray.data[i] - sea.data[i]) +
      Math.abs(spray.data[i + 1] - sea.data[i + 1]) +
      Math.abs(spray.data[i + 2] - sea.data[i + 2]);
    if (rgb > 0) changed++;
    energy += rgb;
  }
  return { changed, energy };
}

try {
  const setup = await page.evaluate(async () => {
    const [
      { EngineKernel },
      { PhysicsWorld, regionWords },
      { AirborneParticles },
      { BoundaryLayerSolver },
      { BoundaryLayerWind },
      { WaveSolver },
      { SpectralSea },
      { FoamSolver, SEA_FOAM_FIELD },
      { SeaSprayDensityVolume },
      { VolumetricFog },
      { FilmClock },
      { Sky },
      { Water },
      { Tonemap },
      { waitForPipelines },
    ] = await Promise.all([
      import('/packages/core/dist/index.js'),
      import('/packages/physics/dist/world.js'),
      import('/packages/physics/dist/airborne.js'),
      import('/packages/physics/dist/boundary-layer.js'),
      import('/packages/weather/dist/boundary-layer.js'),
      import('/packages/physics/dist/waves.js'),
      import('/packages/physics/dist/sea.js'),
      import('/packages/physics/dist/foam.js'),
      import('/packages/environment/dist/density-volume.js'),
      import('/packages/environment/dist/volumetric.js'),
      import('/packages/math/dist/clock.js'),
      import('/packages/sky/dist/index.js'),
      import('/packages/water/dist/index.js'),
      import('/packages/tonemap/dist/index.js'),
      import('/scripts/support/gpu-ready.js'),
    ]);
    const start = 12;
    const checkpoint = start + 80;
    const stop = start + 120;
    const releaseHeight = 1.1;
    const fps = 60;
    const film = new FilmClock({ fps });
    const world = new PhysicsWorld({ rate: film.fps, seed: 42 });
    const profile = { speed: 22, roughness: 0.0002, turbulence: false };
    const wind = await BoundaryLayerSolver.load({ id: 'winter-sea-wind' });
    world.add(wind, {
      profile: new BoundaryLayerWind(profile).profile,
      grid: { cells: [2, 4, 2], origin: [-16, 0, -16], spacing: [32, 1, 32] },
    });
    const waves = new WaveSolver();
    const swell = { height: 4, period: 6, direction: 0 };
    world.add(waves, {
      cells: [4, 4],
      cellSize: 24,
      depth: 80,
      frequencies: { count: 24, min: 0.06, max: 0.06 * 1.12 ** 23 },
      directions: 16,
      start: swell,
      swell,
      wind,
      interval: 1,
    });
    const foam = new FoamSolver();
    world.add(foam, { waves: waves.field, cells: [12, 12], cellSize: 3, wind, statistics: 18 });
    const airborne = await AirborneParticles.load({ whitecaps: true });
    world.add(airborne, {
      capacity: 2048,
      wind,
      spray: { columns: 12, rows: 12, spacing: 3, centre: [0, 0], releaseHeight, liftVelocity: 1 },
      bounds: [
        [-40, 0, -40],
        [45, 10, 40],
      ],
    });
    const initial = world.takeSnapshot();
    const volume = new SeaSprayDensityVolume(airborne, { voxelSize: 0.09, cellSize: world.cellSize });
    const sea = new SpectralSea({ waves: waves.field, seed: 42 });
    const width = 500;
    const height = 282;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:500px;height:282px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      exactSize: [width, height],
      camera: { position: [35, 3.3, 10], target: [7, 1.25, -1], fov: 23, near: 0.35, far: 360 },
    });
    // A small angle between the view and low sun makes physically thin spindrift visible in forward scattering.
    Sky.attach(engine, { sunDirection: [-0.94, 0.075, -0.37], timeScale: 0, lighting: { intensity: 3 } });
    const water = Water.attach(engine, { sea, size: [110, 110], segments: 128, horizon: true, whitecaps: 0 });
    Tonemap.attach(engine, { exposure: -0.4 });
    const fog = VolumetricFog.attach(engine, {
      density: 0,
      volumes: volume,
      grid: [100, 56, 92],
      range: 62,
      ambient: [0.37, 0.46, 0.55],
      anisotropy: 0.86,
      temporal: 0,
    });
    const gpu = engine.gpu;
    const gpuErrors = [];
    engine.onError = (error) => gpuErrors.push(String(error));
    gpu.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
    gpu.pushErrorScope('validation');
    const draw = async () => {
      engine.render({ delta: 0 });
      await gpu.queue.onSubmittedWorkDone();
    };
    const settle = () => waitForPipelines(draw, { ready: () => !!fog.texture });
    await settle();

    function receipt() {
      const port = world.fields.port(SEA_FOAM_FIELD.name);
      if (!port || port.region.type !== 'f32' || port.region.layout !== 1)
        throw new Error('Use the accepted active SEA-13 whitecap grid.');
      const foamRows = regionWords(world.memory, port.region);
      let whitecaps = 0;
      for (let i = 1; i < foamRows.length; i += 2) whitecaps += foamRows[i];
      const parcels = airborne.readParticles();
      const widths = new Set();
      let area = 0;
      let centroid = 0;
      for (const { kind, mass, diameter, materialDensity, position } of parcels) {
        if (kind !== 'sea-spray') throw new Error('This fixture sources sea spray exclusively from active whitecaps.');
        const dropRadius = diameter / 2;
        const number = mass / (((4 * Math.PI) / 3) * dropRadius ** 3 * materialDensity);
        const parcelArea = number * 2 * Math.PI * dropRadius * dropRadius;
        area += parcelArea;
        centroid += parcelArea * position[0];
        widths.add(diameter);
      }
      return {
        parcels: parcels.map(({ id, position, velocity }) => [id, ...position, ...velocity]),
        area,
        x: area ? centroid / area : 0,
        diameters: widths.size,
        whitecaps,
        budget: airborne.budget,
      };
    }

    function fromHalf(bits) {
      const exponent = (bits >> 10) & 31;
      const fraction = bits & 1023;
      if (bits & 0x8000 || exponent === 31) throw new Error('Read finite nonnegative optical depth from the GPU.');
      return exponent === 0 ? fraction * 2 ** -24 : (1 + fraction / 1024) * 2 ** (exponent - 15);
    }

    let saved;
    let frame = 0;
    window.sprayShot = {
      async at(shotFrame, action) {
        film.frame = shotFrame;
        const goal = Math.max(0, Math.min(stop - start, film.frame - start));
        if (action === 'restore') {
          world.restoreSnapshot(saved.bytes);
          frame = checkpoint - start;
        } else if (goal < frame) {
          world.restoreSnapshot(initial.bytes);
          frame = 0;
        }
        world.advance(goal);
        frame = goal;
        sea.refresh();
        water.setTime(world.time);
        volume.update(airborne.cell);
        fog.options.enabled = true;
        fog.resetTime();
        const report = receipt();
        const snapshot = world.takeSnapshot();
        if (action === 'save') saved = snapshot;
        await settle();
        return { ...report, time: world.time, hash: snapshot.hash, bricks: volume.brickCount };
      },
      async readOpticalDepth() {
        const texture = fog.texture;
        const row = Math.ceil((texture.width * 8) / 256) * 256;
        const readback = gpu.createBuffer({
          size: row * texture.height,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        const encoder = gpu.createCommandEncoder();
        encoder.copyTextureToBuffer(
          { texture, origin: [0, 0, texture.depthOrArrayLayers - 1] },
          { buffer: readback, bytesPerRow: row },
          [texture.width, texture.height, 1],
        );
        gpu.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const packed = new Uint16Array(readback.getMappedRange());
        let active = 0;
        let peak = 0;
        for (let y = 0; y < texture.height; y++) {
          for (let x = 0; x < texture.width; x++) {
            const alpha = fromHalf(packed[(y * row) / 2 + x * 4 + 3]);
            if (alpha > 0) active++;
            peak = Math.max(peak, alpha);
          }
        }
        readback.unmap();
        readback.destroy();
        return { active, peak };
      },
      async detach() {
        fog.options.volumes = undefined;
        volume.dispose();
        await settle();
      },
      async dispose() {
        const validation = (await gpu.popErrorScope())?.message ?? null;
        engine.dispose();
        wind[Symbol.dispose]();
        airborne[Symbol.dispose]();
        return { validation, gpuErrors };
      },
    };
    return { start, checkpoint, stop, releaseHeight, profile };
  });

  const render = (frame, action) => page.evaluate(([f, a]) => window.sprayShot.at(f, a), [frame, action]);
  const optical = () => page.evaluate(() => window.sprayShot.readOpticalDepth());
  const clear = await render(0);
  const clearPixels = await capture('clear');
  assert.deepEqual(await optical(), { active: 0, peak: 0 });
  assert.deepEqual(await render(setup.start - 1), clear);
  assert.deepEqual((await capture('held-clear')).data, clearPixels.data);
  const first = await render(setup.start + 35);
  await capture('whitecap-release');
  const middle = await render(setup.checkpoint, 'save');
  const middlePixels = await capture('checkpoint');
  const end = await render(setup.stop);
  const endPixels = await capture('advected');
  const present = await optical();
  assert.deepEqual(await render(setup.stop + 20), end);
  assert.deepEqual((await capture('hold')).data, endPixels.data);
  assert.deepEqual(await render(setup.checkpoint, 'restore'), middle);
  assert.deepEqual((await capture('restored')).data, middlePixels.data);
  assert.deepEqual(await render(setup.stop), end);
  assert.deepEqual((await capture('replay')).data, endPixels.data);
  assert.deepEqual(await optical(), present);
  await page.evaluate(() => window.sprayShot.detach());
  const detached = await capture('sea-without-aerosol');
  assert.deepEqual(await optical(), { active: 0, peak: 0 });
  assert.deepEqual(await page.evaluate(() => window.sprayShot.dispose()), { validation: null, gpuErrors: [] });
  assert.deepEqual(errors, []);

  assert.equal(clear.budget.supplied, 0);
  assert.equal(clear.bricks, 0);
  assert.equal(clear.parcels.length, 0);
  assert(first.whitecaps > 0 && first.budget.supplied > 0);
  assert(end.bricks > 0 && end.area > first.area);
  assert.equal(end.diameters, 3);
  const { initial, supplied, airborne, deposited, evaporated, outflow, waiting } = end.budget;
  assert(Math.abs(initial + supplied - airborne - deposited - evaporated - outflow - waiting) < 1e-15);

  // At 1.1 m most film and jet drops rapidly follow the neutral logarithmic wind. For this case their
  // Stokes response times are below 0.011 s (d <= 54 μm, ρ <= 1025, μ >= 1.7e-5), and sphere drag is faster.
  const speedAt = (y) =>
    (setup.profile.speed * Math.log(y / setup.profile.roughness)) / Math.log(10 / setup.profile.roughness);
  const baseline = new Map(first.parcels.map((p) => [p[0], p]));
  const elapsed = end.time - first.time;
  const tracked = end.parcels.filter((p) => baseline.has(p[0]));
  assert(tracked.length > 100);
  let meanTrack = 0;
  for (const [id, x, y, , vx] of tracked) {
    const [, formerX, formerY] = baseline.get(id);
    const min = Math.min(y, formerY) - 0.02;
    const max = Math.max(y, formerY) + 0.02;
    assert(x - formerX > speedAt(min) * (elapsed - 0.011));
    assert(x - formerX < speedAt(max) * elapsed);
    assert(vx > 0 && max < setup.releaseHeight + 0.03);
    meanTrack += (x - formerX) / tracked.length;
  }
  assert(present.active >= 16 && present.peak > 2 ** -14, `No measurable submitted spray: ${JSON.stringify(present)}`);
  const pixels = differentPixels(endPixels, detached);
  assert(
    pixels.changed >= 32 && pixels.energy >= 32,
    `Spindrift did not contribute to the fixed view: ${JSON.stringify(pixels)}`,
  );
  console.log(
    `  ${backend} coastal spray: ${end.parcels.length} accepted parcels, ${tracked.length} tracked ${meanTrack.toFixed(2)} m downwind, ${end.area.toExponential(4)} m² optical area, ${present.active} optical columns (peak ${present.peak.toExponential(3)}), ${pixels.changed} affected pixels, replay ${end.hash}`,
  );
} finally {
  await close();
}
