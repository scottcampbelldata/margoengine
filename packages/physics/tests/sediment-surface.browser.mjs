import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const { page, close, hardware } = await openBrowser({ startPath: '/tools/shot/blank.html', port: 'free' });
const backend = hardware.compat ? 'WebGL2' : 'WebGPU';
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const output =
  process.env.MARGO_KEEP_SEDIMENT_FRAMES === '1' ? 'packages/physics/test-results/sediment-flume' : undefined;
if (output) await mkdir(output, { recursive: true });
const capture = async (name) =>
  decodePNG(
    await page.locator('canvas').screenshot(output ? { path: output + '/' + backend + '-' + name + '.png' } : {}),
  );

function changedPixels(before, after) {
  assert.equal(before.data.length, after.data.length);
  let count = 0;
  for (let i = 0; i < before.data.length; i += 4) {
    const difference =
      Math.abs(before.data[i] - after.data[i]) +
      Math.abs(before.data[i + 1] - after.data[i + 1]) +
      Math.abs(before.data[i + 2] - after.data[i + 2]);
    if (difference >= 18) count++;
  }
  return count;
}

try {
  await page.evaluate(async () => {
    const [
      { EngineKernel, PbrMaterial, box },
      { TerrainBed },
      { ShallowWaterSolver },
      { SedimentTransport },
      { PhysicsWorld, regionWords },
      { Terrain },
      { Water },
      { ShallowWaterSurface },
      { WaveQuery },
      { FilmClock },
      { waitForPipelines },
    ] = await Promise.all([
      import('/packages/core/dist/index.js'),
      import('/packages/physics/dist/earth.js'),
      import('/packages/physics/dist/hydro.js'),
      import('/packages/physics/dist/sediment.js'),
      import('/packages/physics/dist/world.js'),
      import('/packages/terrain/dist/index.js'),
      import('/packages/water/dist/index.js'),
      import('/packages/water/dist/shallow-surface.js'),
      import('/packages/water/dist/query.js'),
      import('/packages/math/dist/clock.js'),
      import('/scripts/support/gpu-ready.js'),
    ]);

    const columns = 18;
    const rows = 6;
    const step = 0.25;
    const width = columns * step;
    const depth = rows * step;
    const size = [width, depth];
    const origin = [-width / 2, -depth / 2];
    const grid = { columns, rows, width, depth, centre: [0, 0] };
    const elevation = (x, z) => {
      const dune = 0.085 * Math.exp(-((x + 0.1) ** 2 / 0.25 + (z - 0.18) ** 2 / 0.11));
      return 0.22 - 0.032 * x + 0.09 * Math.max(0, Math.abs(z + 0.04) - 0.35) + dune;
    };
    const mobileDepth = 0.12;
    const grainDensity = 2650;
    const porosity = 0.4;
    const bulkDensity = grainDensity * (1 - porosity);
    const roughness = 0.024;
    const start = 30;
    const stop = 390;
    const end = 840;
    const jets = 2;
    const ratePerJet = 0.09;
    const shotStart = 12;
    const filmClock = new FilmClock({ fps: 60 });
    const inlet = {
      name: 'sediment-flume:inlet',
      kind: 'uniformGrid',
      quantity: 'discharge',
      unit: 'm^3/s',
      centring: 'cell',
    };
    let inletHost;
    let inletRegion;
    const gate = {
      describe: () => ({ id: 'flume-gate', rate: 0, stableRate: () => 0, fields: [{ field: inlet, access: 'write' }] }),
      init(host) {
        inletHost = host;
        inletRegion = host.allocate('outlet-discharge', jets * 8, 'f64', 1);
      },
      importPorts() {},
      step({ tick }) {
        regionWords(inletHost.memory, inletRegion).fill(tick >= start && tick < stop ? ratePerJet : 0);
      },
      exportPorts: (tick) => [{ field: inlet.name, region: inletRegion, tick, cell: inletHost.cell }],
      stateRegions: () => [inletRegion],
      extraState: () => [],
    };

    const terrain = new TerrainBed();
    const hydro = new ShallowWaterSolver('water', {
      field: inlet,
      outlets: [
        { sourceCell: 0, position: [-1.875, -0.125] },
        { sourceCell: 1, position: [-1.875, 0.125] },
      ],
    });
    const sediment = await SedimentTransport.load();
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
      .add(terrain, { ...grid, elevations: elevation, bedrock: (x, z) => elevation(x, z) - mobileDepth })
      .add(gate, {})
      .add(hydro, { bed: terrain.bed, roughness, sides: { maxX: 'open' } })
      .add(sediment, {
        grid,
        mobileDepth,
        porosity,
        roughness,
        grainDensity,
        grainDiameter: 0.00062,
        suspendedDiameter: 0.00019,
        open: { maxX: true },
      });

    const initial = world.takeSnapshot();
    const initialBed = terrain.elevations();
    const initialVolume = terrain.volume();
    const authoredSolid = width * depth * mobileDepth * bulkDensity;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:460px;height:300px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      exactSize: [460, 300],
      antialias: true,
      camera: { position: [1.35, 2.9, 4.65], target: [-0.12, 0.18, 0], fov: 37, near: 0.3, far: 60 },
    });
    engine.scene.background = '#9aadb6';
    engine.lighting.direction.set([-0.55, 0.68, 0.48, 1.85]);
    engine.lighting.radiance.set([1, 0.92, 0.79, 0.26]);
    engine.lighting.ambient.set([0.57, 0.64, 0.73]);
    const support = new PbrMaterial({ color: '#59656b', roughness: 0.79 });
    const rim = new PbrMaterial({ color: '#596067', roughness: 0.49 });
    const solid = (size, material, position) =>
      engine
        .createMesh()
        .setGeometry(box(...size))
        .setMaterial(material)
        .setPosition(position);
    solid([width + 0.1, 0.24, depth + 0.14], support, [0, 0.01, 0]);
    solid([width + 0.15, 0.21, 0.068], rim, [0, 0.255, origin[1] - 0.045]);
    solid([width + 0.15, 0.105, 0.068], rim, [0, 0.202, -origin[1] + 0.045]);
    solid([0.075, 0.18, depth + 0.125], rim, [origin[0] - 0.043, 0.269, 0]);
    solid([0.095, 0.1, 0.55], support, [origin[0] + 0.31, 0.54, 0]);
    for (const z of [-0.125, 0.125]) solid([0.115, 0.085, 0.083], rim, [origin[0] + 0.39, 0.475, z]);
    solid([28, 0.2, 25], new PbrMaterial({ color: '#929996', roughness: 0.88 }), [0, -0.23, 0]);

    const gpu = engine.gpu;
    const gpuErrors = [];
    engine.onError = (error) => gpuErrors.push(String(error));
    gpu.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
    gpu.pushErrorScope('validation');

    const nx = columns + 1;
    const nz = rows + 1;
    const bedTexels = new Float32Array(nx * nz);
    const waterBed = new Float32Array(columns * rows);
    function upload(texture, values, x, z) {
      gpu.queue.writeTexture({ texture }, values, { bytesPerRow: x * 4, rowsPerImage: z }, [x, z]);
    }
    function copyBed() {
      const accepted = terrain.elevations();
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) bedTexels[j * nx + i] = accepted[j + i * nz];
      for (let j = 0; j < rows; j++)
        for (let i = 0; i < columns; i++)
          waterBed[j * columns + i] = terrain.bed.sample(
            origin[0] + (i + 0.5) * step,
            origin[1] + (j + 0.5) * step,
          ).elevation;
      return accepted;
    }
    copyBed();
    const heightUsage = GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING;
    const waterTexture = gpu.createTexture({ size: [columns, rows], format: 'r32float', usage: heightUsage });
    upload(waterTexture, waterBed, columns, rows);
    const mesh = Terrain.attach(engine, {
      origin,
      size,
      heightScale: 1,
      cellSize: 0.0625,
      resolution: 80,
      levels: 1,
      clipmapAnchor: [0, 0],
      captureSurfaceHeight: true,
      roughness: 0.9,
      layers: Array.from({ length: 4 }, () => ({ height: [-1, 1], slope: [0, 1], scale: 6 })),
      textures(device) {
        const heightmap = device.createTexture({ size: [nx, nz], format: 'r32float', usage: heightUsage });
        upload(heightmap, bedTexels, nx, nz);
        const layers = device.createTexture({ size: [4, 4, 4], format: 'rgba8unorm-srgb', usage: heightUsage });
        const sand = new Uint8Array(4 * 4 * 4 * 4);
        for (let i = 0; i < sand.length / 4; i++) {
          const offset = ((i * 41 + (i >> 2) * 13) % 19) - 9;
          sand.set([162 + offset, 143 + offset, 112 + offset, 255], 4 * i);
        }
        device.queue.writeTexture({ texture: layers }, sand, { bytesPerRow: 16, rowsPerImage: 4 }, [4, 4, 4]);
        return { heightmap, layers };
      },
    });
    const water = Water.attach(engine, {
      height: -1,
      size,
      segments: 72,
      terrain: { heightmap: () => waterTexture, origin, size },
      waves: [{ direction: [1, 0], amplitude: 0, wavelength: 1.6 }],
      color: [0.018, 0.14, 0.18],
      foamDistance: 0.07,
    });
    let invalid;
    try {
      ShallowWaterSurface.attach(engine, {
        surface: water,
        source: hydro,
        sediment: { concentrationSize: [columns - 1, rows], copyConcentrations() {} },
      });
    } catch (error) {
      invalid = { name: error.name, code: error.code, message: error.message };
    }
    let clearOptics = false;
    let uploads = 0;
    const sedimentSource = {
      get concentrationSize() {
        return sediment.concentrationSize;
      },
      copyConcentrations(values) {
        sediment.copyConcentrations(values);
        uploads++;
        if (clearOptics) values.fill(0);
      },
    };
    const mirror = ShallowWaterSurface.attach(engine, { surface: water, source: hydro, sediment: sedimentSource });

    const draw = async () => {
      engine.render({ delta: 0 });
      await gpu.queue.onSubmittedWorkDone();
    };
    await waitForPipelines(draw);

    async function drawnBed() {
      const texture = mesh.surfaceHeightTexture;
      if (!texture || texture.width !== nx || texture.height !== nz)
        throw new Error('The real terrain renderer must supply a drawn-height texture at the bed resolution.');
      const half = texture.format === 'rgba16float';
      const bytes = half ? 8 : 4;
      const rowBytes = Math.ceil((nx * bytes) / 256) * 256;
      const buffer = gpu.createBuffer({
        size: rowBytes * nz,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      try {
        const encoder = gpu.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: rowBytes, rowsPerImage: nz }, [nx, nz]);
        gpu.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const values = half ? new Float16Array(buffer.getMappedRange()) : new Float32Array(buffer.getMappedRange());
        let residual = 0;
        for (let r = 1; r < rows; r++) {
          for (let c = 1; c < columns; c++) {
            const actual = half ? values[(r * rowBytes) / 2 + 4 * c] : values[(r * rowBytes) / 4 + c];
            const expected = bedTexels[r * nx + c];
            const halfUlp = half ? 0.5 * 2 ** (Math.floor(Math.log2(expected)) - 10) : 0;
            const difference = Math.abs(actual - expected);
            if (!(difference <= halfUlp + 2e-6))
              throw new Error('Drawn morphology differs from the accepted bed at ' + c + ',' + r);
            residual = Math.max(residual, difference);
          }
        }
        return residual;
      } finally {
        buffer.destroy();
      }
    }

    let checkpoint;
    const concentration = new Float32Array(columns * rows);
    window.sedimentShot = {
      async at(shot, action) {
        filmClock.frame = shot;
        const frame = Math.min(end, Math.max(0, filmClock.frame - shotStart));
        if (action === 'restore') world.restoreSnapshot(checkpoint.bytes);
        if (frame < world.clock.frame) world.restoreSnapshot(initial.bytes);
        world.advance(frame);
        const state = world.takeSnapshot();
        if (action === 'save') checkpoint = state;
        const acceptedBed = copyBed();
        upload(mesh.heightmap, bedTexels, nx, nz);
        upload(waterTexture, waterBed, columns, rows);
        mesh.invalidate();
        clearOptics = false;
        const beforeUpload = uploads;
        await draw();
        if (uploads <= beforeUpload)
          throw new Error('The live Water surface must read the accepted sediment before drawing.');
        const residual = await drawnBed();
        let scour = 0;
        let deposit = 0;
        for (let i = 0; i < acceptedBed.length; i++) {
          scour = Math.min(scour, acceptedBed[i] - initialBed[i]);
          deposit = Math.max(deposit, acceptedBed[i] - initialBed[i]);
        }
        const port = world.fields.port(sediment.concentrationField.name);
        const physical = regionWords(world.memory, port.region);
        sediment.copyConcentrations(concentration);
        let weighted = 0;
        let total = 0;
        for (let i = 0; i < concentration.length; i++) {
          if (
            concentration[i] !== Math.fround(physical[i]) ||
            !Number.isFinite(concentration[i]) ||
            concentration[i] < 0
          )
            throw new Error('The live tint concentration must agree with the accepted sediment field.');
          weighted += concentration[i] * (origin[0] + (0.5 + (i % columns)) * step);
          total += concentration[i];
        }
        const authorVolume = (jets * ratePerJet * Math.max(0, Math.min(frame, stop) - start)) / 60;
        return {
          frame,
          hash: state.hash,
          initialVolume,
          authoredSolid,
          bulkDensity,
          authorVolume,
          scour,
          deposit,
          residual,
          concentrationCentre: total > 0 ? weighted / total : null,
          water: hydro.budget,
          volume: hydro.volume(),
          solid: sediment.budget,
          liveVolume: terrain.volume(),
          refused: terrain.refusedVolume(),
        };
      },
      async opticsOnly() {
        clearOptics = true;
        await draw();
        return world.hash();
      },
      async waterHeights() {
        const query = await WaveQuery.capture(water);
        return [5, 8, 11, 14].map((column) => {
          const x = origin[0] + (column + 0.5) * step;
          const z = 0.125;
          const physical = hydro.sample(x, z);
          return { actual: query.heightAt(x, z) ?? null, depth: physical.depth, expected: physical.surface };
        });
      },
      async dispose() {
        mirror.dispose();
        water.dispose();
        mesh.dispose();
        waterTexture.destroy();
        const validation = (await gpu.popErrorScope())?.message ?? null;
        engine.dispose();
        return { validation, gpuErrors, invalid };
      },
    };
  });

  const show = (frame, action) => page.evaluate(([f, a]) => window.sedimentShot.at(f, a), [frame, action]);
  const dry = await show(0);
  const dryImage = await capture('dry');
  const held = await show(11);
  const beforeImage = await capture('pre-trigger');
  const early = await show(102);
  const earlyImage = await capture('runup');
  const moving = await show(272, 'save');
  const movingImage = await capture('scour-and-deposition');
  const probe = await page.evaluate(() => window.sedimentShot.waterHeights());
  const fixedHydro = await page.evaluate(() => window.sedimentShot.opticsOnly());
  const clearImage = await capture('same-bed-clear-water');
  const recession = await show(852);
  const recededImage = await capture('recession');
  const stop = await show(902);
  const stoppedImage = await capture('after-stop');
  const rewound = await show(272, 'restore');
  const rewindImage = await capture('rewound');
  const replay = await show(852);
  const replayImage = await capture('replay');
  const result = await page.evaluate(() => window.sedimentShot.dispose());
  assert.equal(result.validation, null);
  assert.deepEqual(result.gpuErrors, []);
  assert.deepEqual(pageErrors, []);
  assert.equal(result.invalid?.name, 'MargoError');
  assert.equal(result.invalid.code, 'state');
  assert.match(result.invalid.message, /matching positive cell dimensions/i);

  assert.deepEqual(dry, held);
  assert.deepEqual(dryImage.data, beforeImage.data);
  assert.deepEqual(recession, stop);
  assert.deepEqual(recededImage.data, stoppedImage.data);
  assert.deepEqual(moving, rewound);
  assert.deepEqual(movingImage.data, rewindImage.data);
  assert.deepEqual(recession, replay);
  assert.deepEqual(recededImage.data, replayImage.data);
  assert.equal(fixedHydro, moving.hash);
  const wetPixels = changedPixels(dryImage, movingImage);
  const movingPixels = changedPixels(earlyImage, movingImage);
  const opticalPixels = changedPixels(movingImage, clearImage);
  assert.ok(wetPixels > 400 && movingPixels > 300 && opticalPixels > 200);
  assert.ok(changedPixels(movingImage, recededImage) > 300);
  assert.equal(dry.volume, 0);
  assert.ok(early.concentrationCentre < moving.concentrationCentre);
  assert.ok(moving.scour < -0.015 && moving.deposit > 0.0003);
  assert.ok(moving.solid.suspended > 0 && moving.solid.suspendedOut > 0 && moving.solid.bedloadOut > 0);
  assert.ok(recession.volume < moving.volume / 4 && recession.scour < moving.scour);
  for (const sample of probe) {
    assert.ok(sample.depth > 0.006 && sample.actual !== null);
    assert.ok(Math.abs(sample.actual - sample.expected) <= 2e-6, JSON.stringify(sample));
  }
  for (const snapshot of [dry, early, moving, recession]) {
    const mass =
      snapshot.solid.bed + snapshot.solid.suspended + snapshot.solid.suspendedOut + snapshot.solid.bedloadOut;
    // A staggered tick accounts for every cell flux and all four bed corners.
    const units = 32 * (snapshot.frame + 1) * 108 * Number.EPSILON;
    assert.ok(Math.abs(snapshot.water.inflow - snapshot.authorVolume) <= units * Math.max(1, snapshot.authorVolume));
    assert.ok(
      Math.abs(snapshot.volume + snapshot.water.out - snapshot.authorVolume) <=
        units * Math.max(1, snapshot.authorVolume),
    );
    assert.ok(Math.abs(mass - snapshot.authoredSolid) <= units * snapshot.authoredSolid);
    const bedVolumeChange = (snapshot.solid.bed - snapshot.authoredSolid) / snapshot.bulkDensity;
    assert.ok(
      Math.abs(snapshot.liveVolume - snapshot.initialVolume - bedVolumeChange) <= units * snapshot.initialVolume,
    );
    assert.equal(snapshot.refused, 0);
  }
  console.log(
    'HYDRO-03',
    backend,
    moving.hash + ':',
    wetPixels,
    'moving-bed and water pixels,',
    opticalPixels,
    'isolated tint pixels,',
    (1000 * -moving.scour).toFixed(2),
    'mm scour,',
    (1000 * moving.deposit).toFixed(2),
    'mm deposition, exact-ledger replay.',
  );
} finally {
  await close();
}
