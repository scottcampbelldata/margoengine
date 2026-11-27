import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' });
const { page, hardware } = browser;
const backend = hardware.compat ? 'webgl2' : 'webgpu';
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const output = process.env.MARGO_KEEP_SHALLOW_FRAMES === '1' ? 'test-results' : undefined;
if (output) await mkdir(output, { recursive: true });
const capture = async (id) => {
  const png = await page
    .locator('canvas')
    .screenshot(output ? { path: output + '/shallow-surface-' + backend + '-' + id + '.png' } : {});
  return decodePNG(png);
};

function differences(a, b) {
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let difference = 0;
    for (let channel = 0; channel < 3; channel++) difference += Math.abs(a.data[i + channel] - b.data[i + channel]);
    if (difference >= 12) changed++;
  }
  return changed;
}

try {
  await page.evaluate(async () => {
    const [
      { EngineKernel, PbrMaterial, box },
      { Physics },
      { PhysicsWorld, RigidSolver, regionWords },
      { bedSurface },
      { ShallowWaterSolver },
      { Water },
      { ShallowWaterSurface },
      { WaveQuery },
      { waitForPipelines },
    ] = await Promise.all([
      import('/packages/core/dist/index.js'),
      import('/packages/physics/dist/index.js'),
      import('/packages/physics/dist/world.js'),
      import('/packages/physics/dist/earth.js'),
      import('/packages/physics/dist/hydro.js'),
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
      capacity: 18,
      camera: { position: [6.2, 4.5, 8.1], target: [-0.6, 0.36, 0], fov: 44, near: 0.1, far: 60 },
    });
    const device = engine.gpu;
    device.pushErrorScope('validation');
    const uncaptured = [];
    device.addEventListener('uncapturederror', (event) => uncaptured.push(event.error.message));
    engine.scene.background = '#a4b3bc';
    engine.lighting.direction.set([-0.48, 0.76, 0.51, 2.0]);
    engine.lighting.radiance.set([1, 0.9, 0.77, 0.24]);
    engine.lighting.ambient.set([0.5, 0.59, 0.68]);
    const concrete = new PbrMaterial({ color: '#898679', roughness: 0.92 });
    const bottom = new PbrMaterial({ color: '#65675b', roughness: 0.91 });
    const rust = new PbrMaterial({ color: '#a74d32', roughness: 0.82 });
    const dark = new PbrMaterial({ color: '#394445', roughness: 0.84 });
    const cap = new PbrMaterial({ color: '#d8b981', roughness: 0.76 });
    const solid = (size, material, position) =>
      engine
        .createMesh()
        .setGeometry(box(...size))
        .setMaterial(material)
        .setPosition(position);
    solid([12, 0.14, 8], bottom, [0, -0.07, 0]);
    for (const edge of [-1, 1]) {
      solid([12.55, 1.1, 0.33], concrete, [0, 0.36, edge * 4.165]);
      solid([0.33, 1.1, 8], concrete, [edge * 6.165, 0.36, 0]);
    }
    const subject = solid([1.35, 1.72, 0.95], rust, [0, 0, 0]);
    solid([1.42, 0.085, 1.01], cap, [0, 0.87, 0]).setParent(subject);
    for (const x of [-0.45, 0.45]) solid([0.095, 0.062, 0.94], dark, [x, 0.94, 0]).setParent(subject);

    const grid = { columns: 8, rows: 8, width: 12, depth: 8, centre: [0, 0] };
    const innerDepth = 0.72;
    const dt = 1 / 60;
    const firstX = -2.5;
    const firstZ = -0.15;
    const speed = 1.7;
    const mass = 820;
    const stop = 60;
    const gravity = [0, -9.81, 0];
    const bed = bedSurface(grid, new Float64Array((grid.columns + 1) * (grid.rows + 1)));
    const waterParams = {
      bed,
      depth: innerDepth,
      density: 1000,
      roughness: 0,
      sides: { minX: 'periodic', maxX: 'periodic', minZ: 'periodic', maxZ: 'periodic' },
    };
    await Physics.load();
    const makeWorld = () => {
      const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity });
      const physics = new Physics(null, { fixedTimestep: dt, arena: world.arena, gravity });
      const body = physics.addBody(null, {
        position: [firstX, 0.68, firstZ],
        linearVelocity: [speed, 0, 0],
        enabledTranslations: [true, false, true],
        lockRotations: true,
        canSleep: false,
        colliders: { shape: 'box', halfExtents: [0.675, 0.86, 0.475], mass },
      });
      world.add(new RigidSolver(), { physics });
      return { world, physics, body };
    };
    const control = makeWorld();
    const plain = new ShallowWaterSolver();
    control.world.add(plain, waterParams).couple(['water', 'rigid'], 'staggered');
    control.world.advance(stop);
    const expected = { velocity: control.body.linearVelocity[0], height: plain.sample(0, 0).surface };
    control.physics[Symbol.dispose]();

    const scene = makeWorld();
    const coupling = await ShallowWaterSolver.withRigidFootprint({
      bodyRow: scene.body.row,
      centre: [firstX, firstZ],
      footprint: [
        [-0.675, -0.475],
        [0.675, -0.475],
        [0.675, 0.475],
        [-0.675, 0.475],
      ],
    });
    const source = coupling.water;
    scene.world
      .add(coupling.predictor, {})
      .add(source, waterParams)
      .add(coupling.reaction, {})
      .couple(coupling.order, 'staggered');

    const terrain = device.createTexture({
      size: [grid.columns, grid.rows],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: terrain },
      new Float32Array(grid.columns * grid.rows),
      { bytesPerRow: grid.columns * 4 },
      [grid.columns, grid.rows],
    );
    const water = Water.attach(engine, {
      height: -1,
      size: [grid.width, grid.depth],
      terrain: { heightmap: () => terrain, origin: [-grid.width / 2, -grid.depth / 2], size: [grid.width, grid.depth] },
      segments: 96,
      waves: [{ direction: [1, 0], amplitude: 0, wavelength: 9 }],
    });
    const mirror = ShallowWaterSurface.attach(engine, { surface: water, source });
    const draw = async (position = scene.body.position) => {
      subject.setPosition(position);
      engine.render({ delta: 0 });
      await device.queue.onSubmittedWorkDone();
    };

    const entryVelocity = scene.body.linearVelocity[0];
    scene.world.advance(1);
    const start = scene.world.takeSnapshot();
    const atStart = scene.body.position;
    const initialVolume = source.volume();
    const reaction = source.exportPorts(1)[1];
    const receipts = regionWords(scene.world.memory, reaction.region);
    const firstImpulse = receipts[2];
    const impulseError = Math.abs(mass * (scene.body.linearVelocity[0] - entryVelocity) - firstImpulse);
    await waitForPipelines(() => draw(atStart));
    await draw(atStart);

    window.shallowSurface = {
      async run() {
        for (let tick = 2; tick <= stop; tick++) scene.world.advance(tick);
        const position = scene.body.position;
        const velocity = scene.body.linearVelocity[0];
        const hash = scene.world.hash();
        const volumeError = Math.abs(source.volume() - initialVolume);
        await draw(position);
        const rendered = await WaveQuery.capture(water);
        let largestSignal = 0;
        let largestDrawResidual = 0;
        for (let j = 2; j < grid.rows - 2; j++) {
          for (let i = 2; i < grid.columns - 2; i++) {
            const x = ((i + 0.5) / grid.columns - 0.5) * grid.width;
            const z = ((j + 0.5) / grid.rows - 0.5) * grid.depth;
            const target = source.sample(x, z).surface;
            const height = rendered.heightAt(x, z);
            if (!Number.isFinite(height)) throw new Error('Wet interior point not drawn at ' + x + ',' + z);
            largestSignal = Math.max(largestSignal, Math.abs(target - expected.height));
            largestDrawResidual = Math.max(largestDrawResidual, Math.abs(height - target));
          }
        }
        scene.world.restoreSnapshot(start.bytes);
        await draw(position); // Freeze only the visual subject at the terminal pose, preserving the early water state.
        const compareEarly = await WaveQuery.capture(water);
        const earlyHeight = compareEarly.heightAt(grid.width / (2 * grid.columns), grid.depth / (2 * grid.rows));
        const earlyExpected = source.sample(grid.width / (2 * grid.columns), grid.depth / (2 * grid.rows)).surface;
        for (let tick = 2; tick <= stop; tick++) scene.world.advance(tick);
        const replay = scene.world.hash();
        this.terminal = position;
        return {
          hash,
          replay,
          position,
          velocity,
          expected,
          firstImpulse,
          impulseError,
          largestSignal,
          largestDrawResidual,
          earlyError: Math.abs(earlyHeight - earlyExpected),
          volumeError,
          atStart,
        };
      },
      async redraw() {
        await draw(this.terminal);
      },
      async dispose() {
        mirror.dispose();
        await draw();
        const fallback = await WaveQuery.capture(water);
        const detachedDry = fallback.heightAt(0.75, 0.5) === undefined;
        water.dispose();
        terrain.destroy();
        scene.physics[Symbol.dispose]();
        const error = (await device.popErrorScope())?.message ?? null;
        engine.dispose();
        return { error, uncaptured, detachedDry };
      },
    };
  });

  const before = await capture('before');
  const result = await page.evaluate(() => window.shallowSurface.run());
  const sameBodyEarlierWater = await capture('same-body-earlier-water');
  await page.evaluate(() => window.shallowSurface.redraw());
  const after = await capture('after');
  const movedPixels = differences(before, after);
  const waterPixels = differences(sameBodyEarlierWater, after);
  console.log(JSON.stringify({ backend, ...result, movedPixels, waterPixels }));
  assert.ok(result.position[0] - result.atStart[0] > 0.35, 'the guided compact body travels through the tank');
  assert.ok(
    result.firstImpulse < -0.1 && result.velocity < result.expected.velocity - 0.02,
    'water pressure retards the body',
  );
  assert.ok(
    result.impulseError < 2 * 2 ** -23 * 820 * 1.7,
    'the public cut-cell pressure receipt accounts for the body impulse',
  );
  assert.ok(result.volumeError < 1e-10, 'the moving pressure boundary preserves volume');
  assert.ok(result.largestSignal > 0.01, 'the body in turn moves the free surface');
  assert.ok(result.largestDrawResidual < 2e-6 && result.earlyError < 2e-6, 'the renderer samples the same Hydro state');
  assert.equal(result.replay, result.hash);
  assert.ok(movedPixels > 250 && waterPixels > 45, 'the body and responding water are separately visible');
  assert.deepEqual(await page.evaluate(() => window.shallowSurface.dispose()), {
    error: null,
    uncaptured: [],
    detachedDry: true,
  });
  assert.deepEqual(errors, []);
} finally {
  await closeAll({ browser });
}
