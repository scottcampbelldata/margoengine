import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const { page, close, hardware } = await openBrowser({ startPath: '/tools/shot/blank.html', port: 'free' });
const backend = hardware.compat ? 'WebGL2' : 'WebGPU';
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const output = process.env.MARGO_KEEP_CLOUD_FRAMES === '1' ? 'packages/physics/test-results/coastal-cloud' : undefined;
if (output) await mkdir(output, { recursive: true });
const capture = async (name) =>
  decodePNG(
    await page.locator('canvas').screenshot(output ? { path: output + '/' + backend + '-' + name + '.png' } : {}),
  );

function cloudPixels(clear, frame) {
  assert.equal(clear.data.length, frame.data.length);
  let active = 0;
  let weightedX = 0;
  let total = 0;
  for (let i = 0; i < frame.data.length; i += 4) {
    const rgb =
      Math.abs(clear.data[i] - frame.data[i]) +
      Math.abs(clear.data[i + 1] - frame.data[i + 1]) +
      Math.abs(clear.data[i + 2] - frame.data[i + 2]);
    if (rgb >= 24) {
      active++;
      weightedX += ((i / 4) % frame.width) * rgb;
      total += rgb;
    }
  }
  return { active, x: total > 0 ? weightedX / total : 0 };
}

try {
  const setup = await page.evaluate(async () => {
    const [
      { EngineKernel },
      { PhysicsWorld, regionWords },
      { CloudSolver, CLOUD_WATER_FIELD, CLOUD_LAYOUT },
      { BoundaryLayerSolver },
      { BoundaryLayerWind },
      { CloudDensityVolume },
      { VolumetricFog },
      { FilmClock },
      { Sky },
      { Water },
      { Tonemap },
      { waitForPipelines },
    ] = await Promise.all([
      import('/packages/core/dist/index.js'),
      import('/packages/physics/dist/world.js'),
      import('/packages/physics/dist/clouds.js'),
      import('/packages/physics/dist/boundary-layer.js'),
      import('/packages/weather/dist/boundary-layer.js'),
      import('/packages/environment/dist/density-volume.js'),
      import('/packages/environment/dist/volumetric.js'),
      import('/packages/math/dist/clock.js'),
      import('/packages/sky/dist/index.js'),
      import('/packages/water/dist/index.js'),
      import('/packages/tonemap/dist/index.js'),
      import('/scripts/support/gpu-ready.js'),
    ]);

    const start = 12;
    const checkpoint = 30;
    const stop = 40;
    const cellSize = 84;
    const film = new FilmClock({ fps: 60 });
    const world = new PhysicsWorld({ rate: film.fps });
    const wind = await BoundaryLayerSolver.load({ id: 'coastal-wind' });
    world.add(wind, {
      profile: new BoundaryLayerWind({ speed: 7.5, roughness: 0.0002, turbulence: false }).profile,
      grid: { cells: [2, 6, 2], origin: [-1260, 84, -588], spacing: [2520, 168, 1176] },
    });
    const cloud = new CloudSolver();
    world.add(cloud, {
      cells: [30, 12, 14],
      cellSize,
      interval: 3,
      timeScale: 180,
      seaLevelTemperature: 293.15,
      humidity: 0.96,
      humidityTop: 0.96,
      surfaceHeat: 0,
      surfaceLatent: 0,
      vorticity: 0,
      wind,
      bubbles: [
        { centre: [-520, 360, -110], radius: 328, warming: 2.2, humidity: 1.2 },
        { centre: [-315, 460, 125], radius: 280, warming: 2.64, humidity: 1.19 },
      ],
    });
    const volume = new CloudDensityVolume(cloud, { airDensity: 1.18, effectiveRadius: 12e-6 });
    const initial = world.takeSnapshot();
    let saved;
    let frame = 0;

    const width = 560;
    const height = 322;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:560px;height:322px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      exactSize: [width, height],
      antialias: true,
      camera: { position: [10, 205, 2350], target: [10, 320, 0], fov: 32, near: 15, far: 10000 },
    });
    engine.scene.background = '#5d93b8';
    Sky.attach(engine, { hours: 9, timeScale: 0 });
    Water.attach(engine, {
      size: [6000, 6000],
      horizon: true,
      segments: 64,
      waves: [{ direction: [1, 0], amplitude: 0.16, wavelength: 48 }],
    });
    Tonemap.attach(engine);
    const fog = VolumetricFog.attach(engine, {
      density: 0,
      volumes: volume,
      grid: [72, 40, 104],
      range: 5100,
      ambient: [0.82, 0.87, 0.96],
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
    await waitForPipelines(draw);

    function projectX([x, y, z]) {
      const m = engine.camera.matrix;
      const w = m[3] * x + m[7] * y + m[11] * z + m[15];
      return ((1 + (m[0] * x + m[4] * y + m[8] * z + m[12]) / w) * width) / 2;
    }

    function read() {
      const port = world.fields.port(CLOUD_WATER_FIELD.name);
      if (!port || port.tick + 1 !== frame || port.region.type !== 'f32' || port.region.layout !== CLOUD_LAYOUT)
        throw new Error('The scene requires the current accepted f32 cloud-water registry field.');
      const q = regionWords(world.memory, port.region);
      const {
        cells: [nx, ny, nz],
        origin,
      } = cloud.grid;
      if (q.length !== nx * ny * nz) throw new Error('Cloud water must cover the configured grid.');
      let total = 0;
      let first = 0;
      let second = 0;
      let yMoment = 0;
      let zMoment = 0;
      let maxIndex = 0;
      for (let i = 0; i < q.length; i++) {
        const indices = [i % nx, Math.floor(i / nx) % ny, Math.floor(i / (nx * ny))];
        if (volume.voxel(...indices) !== q[i] || !Number.isFinite(q[i]) || q[i] < 0)
          throw new Error('The displayed voxel must be the accepted water at its physical cell.');
        if (q[i] > q[maxIndex]) maxIndex = i;
        const [x, y, z] = indices.map((index, axis) => origin[axis] + (index + 0.5) * cellSize);
        total += q[i];
        first += q[i] * x;
        second += q[i] * x * x;
        yMoment += q[i] * y;
        zMoment += q[i] * z;
      }
      const maxPosition = [maxIndex % nx, Math.floor(maxIndex / nx) % ny, Math.floor(maxIndex / (nx * ny))].map(
        (index, axis) => origin[axis] + (index + 0.5) * cellSize,
      );
      const centre = total > 0 ? [first / total, yMoment / total, zMoment / total] : [0, 0, 0];
      return {
        centre,
        variance: total > 0 ? second / total - centre[0] * centre[0] : 0,
        total,
        peak: q[maxIndex],
        extinction: volume.sample(maxPosition),
        project: projectX(centre),
        cellPixels: Math.abs(projectX([centre[0] + cellSize, centre[1], centre[2]]) - projectX(centre)),
      };
    }

    window.cloudShot = {
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
        volume.update();
        const water = read();
        const snapshot = world.takeSnapshot();
        if (action === 'save') saved = snapshot;
        // A fixed-camera film seek starts each sampled frame with fresh volumetric history.
        fog.resetTime();
        await waitForPipelines(draw, { ready: () => !!fog.texture });
        return {
          ...water,
          hash: snapshot.hash,
          time: cloud.time,
          bricks: volume.brickCount,
          froxels: fog.texture ? [fog.texture.width, fog.texture.height, fog.texture.depthOrArrayLayers] : null,
        };
      },
      async detach() {
        fog.options.volumes = undefined;
        volume.dispose();
        await waitForPipelines(draw);
      },
      async dispose() {
        const validation = (await gpu.popErrorScope())?.message ?? null;
        engine.dispose();
        return { validation, gpuErrors };
      },
    };
    return { start, stop, checkpoint, cellSize };
  });

  const render = (frame, action) => page.evaluate(([f, a]) => window.cloudShot.at(f, a), [frame, action]);
  const clear = await render(0);
  const clearPixels = await capture('clear');
  assert.deepEqual(await render(setup.start - 1), clear);
  assert.deepEqual((await capture('held-clear')).data, clearPixels.data);
  const lit = await render(setup.start + 1);
  const litPixels = await capture('condensation');
  const checkpoint = await render(setup.checkpoint, 'save');
  const checkpointPixels = await capture('checkpoint');
  const end = await render(setup.stop);
  const endPixels = await capture('advected');
  assert.deepEqual(await render(setup.stop + 18), end);
  assert.deepEqual((await capture('hold')).data, endPixels.data);
  assert.deepEqual(await render(setup.checkpoint, 'restore'), checkpoint);
  assert.deepEqual((await capture('restored')).data, checkpointPixels.data);
  assert.deepEqual(await render(setup.stop), end);
  assert.deepEqual((await capture('replay')).data, endPixels.data);
  await page.evaluate(() => window.cloudShot.detach());
  const detached = await capture('detached');
  assert.deepEqual(await page.evaluate(() => window.cloudShot.dispose()), { validation: null, gpuErrors: [] });
  assert.deepEqual(errors, []);

  assert.equal(clear.total, 0);
  assert.equal(clear.bricks, 0);
  assert.equal(lit.time, 3);
  assert.equal(end.time, 84);
  assert.notEqual(end.hash, lit.hash);
  assert.deepEqual(end.froxels, [72, 40, 104]);
  for (const state of [lit, checkpoint, end]) {
    assert(state.total > 0 && state.bricks > 0);
    // Q_ext = 2 in the large-droplet limit. Compute from per-drop mass and cross-section.
    const r = 12e-6;
    const extinction = (1.18 * state.peak * 2 * Math.PI * r * r) / ((4 * Math.PI * 1000 * r ** 3) / 3);
    assert(Math.abs(state.extinction - extinction) < 1e-14);
  }
  const drift = end.centre[0] - lit.centre[0];
  const expectedSpeed = (y) => (7.5 * Math.log(y / 0.0002)) / Math.log(10 / 0.0002);
  // Resolve a displacement beyond a cell, and bound it by the neutral flow across the cloud grid
  // with one cell's spatial uncertainty at each end.
  const span = end.time - lit.time;
  assert(drift > span * expectedSpeed(setup.cellSize / 2) - 2 * setup.cellSize);
  assert(drift < span * expectedSpeed(11.5 * setup.cellSize) + 2 * setup.cellSize);
  assert(end.centre[1] > lit.centre[1]);
  assert(Math.abs(end.variance - lit.variance) > setup.cellSize ** 2 / 12);
  assert.deepEqual(detached.data, clearPixels.data);
  const first = cloudPixels(clearPixels, litPixels);
  const last = cloudPixels(clearPixels, endPixels);
  assert(first.active > 1000 && last.active > 1000, JSON.stringify({ first, last }));
  assert(last.x - first.x > 2 * end.cellPixels);
  assert(Math.sign(last.x - first.x) === Math.sign(end.project - lit.project));
  console.log(
    `  ${backend} coastal cloud: ${drift.toFixed(1)} m drift, centroid rose ${(end.centre[1] - lit.centre[1]).toFixed(1)} m, visible centroid shifted ${(last.x - first.x).toFixed(1)} px, ${last.active} rendered cloud pixels, replay ${end.hash}`,
  );
} finally {
  await close();
}
