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
      { Physics },
      { PhysicsWorld, RigidSolver },
      { LoadSolver },
      { Water },
      { Flood },
      { waitForPipelines },
    ] = await Promise.all([
      import('/packages/core/dist/index.js'),
      import('/packages/physics/dist/index.js'),
      import('/packages/physics/dist/world.js'),
      import('/packages/physics/dist/loads.js'),
      import('/packages/water/dist/index.js'),
      import('/packages/water/dist/flood.js'),
      import('/scripts/support/gpu-ready.js'),
    ]);
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:192px;height:128px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 8,
      camera: { position: [5, 6, 6], target: [0, 0.5, 0] },
    });
    const device = engine.gpu;
    const uncaptured = [];
    device.addEventListener('uncapturederror', (event) => uncaptured.push(event.error.message));
    await Physics.load();
    const cols = 12,
      rows = 10;
    const dt = 1 / 120;
    const mass = 48;
    const bodyRadius = 0.2;
    const density = 1000;
    const submergedDepth = 0.8;
    const area = 0.6,
      coefficient = 1.2;
    const depthMass = density * submergedDepth;
    const terrain = device.createTexture({
      size: [cols, rows],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: terrain }, new Float32Array(cols * rows), { bytesPerRow: cols * 4 }, [
      cols,
      rows,
    ]);
    const rejected = async (promise, expected) => {
      try {
        await promise;
      } catch (error) {
        if (expected(error)) return true;
        throw error;
      }
      return false;
    };
    const testScene = async ({ dry = false, disabled = false } = {}) => {
      const composed = !dry && !disabled;
      const gravity = [0, composed ? -9.81 : 0, 0];
      const water = Water.attach(engine, {
        height: -1,
        size: [cols, rows],
        terrain: { heightmap: () => terrain, origin: [-cols / 2, -rows / 2], size: [cols, rows] },
        fill: () => submergedDepth,
        waves: [{ direction: [1, 0], amplitude: 0, wavelength: 7 }],
        segments: 24,
      });
      const flood = Flood.attach(engine, { surface: water, roughness: 0, maxDepth: 1, maxSpeed: 4 });
      const fixed = new PhysicsWorld({ rate: { num: 120, den: 1 }, gravity });
      const physics = new Physics(null, { fixedTimestep: dt, arena: fixed.arena, gravity });
      const body = physics.addBody(null, {
        position: [0.25, dry ? 2 : 0.5, 0.25],
        linearVelocity: [1.3, 0, 0.4],
        canSleep: false,
        colliders: { shape: 'sphere', radius: bodyRadius, mass },
      });
      fixed.add(new RigidSolver(), { physics });
      if (composed) {
        fixed.add(new LoadSolver(), {
          level: 1,
          sea: {
            density,
            elevation: () => submergedDepth,
            water: { medium: 'water', cell: [0, 0, 0], sample: (_x, _y, _z, _time, out) => out },
          },
          bodies: [{ row: body.row, shape: { sphere: bodyRadius }, addedMass: [0, 0, 0], drag: 0, spinDrag: 0 }],
        });
      }
      const draw = async (delta = 0) => {
        engine.render({ delta });
        await device.queue.onSubmittedWorkDone();
      };
      await waitForPipelines(() => draw());
      await draw();
      const options = {
        world: fixed,
        physics,
        body,
        density,
        area,
        halfHeight: bodyRadius,
        dragCoefficient: disabled ? 0 : coefficient,
      };
      const refused = await rejected(
        Promise.resolve().then(() => flood.coupleRigidDrag({ ...options, model: 'pressure' })),
        (e) => e.code === 'unsupported',
      );
      body.enabledTranslations = [false, true, true];
      const refusedLockedBody = await rejected(
        Promise.resolve().then(() => flood.coupleRigidDrag(options)),
        (e) => e.code === 'state' && e.message.includes('free to move along X and Z'),
      );
      body.enabledTranslations = [true, true, true];
      const session = flood.coupleRigidDrag(options);
      const initialHash = fixed.hash();
      const initial = body.linearVelocity;
      const initialRead = flood.read();
      const start = session.step();
      const stagedTick = flood.ticks;
      const busy = await rejected(session.step(), (e) => e.code === 'state');
      const first = await start;
      const previousTick = (await initialRead).ticks;
      const firstVelocity = body.linearVelocity;
      const read = await flood.read();
      const cell = cols / 2 + cols * (rows / 2);
      const waterFirst = [
        read.velocity[cell * 2] * read.depth[cell] * density,
        read.velocity[cell * 2 + 1] * read.depth[cell] * density,
      ];
      await draw(0.1);
      const renderOnlyTick = (await flood.read()).ticks;
      let advanced, replay;
      if (composed) {
        const count = 24;
        for (let i = 1; i < count; i++) await session.step();
        const receipt = await flood.read();
        advanced = {
          hash: fixed.hash(),
          speed: body.linearVelocity,
          depth: Array.from(receipt.depth),
          current: Array.from(receipt.velocity),
          ticks: flood.ticks,
        };
        const worker = new AbortController();
        const inFlight = session.step({ signal: worker.signal });
        worker.abort();
        const aborted = await rejected(inFlight, (e) => e.name === 'AbortError');
        const retainedTick = session.tick;
        const unreadable = await rejected(flood.read(), (e) => e.code === 'state');
        const waiting = await rejected(session.step(), (e) => e.code === 'state');
        const rigidUnchanged = fixed.hash() === advanced.hash;
        await session.seek(count);
        await draw(0.2);
        const after = await flood.read();
        replay = {
          hash: fixed.hash(),
          speed: body.linearVelocity,
          depth: Array.from(after.depth),
          current: Array.from(after.velocity),
          ticks: flood.ticks,
        };
        await session.seek(0);
        replay.reset = {
          clocks: [flood.ticks, fixed.clock.frame, physics.stepCount],
          hash: fixed.hash(),
          velocity: body.linearVelocity,
        };
        replay.first = await session.step();
        replay.firstVelocity = body.linearVelocity;
        Object.assign(advanced, { aborted, retainedTick, unreadable, waiting, rigidUnchanged });
      }
      flood.dispose();
      water.dispose();
      physics[Symbol.dispose]();
      return {
        first,
        firstVelocity,
        initialHash,
        initial,
        waterFirst,
        refused,
        refusedLockedBody,
        busy,
        renderOnlyTick,
        stagedTick,
        previousTick,
        advanced,
        replay,
      };
    };
    const wet = await testScene();
    const dry = await testScene({ dry: true });
    const disabled = await testScene({ disabled: true });
    terrain.destroy();
    engine.dispose();
    return { wet, dry, disabled, mass, bodyRadius, density, dt, area, coefficient, depthMass, uncaptured };
  });

  const { wet, dry, disabled, mass, bodyRadius, density, dt, area, coefficient, depthMass, uncaptured } = result;
  const speed = Math.hypot(wet.initial[0], wet.initial[2]);
  const reduced = 1 / (1 / mass + 1 / depthMass);
  const rate = (dt * 0.5 * density * area * coefficient) / reduced;
  const nextSlip = (2 * speed) / (1 + Math.sqrt(1 + 4 * rate * speed));
  const expectedMagnitude = reduced * (speed - nextSlip);
  assert.ok(Math.abs(Math.hypot(...wet.first.waterImpulse) - expectedMagnitude) < 1e-5);
  const displacedMass = density * ((4 * Math.PI * bodyRadius ** 3) / 3);
  const expectedHeave = 9.81 * dt * (displacedMass / mass - 1);
  assert.ok(Math.abs(wet.firstVelocity[1] - expectedHeave) < 1e-7, 'the same tick applies live buoyancy and gravity');
  for (const [i, axis] of [0, 2].entries()) {
    assert.equal(wet.first.waterImpulse[i], -wet.first.bodyImpulse[i]);
    assert.ok(Math.abs(wet.waterFirst[i] - wet.first.waterImpulse[i]) < 2e-6);
    assert.ok(Math.abs(mass * (wet.firstVelocity[axis] - wet.initial[axis]) - wet.first.bodyImpulse[i]) < 1e-5);
  }
  for (const caseOf of [wet, dry, disabled]) {
    assert.equal(caseOf.first.tick, 1);
    assert.equal(caseOf.stagedTick, 0);
    assert.equal(caseOf.previousTick, 0);
    assert.equal(caseOf.renderOnlyTick, 1);
    assert.ok(caseOf.busy && caseOf.refused && caseOf.refusedLockedBody);
  }
  for (const control of [dry, disabled]) {
    assert.deepEqual(control.first.bodyImpulse, [0, 0]);
    assert.deepEqual(control.first.waterImpulse, [0, 0]);
    assert.deepEqual(control.firstVelocity, control.initial);
  }
  const { aborted, retainedTick, unreadable, waiting, rigidUnchanged, ...accepted } = wet.advanced;
  assert.ok(aborted && unreadable && waiting && rigidUnchanged);
  assert.equal(retainedTick, 24);
  const { reset, first: repeatedFirst, firstVelocity: repeatedVelocity, ...restored } = wet.replay;
  assert.deepEqual(restored, accepted);
  assert.deepEqual(reset, { clocks: [0, 0, 0], hash: wet.initialHash, velocity: wet.initial });
  assert.deepEqual(repeatedFirst, wet.first);
  assert.deepEqual(repeatedVelocity, wet.firstVelocity);
  assert.deepEqual(uncaptured, []);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      backend: hardware.compat ? 'webgl2' : 'webgpu',
      initial: wet.initial,
      first: wet.first,
      firstVelocity: wet.firstVelocity,
      terminal: accepted.speed,
      hash: accepted.hash,
    }),
  );
} finally {
  await closeAll({ browser });
}
