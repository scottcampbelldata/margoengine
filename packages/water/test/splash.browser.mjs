// Shot splashes on the GPU (WebGPU, and the WebGL2 layer with MARGO_COMPAT=1):
// - foam: a ShotSplash on a flat Water seen from above whitens the water round a shot's entry, and nothing far away;
// - spray: real VFX emitters made from SPLASH_EMITTERS, driven by a ShotSplash, draw white spray above the water seen
//   side on once the shot lands, and none before it;
// - waves: the same splash on a water whose surface stands 8 m higher (a WaveQuery-shaped height source) draws its
//   spray that much higher on screen: the splash rises from the wave, not the impact's height at rest.
// The laws (heights, seal, skips, rings) are held on the CPU in splash.test.js; this checks the drawn picture.
//   node scripts/run-with-timeout.mjs --max 10 -- node packages/water/test/splash.browser.mjs
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
await mkdir('test-results', { recursive: true });
const WIDTH = 320,
  HEIGHT = 240;
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' }),
  { page, hardware } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
const shot = () => page.locator('canvas').screenshot();
const draw = (code, arg) => page.evaluate(code, arg).then(shot);
try {
  // A flat sea seen from above, with a shot falling straight in at the centre at 0.1 s.
  await page.evaluate(
    async ({ WIDTH, HEIGHT }) => {
      const { EngineKernel } = await import('/packages/core/dist/index.js');
      const { Water } = await import('/packages/water/dist/index.js');
      const { ShotSplash } = await import('/packages/water/dist/splash.js');
      const canvas = document.createElement('canvas');
      canvas.style.cssText = `width:${WIDTH}px;height:${HEIGHT}px`;
      document.body.replaceChildren(canvas);
      const engine = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 8,
        camera: { position: [0, 90, 0.01], target: [0, 0, 0], near: 0.1, far: 2000 },
      });
      engine.gpu.pushErrorScope('validation');
      const sea = Water.attach(engine, { size: [200, 200], segments: 64, wind: { speed: 4, direction: [1, 0] }, waves: [{ direction: [1, 0], amplitude: 0, wavelength: 10 }] });
      const stub = () => ({ options: {}, burst() {} });
      const splash = ShotSplash.attach(engine, {
        surface: sea,
        particles: stub,
        source: [{ time: 0.1, position: [0, 0, 0], velocity: [0, -200, 0], radius: 0.0783, density: 7200 }],
        look: { foamWidth: 2 },
      });
      for (let f = 0; f < 30; f++) engine.render({ delta: 1 / 30 });
      await engine.gpu.queue.onSubmittedWorkDone();
      window.splashTest = { engine, sea, splash };
    },
    { WIDTH, HEIGHT },
  );
  const foamLook = (values) =>
    draw(async (values) => {
      const { engine, splash } = window.splashTest;
      splash.setLook(values);
      engine.render({ delta: 0 });
      await engine.gpu.queue.onSubmittedWorkDone();
    }, values);
  const foamOn = await foamLook({ foamWidth: 2 });
  const ring = await page.evaluate(() => window.splashTest.splash.rings()[0]);
  const foamOff = await foamLook({ foamWidth: 0 });

  // Side on: a second ShotSplash with real VFX emitters (no foam), a shot landing at 0.2 s on its clock.
  const spray = await page.evaluate(async (lift) => {
    const { engine, splash } = window.splashTest;
    splash?.dispose();
    window.splashTest.splash = undefined;
    const { VFX } = await import('/packages/vfx/dist/index.js');
    const { ShotSplash, SPLASH_EMITTERS } = await import('/packages/water/dist/splash.js');
    engine.camera.position = [0, 6, 70];
    engine.camera.target = [0, 6, 0];
    const emitters = [];
    const s = ShotSplash.attach(engine, {
      slots: 1,
      particles: (kind) => {
        const e = VFX.attach(engine, { ...SPLASH_EMITTERS[kind] });
        emitters.push(e);
        return e;
      },
      source: [{ time: 0.2, position: [0, 0, 0], velocity: [60, -180, 0], radius: 0.0783, density: 7200 }],
      ...(lift ? { water: { sample: () => ({ height: lift, velocity: [0, 0, 0] }) } } : {}),
    });
    window.splashTest.spray = s;
    window.splashTest.emitters = emitters;
    return { slots: s.slots.length, emitters: emitters.length };
  }, 0);
  const sprayFrames = async (n) =>
    draw(async (n) => {
      const { engine } = window.splashTest;
      for (let f = 0; f < n; f++) engine.render({ delta: 1 / 30 });
      await engine.gpu.queue.onSubmittedWorkDone();
    }, n);
  const before = await sprayFrames(3);
  const after = await sprayFrames(27);
  const active = await page.evaluate(() => window.splashTest.spray.active().map((a) => ({ kind: a.event.kind, crownHeight: a.event.crownHeight })));
  // The same splash on a surface 8 m up.
  const clear = () =>
    page.evaluate(() => {
      const t = window.splashTest;
      t.spray.dispose();
      for (const e of t.emitters) e.dispose();
    });
  await clear();
  await page.evaluate(async (lift) => {
    const { engine } = window.splashTest;
    const { VFX } = await import('/packages/vfx/dist/index.js');
    const { ShotSplash, SPLASH_EMITTERS } = await import('/packages/water/dist/splash.js');
    const emitters = [];
    window.splashTest.spray = ShotSplash.attach(engine, {
      slots: 1,
      particles: (kind) => {
        const e = VFX.attach(engine, { ...SPLASH_EMITTERS[kind] });
        emitters.push(e);
        return e;
      },
      source: [{ time: 0.2, position: [0, 0, 0], velocity: [60, -180, 0], radius: 0.0783, density: 7200 }],
      water: { sample: () => ({ height: lift, velocity: [0, 0, 0] }) },
    });
    window.splashTest.emitters = emitters;
  }, 8);
  const liftedBefore = await sprayFrames(3);
  const lifted = await sprayFrames(27);
  const validation = await page.evaluate(async () => {
    const { engine, sea, spray, emitters } = window.splashTest;
    spray.dispose();
    for (const e of emitters) e.dispose();
    sea.dispose();
    const error = await engine.gpu.popErrorScope();
    return error?.message ?? null;
  });

  const [F1, F0, S0, S1, L0, L1] = await Promise.all([foamOn, foamOff, before, after, liftedBefore, lifted].map((b) => decodePNG(b)));
  const px = (img, x, y) => [img.data[(y * img.width + x) * 4], img.data[(y * img.width + x) * 4 + 1], img.data[(y * img.width + x) * 4 + 2]];
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const cx = F1.width >> 1,
    cy = F1.height >> 1;
  const added = (x, y) => lum(px(F1, x, y)) - lum(px(F0, x, y));
  let centre = 0,
    far = 0;
  for (let y = cy - 4; y <= cy + 4; y++) for (let x = cx - 4; x <= cx + 4; x++) centre = Math.max(centre, added(x, y));
  for (let y = 0; y < F1.height; y++)
    for (let x = 0; x < F1.width; x++) if (Math.hypot(x - cx, y - cy) > 0.4 * F1.height) far = Math.max(far, Math.abs(added(x, y)));
  // Spray: pixels above the horizon (the upper half, the sea below it) brighter than before the shot landed.
  let sprayed = 0;
  for (let y = 0; y < S1.height >> 1; y++) for (let x = 0; x < S1.width; x++) if (lum(px(S1, x, y)) > lum(px(S0, x, y)) + 20) sprayed++;
  // Waves: the spray's mean screen row with and without the lift (whole picture, against each run's frame before).
  const meanRow = (A, B) => {
    let n = 0,
      sum = 0;
    for (let y = 0; y < A.height; y++)
      for (let x = 0; x < A.width; x++)
        if (lum(px(A, x, y)) > lum(px(B, x, y)) + 20) {
          n++;
          sum += y;
        }
    return { n, row: sum / Math.max(1, n) };
  };
  const flat = meanRow(S1, S0),
    raised = meanRow(L1, L0);
  const report = { hardware, foam: { centre, far, ring }, spray: { ...spray, sprayed, active }, waves: { flat, raised } };
  console.log(JSON.stringify(report));
  assert.ok(ring && ring[2] > 1, `a foam ring is out: ${JSON.stringify(ring)}`);
  assert.ok(centre > 20, `the shot's foam whitens the water at the entry (${centre})`);
  assert.ok(far < 3, `and nothing far away (${far})`);
  assert.equal(spray.emitters, 3);
  assert.ok(active.length === 1 && active[0].kind === 'entry', `the entry splash is live: ${JSON.stringify(active)}`);
  assert.ok(sprayed >= 40, `the splash draws spray above the water (${sprayed} pixels)`);
  // 8 m at 70 m with the default 60 degree view is about 24 rows of a 240-row picture.
  assert.ok(raised.n >= 40 && flat.row - raised.row >= 12, `the spray rises from a raised surface: ${JSON.stringify({ flat, raised })}`);
  assert.equal(validation, null);
  assert.deepEqual(errors, []);
  await writeFile(`test-results/water-splash-${hardware?.compat ? 'compat' : 'webgpu'}.json`, JSON.stringify(report, null, 2));
  console.log(`water splash browser check passed (${hardware.webgpu?.vendor ?? 'compat'})`);
} finally {
  await page.evaluate(() => window.splashTest?.engine.dispose());
  await closeAll({ browser });
}
