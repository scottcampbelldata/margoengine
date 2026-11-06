// Real-browser check of watchPower, built packages. Takes the GPU lock itself around the browser.
// node packages/quality/test/power-browser.mjs
// The fakes in power.test.js cannot show that the wrappers keep the native receivers: this runs the real battery
// manager, the real PressureObserver where the browser has one, the real queue and a real engine's pace.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';

const release = await acquire({ owner: 'quality-power' });
setTimeout(() => {
  console.error('power-browser: stopped at its time limit');
  process.exit(124);
}, 120_000).unref();
const context = await openBrowser({ startPath: '/packages/quality/test/ssaa-browser.html', port: 5214 }),
  { page } = context,
  problems = [];
page.on('pageerror', (error) => problems.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(message.text());
});
try {
  const result = await page.evaluate(async () => {
    globalThis.margoLow = 1;
    const { Engine } = await import('/packages/core/dist/index.js'),
      { applyQualityTier, capFrameRate } = await import('/packages/quality/dist/index.js'),
      { watchPower } = await import('/packages/quality/dist/power.js');
    applyQualityTier({ search: '', storage: undefined });
    const engine = await Engine.create(document.querySelector('canvas'), { backend: 'webgpu' });
    engine.stop();
    capFrameRate(engine, 60);
    const errors = [];
    engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    const pace = engine.pace,
      submit = GPUQueue.prototype.submit,
      features = { budget: 12 },
      hasBattery = typeof navigator.getBattery === 'function',
      manager = hasBattery ? await navigator.getBattery() : undefined;
    let told;
    const first = new Promise((resolve) => {
        told = resolve;
      }),
      watch = watchPower({ engine, features, onChange: (reading) => told(reading) }),
      wrapped = GPUQueue.prototype.submit !== submit;
    engine.render();
    await engine.gpu.queue.onSubmittedWorkDone();
    const reading = hasBattery ? await first : watch.reading;
    watch.dispose();
    await engine.gpu.queue.onSubmittedWorkDone();
    return {
      hasBattery,
      pressure: typeof globalThis.PressureObserver,
      charging: reading.charging,
      battery: reading.battery,
      real: manager && [manager.charging, manager.level],
      level: reading.level,
      wrapped,
      queueBack: GPUQueue.prototype.submit === submit,
      paceBack: engine.pace === pace,
      budget: features.budget,
      errors,
    };
  });
  console.log(JSON.stringify(result));
  if (result.hasBattery) assert.deepEqual([result.charging, result.battery], result.real, 'reads the real manager');
  assert.equal(result.wrapped, true);
  assert.equal(result.queueBack, true);
  assert.equal(result.paceBack, true);
  assert.equal(result.budget, 12);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(problems, []);
  console.log('power browser check passed');
} finally {
  await context.close();
  await release();
}
