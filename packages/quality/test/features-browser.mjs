// Real-GPU check of watchFeatures, built packages. Takes the GPU lock itself around the browser.
// node packages/quality/test/features-browser.mjs
// The fake knobs in features.test.js cannot show that a real effect takes a change while running. This drives Shadows
// and SSAO through every level with a budget no GPU meets, and reads what changed on the GPU: pictures, and validation.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';

const release = await acquire({ owner: 'quality-features' });
setTimeout(() => {
  console.error('features-browser: stopped at its time limit');
  process.exit(124);
}, 120_000).unref();
const context = await openBrowser({ startPath: '/packages/quality/test/ssaa-browser.html', port: 5213 }),
  { page } = context,
  problems = [];
page.on('pageerror', (error) => problems.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(message.text());
});
try {
  const result = await page.evaluate(async () => {
    globalThis.margoLow = 1;
    const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
      { Shadows } = await import('/packages/shadows/dist/index.js'),
      { SSAO } = await import('/packages/post/dist/ssao.js'),
      { FeatureScaler, featureKnobs, watchFeatures } = await import('/packages/quality/dist/features.js'),
      { supersample } = await import('/packages/quality/dist/ssaa.js'),
      canvas = document.querySelector('canvas'),
      engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 6, 12], target: [0, 0, 0] } });
    engine.stop();
    const errors = [];
    engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    const material = new PbrMaterial({ color: '#c0c0b8' });
    const shadows = Shadows.attach(engine, { distance: 60 }),
      ssao = SSAO.attach(engine);
    shadows.add(engine.createMesh().setGeometry(box(30, 0.2, 30)).setPosition([0, -1, 0]).setMaterial(material));
    for (let x = -3; x <= 3; x++)
      shadows.add(
        engine
          .createMesh()
          .setGeometry(box(0.6, 3, 0.6))
          .setPosition([x * 2, 0.5, (x % 3) * 2])
          .setMaterial(material),
      );
    const
      camera = engine.camera,
      far = camera.far,
      knobs = featureKnobs({ ssao, shadows, camera }),
      shot = async () => (await supersample(engine, { samples: 1 })).data,
      differ = (a, b) => a.reduce((sum, value, i) => sum + (value !== b[i]), 0),
      first = await shot(),
      steps = {};
    // Every level of every knob on a live engine, one at a time and back, so a level that breaks a pipeline shows.
    for (const knob of knobs) {
      steps[knob.name] = [];
      for (let level = 1; level < knob.levels; level++) {
        knob.apply(level);
        steps[knob.name].push(differ(first, await shot()));
      }
      knob.apply(0);
    }
    const back = differ(first, await shot());
    // The real loop: submit-to-done timing, an impossible budget, then a generous one.
    const changes = [],
      watch = watchFeatures(knobs, {
        budget: 0.001,
        window: 4,
        settle: 1,
        minSaving: 0,
        onChange: (change) => changes.push(change),
      }),
      frames = async (count) => {
        for (let i = 0; i < count; i++) {
          engine.render();
          await engine.gpu.queue.onSubmittedWorkDone();
        }
      };
    await frames(120);
    const low = { ...watch.scaler.levels },
      costs = watch.scaler.costs;
    watch.scaler.budget = 1000;
    await frames(400);
    const raised = { ...watch.scaler.levels };
    watch.dispose();
    await frames(3);
    const after = [ssao.enabled, ssao.options.samples, shadows.options.filter, shadows.options.distance, camera.far === far];
    await engine.gpu.queue.onSubmittedWorkDone();
    return {
      names: knobs.map((knob) => knob.name),
      steps,
      back,
      changes: changes.length,
      low,
      raised,
      costs,
      after,
      errors,
      scaler: typeof FeatureScaler,
    };
  });
  console.log(JSON.stringify(result));
  assert.deepEqual(result.names, ['ssao', 'shadow filter', 'shadow distance', 'view distance']);
  assert.equal(result.back, 0, 'every feature back at level 0 gives the same picture');
  assert.ok(result.steps.ssao.at(-1) > 0, 'switching SSAO off shows');
  assert.ok(result.steps['shadow filter'].at(-1) > 0, 'a shadow filter change takes effect while running');
  assert.ok(result.steps['shadow distance'].at(-1) >= 0);
  assert.ok(result.changes >= 4);
  assert.ok(
    Object.values(result.low).every((level) => level > 0),
    `everything went down under an impossible budget: ${JSON.stringify(result.low)}`,
  );
  assert.ok(
    Object.values(result.raised).every((level) => level === 0),
    `everything came back under a generous one: ${JSON.stringify(result.raised)}`,
  );
  assert.deepEqual(result.after, [true, 32, 'soft', 60, true]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(problems, []);
  console.log('features browser check passed');
} finally {
  await context.close();
  await release();
}
