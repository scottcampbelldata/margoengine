import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' });
const { page, hardware } = browser;
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

try {
  const receipt = await page.evaluate(async () => {
    const { EngineKernel } = await import('/packages/core/dist/index.js');
    const { Physics } = await import('/packages/physics/dist/index.js');
    const { VFX } = await import('/packages/vfx/dist/index.js');
    const { Water } = await import('/packages/water/dist/index.js');
    const { WaterWake } = await import('/packages/water/dist/wake.js');
    const { ShotSplash, SPLASH_EMITTERS } = await import('/packages/water/dist/splash.js');
    const { makeEntryLaunch } = await import('/packages/physics/tests/coupling/entry-launch.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:320px;height:240px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 12,
      camera: { position: [1.7, 0.95, 2.8], target: [-0.25, 0.26, 0], near: 0.05, far: 40 },
    });
    engine.gpu.pushErrorScope('validation');
    await Physics.load();
    const { world, physics, vessel, sea, wake, entry } = makeEntryLaunch({ pressure: true });
    const water = Water.attach(engine, { size: [5, 5], segments: 32, sea });
    const drawnWake = WaterWake.attach(engine, { surface: water, wake });
    const emitters = [];
    const splash = ShotSplash.attach(engine, {
      slots: 2,
      water: sea,
      splashes: entry,
      particles(kind) {
        const emitter = VFX.attach(engine, { ...SPLASH_EMITTERS[kind] });
        emitters.push(emitter);
        return emitter;
      },
    });
    let cavityOpen = false;
    for (let frame = 1; frame <= 14; frame++) {
      world.advance(frame);
      cavityOpen ||= entry.bodyState(vessel.row).cavity;
      engine.render({ delta: 1 / 60 });
    }
    await engine.gpu.queue.onSubmittedWorkDone();
    const observed = entry.splashes().find((event) => event.kind === 'entry');
    const drawn = splash.active().find((item) => item.event.kind === 'entry');
    window.entryLaunch = { engine, physics, water, splash, emitters, drawnWake };
    return {
      observed,
      drawn: drawn?.event,
      cavityOpen,
      wakeSources: entry.seaSources(),
      hash: world.hash(),
    };
  });
  assert.ok(receipt.observed?.cavity && receipt.observed.crownHeight > 0);
  assert.ok(receipt.cavityOpen);
  assert.equal(receipt.drawn?.crownHeight, receipt.observed.crownHeight);
  assert.equal(receipt.drawn?.time, receipt.observed.time);
  assert.deepEqual(receipt.wakeSources, []);
  const spray = await page.locator('canvas').screenshot();

  const validation = await page.evaluate(async () => {
    const { engine, splash, emitters } = window.entryLaunch;
    splash.dispose();
    for (const emitter of emitters) emitter.dispose();
    engine.render({ delta: 0 });
    await engine.gpu.queue.onSubmittedWorkDone();
    const error = await engine.gpu.popErrorScope();
    return error?.message ?? null;
  });
  assert.equal(validation, null);
  assert.deepEqual(errors, []);
  const surface = await page.locator('canvas').screenshot();
  const [withSpray, withoutSpray] = await Promise.all([decodePNG(spray), decodePNG(surface)]);
  let brighter = 0;
  for (let i = 0; i < withSpray.data.length; i += 4) {
    const difference =
      withSpray.data[i] +
      withSpray.data[i + 1] +
      withSpray.data[i + 2] -
      withoutSpray.data[i] -
      withoutSpray.data[i + 1] -
      withoutSpray.data[i + 2];
    if (difference > 12) brighter++;
  }
  assert.ok(brighter > 3, 'the live entry visibly draws spray over the same water');
  console.log(JSON.stringify({ backend: hardware.compat ? 'WebGL2' : 'WebGPU', hash: receipt.hash, brighter }));
  await page.evaluate(() => {
    const { drawnWake, water, physics, engine } = window.entryLaunch;
    drawnWake.dispose();
    water.dispose();
    physics[Symbol.dispose]();
    engine.dispose();
  });
} finally {
  await closeAll({ browser });
}
