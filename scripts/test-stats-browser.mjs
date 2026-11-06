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
