// Regression (KB-FX273, 2026-11-15): CulledParts.pick and DynamicInstances.pick cleared their r32uint id target to
// 4294967295 for "nothing", and Firefox 157 clears an integer target through float32, which made it 0: every empty
// pixel picked part 0 of batch 0, or instance 0. Ids are now written one up over a clear of 0. The page rounds clear values as Firefox does
// (tests/support/float32-clears.js), so this fails without the fix in any browser.
//   node scripts/run-with-timeout.mjs -- node packages/culling/test/gpu/pick-clear-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { float32Clears } from '../../../../tests/support/float32-clears.js';

const context = await openBrowser({ startPath: '/tests/modern-extension.html', port: 'free' }),
  { page } = context;
try {
  await page.addInitScript(float32Clears);
  await page.reload();
  const result = await page.evaluate(async () => {
    const { box, Engine, PbrMaterial } = await import('/packages/core/dist/index.js');
    const { CulledParts } = await import('/packages/culling/dist/parts.js'),
      { DynamicInstances } = await import('/packages/culling/dist/dynamic.js');
    const canvas = document.body.appendChild(document.createElement('canvas'));
    canvas.style.cssText = 'display:block;width:64px;height:64px';
    const engine = await Engine.create(canvas, {
        backend: 'webgpu',
        camera: { position: [0, 0, 3], target: [0, 0, 0] },
      }),
      errors = [];
    engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    const at = (x) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
    const parts = CulledParts.attach(engine, [
      {
        geometry: box(),
        material: new PbrMaterial({ color: '#8d99a6' }),
        transforms: new Float32Array([...at(0), ...at(40)]),
        capacity: 4,
      },
    ]);
    engine.render({ delta: 0 });
    await engine.gpu.queue.onSubmittedWorkDone();
    const out = {
      corner: await parts.pick(1, 1),
      centre: await parts.pick(32, 32),
    };
    engine.dispose();
    // DynamicInstances on an engine of its own: one instance at the centre, one far off.
    const canvas2 = document.body.appendChild(document.createElement('canvas'));
    canvas2.style.cssText = 'display:block;width:64px;height:64px';
    const engine2 = await Engine.create(canvas2, {
      backend: 'webgpu',
      camera: { position: [0, 0, 3], target: [0, 0, 0] },
    });
    engine2.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    const crowd = DynamicInstances.attach(engine2, {
      geometry: box(),
      material: new PbrMaterial({ color: '#ffffff' }),
      capacity: 8,
    });
    crowd.addInstance(at(0));
    crowd.addInstance(at(40));
    engine2.render({ delta: 0 });
    await engine2.gpu.queue.onSubmittedWorkDone();
    Object.assign(out, {
      instanceCorner: await crowd.pick(1, 1),
      instanceCentre: await crowd.pick(32, 32),
      patched: !!globalThis.GPUCommandEncoder?.prototype.__float32Clears,
      compat: !!globalThis.__margoCompat,
      errors,
    });
    engine2.dispose();
    return out;
  });
  console.log(JSON.stringify(result));
  assert.deepEqual(result.errors, []);
  assert.ok(result.patched || result.compat, 'the float32 clear stand-in is in place on WebGPU');
  assert.equal(result.corner, null, 'the empty corner picks no part');
  assert.deepEqual(result.centre, { batch: 0, index: 0 }, 'the centre picks part 0');
  assert.equal(result.instanceCorner, null, 'the empty corner picks no instance');
  assert.equal(result.instanceCentre, 0, 'the centre picks instance 0');
  console.log('pick-clear-check: ok');
} finally {
  await context.close();
}
