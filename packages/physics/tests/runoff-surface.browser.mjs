import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const { page, close, hardware } = await openBrowser({ startPath: '/tools/shot/blank.html', port: 'free' });
const backend = hardware.compat ? 'WebGL2' : 'WebGPU';
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

const output =
  process.env.MARGO_KEEP_RUNOFF_FRAMES === '1' ? 'packages/physics/test-results/runoff-surface' : undefined;
if (output) await mkdir(output, { recursive: true });
const capture = async (name) =>
  decodePNG(
    await page.locator('canvas').screenshot(output ? { path: output + '/' + backend + '-' + name + '.png' } : {}),
  );

function changedPixels(before, after) {
  assert.equal(before.data.length, after.data.length);
  let count = 0;
  for (let i = 0; i < before.data.length; i += 4) {
    const delta =
      Math.abs(before.data[i] - after.data[i]) +
      Math.abs(before.data[i + 1] - after.data[i + 1]) +
      Math.abs(before.data[i + 2] - after.data[i + 2]);
    if (delta >= 12) count++;
  }
  return count;
}

try {
  await page.evaluate(async () => {
    const [
      { EngineKernel, Geometry, PbrMaterial, box },
      { TerrainBed },
      { ShallowWaterSolver },
      { RainfallRunoff },
      { PhysicsWorld, regionWords },
      { Water },
      { ShallowWaterSurface },
      { WaveQuery },
      { waitForPipelines },
    ] = await Promise.all([
      import('/packages/core/dist/index.js'),
      import('/packages/physics/dist/earth.js'),
      import('/packages/physics/dist/hydro.js'),
      import('/packages/physics/dist/runoff.js'),
      import('/packages/physics/dist/world.js'),
      import('/packages/water/dist/index.js'),
      import('/packages/water/dist/shallow-surface.js'),
      import('/packages/water/dist/query.js'),
      import('/scripts/support/gpu-ready.js'),
    ]);

    // A short flume at the downstream end of a V catchment. The render mesh and
    // Water's height texture both use the same bed as the hydraulic solver.
    const columns = 12;
    const rows = 9;
    const step = 0.45;
    const width = columns * step;
    const depth = rows * step;
    const origin = [-width / 2, -depth / 2];
    const elevation = (x, z) => 0.38 - 0.065 * x + 0.12 * Math.abs(z);
    const bed = new TerrainBed();
    const fps = 60;
    const rainStart = 30;
    const rainEnd = 600;
    const rainRate = 0.012;
    const nx = 6;
    const nz = 5;
    const middle = Math.floor(nz / 2);
    const catchmentStep = 0.75;
    const cellArea = catchmentStep * catchmentStep;
    const outlet = middle * nx + nx - 1;
    const inletX = origin[0] + 1.5 * step;
    const downstreamX = inletX + 3 * step;
    const rain = {
      name: 'catchment-storm',
      kind: 'uniformGrid',
      quantity: 'precipitationRate',
      unit: 'm/s',
      centring: 'cell',
    };
    let rainHost;
    let rainRegion;
    const storm = {
      describe: () => ({
        id: 'catchment-rain',
        fields: [{ field: rain, access: 'write' }],
        rate: 0,
        stableRate: () => 0,
      }),
      init(host) {
        rainHost = host;
        rainRegion = host.allocate('rain', 8, 'f64', 1);
      },
      importPorts() {},
      step({ tick }) {
        regionWords(rainHost.memory, rainRegion)[0] = tick >= rainStart && tick < rainEnd ? rainRate : 0;
      },
      exportPorts: (tick) => [{ field: rain.name, region: rainRegion, tick, cell: rainHost.cell }],
      stateRegions: () => [rainRegion],
      extraState: () => [],
    };
    const runoff = await RainfallRunoff.load({ rain: { field: rain } });
    const downstream = Int32Array.from({ length: nx * nz }, (_, i) => {
      const row = Math.floor(i / nx);
      return i === outlet ? -1 : row < middle ? i + nx : row > middle ? i - nx : i + 1;
    });
    const source = new ShallowWaterSolver('flood', {
      field: runoff.outletField,
      outlets: [{ sourceCell: outlet, position: [inletX, 0] }],
    });
    const world = new PhysicsWorld({ rate: { num: fps, den: 1 } })
      .add(bed, { columns, rows, width, depth, centre: [0, 0], elevations: elevation })
      .add(storm, {})
      .add(runoff, {
        nx,
        nz,
        dx: catchmentStep,
        origin: [inletX - nx * catchmentStep, (-nz * catchmentStep) / 2],
        downstream,
        conductivity: 0,
        drainage: 0,
        width: 1,
        slope: 0.12,
        roughness: 0.031,
      })
      .add(source, { bed: bed.bed, roughness: 0.028, sides: { maxX: 'open' } });

    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:420px;height:264px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      exactSize: [420, 264],
      camera: { position: [3.65, 4.8, 5.8], target: [-0.15, 0.25, 0], fov: 46, near: 0.35, far: 40 },
    });
    engine.scene.background = '#9faeb5';
    engine.lighting.direction.set([-0.6, 0.78, 0.35, 1.9]);
    engine.lighting.radiance.set([1, 0.92, 0.79, 0.16]);
    engine.lighting.ambient.set([0.48, 0.56, 0.63]);
    const surfaceMaterial = new PbrMaterial({ color: '#9d907a', roughness: 0.89 });
    const foundation = new PbrMaterial({ color: '#5f6360', roughness: 0.92 });
    const vertices = [];
    const normals = [];
    const indices = [];
    for (let j = 0; j <= rows; j++) {
      const z = origin[1] + j * step;
      for (let i = 0; i <= columns; i++) {
        const x = origin[0] + i * step;
        const sample = bed.bed.sample(x, z);
        vertices.push(x, sample.elevation, z);
        normals.push(...sample.normal);
        if (i < columns && j < rows) {
          const a = j * (columns + 1) + i;
          const b = a + columns + 1;
          indices.push(a, b, a + 1, a + 1, b, b + 1);
        }
      }
    }
    engine
      .createMesh()
      .setGeometry(new Geometry(new Float32Array(vertices), new Float32Array(normals), new Uint16Array(indices)))
      .setMaterial(surfaceMaterial);
    engine
      .createMesh()
      .setGeometry(box(width + 0.16, 0.26, depth + 0.16))
      .setMaterial(foundation)
      .setPosition([0, 0.03, 0]);
    // A wider neutral lab ground closes the photographic frame without changing the test bed.
    engine
      .createMesh()
      .setGeometry(box(26, 0.18, 26))
      .setMaterial(foundation)
      .setPosition([0, -0.23, 0]);

    const gpu = engine.gpu;
    const errors = [];
    engine.onError = (error) => errors.push(String(error));
    gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    gpu.pushErrorScope('validation');
    const terrain = gpu.createTexture({
      size: [columns, rows],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const heights = Float32Array.from(
      { length: columns * rows },
      (_, i) =>
        bed.bed.sample(origin[0] + ((i % columns) + 0.5) * step, origin[1] + (Math.floor(i / columns) + 0.5) * step)
          .elevation,
    );
    gpu.queue.writeTexture({ texture: terrain }, heights, { bytesPerRow: columns * 4 }, [columns, rows]);
    const water = Water.attach(engine, {
      height: -1,
      size: [width, depth],
      segments: 96,
      terrain: { heightmap: () => terrain, origin, size: [width, depth] },
      waves: [{ direction: [1, 0], amplitude: 0, wavelength: 3 }],
      color: [0.045, 0.15, 0.19],
      foamDistance: 0.09,
    });
    const mirror = ShallowWaterSurface.attach(engine, { surface: water, source });
    const draw = async () => {
      engine.render({ delta: 0 });
      await gpu.queue.onSubmittedWorkDone();
    };
    await waitForPipelines(draw);

    let checkpoint;
    window.runoffShot = {
      async frame(frame, action) {
        if (action === 'restore') world.restoreSnapshot(checkpoint.bytes);
        world.advance(frame);
        const accepted = world.takeSnapshot();
        if (action === 'save') checkpoint = accepted;
        await draw();
        const wave = await WaveQuery.capture(water);
        const budget = runoff.budget;
        let catchmentStorage = 0;
        for (let j = 0; j < nz; j++) {
          for (let i = 0; i < nx; i++) {
            const point = runoff.read(i, j);
            catchmentStorage += (point.depth + point.soilWater) * cellArea;
          }
        }
        const times = Math.max(0, Math.min(frame, rainEnd) - rainStart);
        const authoredRain = (times / fps) * rainRate * cellArea * nx * nz;
        const probe = (x) => {
          const physical = source.sample(x, 0);
          const drawn = wave.heightAt(x, 0);
          return {
            depth: physical.depth,
            surface: physical.surface,
            velocity: physical.velocity[0],
            drawn: drawn ?? null,
          };
        };
        return {
          hash: accepted.hash,
          rain: budget.rain,
          authoredRain,
          outflow: budget.outflow,
          volume: source.volume(),
          escaped: source.budget.out,
          received: source.budget.inflow,
          catchmentStorage,
          discharge: runoff.read(nx - 1, middle).outflow,
          inlet: probe(inletX),
          downstream: probe(downstreamX),
        };
      },
      async detach() {
        mirror.dispose();
        await draw();
        const fallback = await WaveQuery.capture(water);
        return fallback.heightAt(inletX, 0) === undefined && fallback.heightAt(downstreamX, 0) === undefined;
      },
      async dispose() {
        mirror.dispose();
        water.dispose();
        terrain.destroy();
        const validation = (await gpu.popErrorScope())?.message ?? null;
        engine.dispose();
        return { validation, errors };
      },
    };
  });

  const frame = (tick, action) => page.evaluate(([f, a]) => window.runoffShot.frame(f, a), [tick, action]);
  const dry = await frame(25);
  const dryPixels = await capture('dry');
  const onset = await frame(130, 'save');
  const onsetPixels = await capture('onset');
  const wet = await frame(600);
  const wetPixels = await capture('wet');
  const recession = await frame(3000);
  const recessionPixels = await capture('recession');
  const rewind = await frame(130, 'restore');
  const rewindPixels = await capture('rewind');
  const replay = await frame(600);
  const replayPixels = await capture('replay');
  assert.equal(await page.evaluate(() => window.runoffShot.detach()), true);
  const detachedPixels = await capture('detached');
  assert.deepEqual(await page.evaluate(() => window.runoffShot.dispose()), { validation: null, errors: [] });
  assert.deepEqual(pageErrors, []);

  const onsetChange = changedPixels(dryPixels, onsetPixels);
  const wetChange = changedPixels(dryPixels, wetPixels);
  const recessionChange = changedPixels(dryPixels, recessionPixels);
  assert.ok(onsetChange > 40 && wetChange > 2 * onsetChange);
  assert.ok(recessionChange < onsetChange && changedPixels(wetPixels, recessionPixels) > onsetChange);
  assert.deepEqual(rewindPixels.data, onsetPixels.data);
  assert.deepEqual(replayPixels.data, wetPixels.data);
  assert.deepEqual(detachedPixels.data, dryPixels.data);
  assert.deepEqual(rewind, onset);
  assert.deepEqual(replay, wet);

  assert.equal(dry.volume, 0);
  assert.equal(dry.inlet.drawn, null);
  assert.equal(dry.downstream.drawn, null);
  assert.equal(onset.downstream.drawn, null);
  assert.ok(onset.discharge > 0 && onset.discharge < wet.discharge);
  assert.ok(wet.downstream.depth > 0.025 && wet.downstream.velocity > 0);
  for (const probe of [onset.inlet, wet.inlet, wet.downstream]) {
    assert.ok(probe.drawn !== null && Math.abs(probe.drawn - probe.surface) <= 2e-6, JSON.stringify(probe));
  }
  assert.equal(recession.rain, wet.rain);
  assert.ok(recession.discharge < wet.discharge / 50);
  assert.ok(recession.escaped > wet.escaped && recession.volume < wet.volume / 10);
  assert.equal(recession.inlet.drawn, null);
  for (const ledger of [onset, wet, recession]) {
    // Each frame accumulates one rainfall contribution for each of the 30 catchment cells,
    // with the routed and finite-volume row reductions providing competing sums.
    const tolerance = 8 * 30 * 3000 * Number.EPSILON * ledger.authoredRain;
    const near = (value, target) => assert.ok(Math.abs(value - target) <= tolerance, JSON.stringify(ledger));
    near(ledger.rain, ledger.authoredRain);
    near(ledger.outflow, ledger.received);
    near(ledger.catchmentStorage + ledger.volume + ledger.escaped, ledger.authoredRain);
  }
  console.log(
    'HYDRO-02',
    backend,
    'runoff',
    wet.hash + ':',
    onsetChange,
    wetChange,
    recessionChange,
    'changed pixels from onset through recession,',
    wet.authoredRain,
    'm³ rain, exact rewind/replay and detach.',
  );
} finally {
  await close();
}
