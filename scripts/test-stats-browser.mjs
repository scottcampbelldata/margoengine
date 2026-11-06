// The real-GPU check of the @margoengine/stats entries that wrap a live device or engine. The fake devices in
// packages/stats/test cannot show that a wrapper keeps the native receiver or that a hook sits on the engine's real
// frame path. It takes the GPU lock itself:
//   npm run test:browser --workspace @margoengine/stats
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const release = await acquire({ owner: 'stats-browser' });
let browser;
try {
  browser = await openBrowser({ startPath: '/tests/browser/stats-native-passes.html', port: 5271 });
  const { page, hardware } = browser,
    errors = [];
  assert.equal(hardware.webgpu?.fallback, false);
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
  const proof = await page.evaluate(async () => {
    const { EngineKernel, box } = await import('/packages/core/dist/index.js');
    const { engineRuntime } = await import('/packages/core/dist/extension.js');
    const { PipelineCompiles } = await import('/packages/stats/dist/compile.js');
    const { FramePhases } = await import('/packages/stats/dist/phases.js');
    const { GPUMemory } = await import('/packages/stats/dist/report.js');
    const { LeakWatch } = await import('/packages/stats/dist/leaks.js');
    const ensure = (condition, message) => {
      if (!condition) throw new Error(message);
    };
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:128px;height:96px';
    canvas.width = 128;
    canvas.height = 96;
    document.body.append(canvas);
    const instance = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        camera: { position: [0, 0, 6], target: [0, 0, 0], near: 0.1, far: 100 },
      }),
      engine = engineRuntime(instance),
      device = engine.gpu,
      gpuErrors = [],
      result = {};
    device.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
    engine.createMesh().setGeometry(box());
    const frames = async (count) => {
      for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame);
    };

    const compiles = PipelineCompiles.attach(instance),
      { createRenderPipeline } = Object.getPrototypeOf(device);
    engine.start();
    await frames(5);
    ensure(compiles.frames >= 3, 'Frames reach PipelineCompiles from the engine loop');
    const module = device.createShaderModule({
        label: 'probe shader',
        code: `@vertex fn v() -> @builtin(position) vec4f { return vec4f(); }
          @fragment fn f() -> @location(0) vec4f { return vec4f(); }
          @compute @workgroup_size(1) fn c() {}`,
      }),
      layout = 'auto',
      pipeline = device.createRenderPipeline({
        label: 'probe render',
        layout,
        vertex: { module },
        fragment: { module, targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'point-list' },
      }),
      compute = await device.createComputePipelineAsync({ label: 'probe compute', layout, compute: { module } });
    ensure(pipeline instanceof GPURenderPipeline && compute instanceof GPUComputePipeline, 'Native pipelines returned');
    const hitch = compiles.frame(1000),
      report = compiles.toJSON(),
      names = report.compiles.map((record) => record.label);
    for (const name of ['probe shader', 'probe render', 'probe compute'])
      ensure(names.includes(name), 'Compile recorded: ' + name);
    ensure(
      report.compiles.every((record) => record.milliseconds >= 0 && !record.failed),
      'Every native compile finished',
    );
    ensure(
      hitch?.compiles.some((record) => record.label === 'probe render'),
      'A slow frame names the compile',
    );
    compiles.dispose();
    ensure(device.createRenderPipeline === createRenderPipeline, 'Device calls restored');
    result.compiles = { count: report.count, frames: report.frames, names };

    // Each spin sits in one phase on the real frame path, so that phase must read at least its length.
    const spin = (milliseconds) => {
        const end = performance.now() + milliseconds;
        while (performance.now() < end);
      },
      geometry = box();
    for (let i = 0; i < 5000; i++) engine.createMesh().setGeometry(geometry);
    // A native submit is shorter than the browser's clock step, so it is given a known length.
    const slowSubmit = function (commands) {
      spin(2);
      return GPUQueue.prototype.submit.call(this, commands);
    };
    device.queue.submit = slowSubmit;
    const phases = FramePhases.attach(instance, { samples: 16 }),
      removeSpin = engine.onFrame(() => spin(3)),
      removePass = engine.frameGraph.add({ name: 'stats-spin', order: 1, execute: () => spin(4) });
    await frames(24);
    const average = phases.average(),
      { total, ...parts } = average,
      sum = Object.values(parts).reduce((a, b) => a + b);
    ensure(phases.frames >= 16, 'Frames reach FramePhases');
    ensure(average.update >= 3, 'onFrame work reads as update: ' + average.update);
    ensure(average.encode >= 4, 'A pass reads as encode: ' + average.encode);
    ensure(average.tick > 0, 'The kernel tick is timed: ' + average.tick);
    ensure(average.submit >= 2, 'The submit is timed: ' + average.submit);
    ensure(Math.abs(sum - total) < 0.01, 'Phases add up to the total');
    removeSpin();
    removePass();
    phases.dispose();
    await frames(2);
    ensure(device.queue.submit === slowSubmit, 'Submit restored');
    delete device.queue.submit;
    result.phases = average;

    // Real buffers that are never destroyed, then a label that is: only the first may alert.
    const memory = GPUMemory.attach(device),
      leaks = LeakWatch.attach(memory, { intervalMilliseconds: 0, window: 8, minBytes: 1024, minCount: 4, warn: null }),
      usage = GPUBufferUsage.COPY_DST,
      kept = [];
    for (let i = 0; i < 8; i++) {
      kept.push(device.createBuffer({ label: 'leaking', size: 1024, usage }));
      kept.push(device.createBuffer({ label: 'leaking', size: 1024, usage }));
      device.createBuffer({ label: 'released', size: 1024, usage }).destroy();
      leaks.sample(i * 1000);
    }
    ensure(leaks.leaking.includes('label leaking count'), 'A growing label on a real device alerts');
    ensure(!leaks.leaking.some((name) => name.includes('released')), 'A released label does not');
    result.leaks = leaks.leaking;
    leaks.dispose();
    memory.dispose();
    for (const buffer of kept) buffer.destroy();

    engine.stop();
    await frames(2);
    ensure(gpuErrors.length === 0, 'Native GPU validation errors: ' + gpuErrors.join('; '));
    instance.dispose();
    return result;
  });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ hardware: hardware.webgpu, proof }, null, 2));
} finally {
  await browser?.close();
  await release();
}
