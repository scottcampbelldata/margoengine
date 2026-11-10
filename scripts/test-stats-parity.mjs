// Shared-lock hardware correctness check for the optional Stats parity entries.
import assert from 'node:assert/strict';
import { openBrowser } from './browser.js';

const browser = await openBrowser({ startPath: '/tests/browser/stats-native-passes.html', port: 'free' });
try {
  const errors = [];
  browser.page.on('pageerror', (error) => errors.push(error.message));
  const proof = await browser.page.evaluate(async () => {
    const { EngineKernel, box } = await import('/packages/core/dist/index.js');
    const { webglRenderer } = await import('/packages/webgl2-compat/dist/preview.js');
    const { GeometryStats } = await import('/packages/stats/dist/geometry.js');
    const { GLStats } = await import('/packages/stats/dist/gl.js');
    const { engineRuntime } = await import('/packages/core/dist/extension.js');
    const { StatsPanels } = await import('/packages/stats/dist/panels.js');
    const check = (ok, message) => {
      if (!ok) throw new Error(message);
    };
    const results = {};
    for (const backend of ['webgpu', 'webgl2']) {
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 96;
      canvas.style.cssText = 'width:128px;height:96px';
      document.body.append(canvas);
      const engine = await EngineKernel.create(canvas, {
        backend,
        features: ['timestamp-query'],
        fallback: webglRenderer,
        camera: { position: [0, 0, 6], target: [0, 0, 0] },
      });
      const geometry = GeometryStats.attach(engine),
        shape = box();
      const glStats = backend === 'webgl2' ? GLStats.attach(engine) : undefined;
      if (glStats)
        engineRuntime(engine).frameGraph.add({
          name: 'timer-probe',
          order: 2,
          execute: (context) => {
            context.gl.clearColor(0.2, 0.3, 0.4, 1);
            context.gl.clear(context.gl.COLOR_BUFFER_BIT);
          },
        });
      engine.createMesh().setGeometry(shape);
      engine.createMesh().setGeometry(shape);
      try {
        engine.render();
        const report = geometry.toJSON();
        check(report.triangles === 24, backend + ': 24 box triangles: ' + JSON.stringify(report));
        check(
          report.vertices === 72 && report.instances === 2 && report.unknownDraws === 0,
          backend + ': geometry counts',
        );
        await new Promise(requestAnimationFrame);
        engine.render();
        check(geometry.triangles === 24, backend + ': reset on next frame');
        results[backend] = report;
        if (glStats) {
          await new Promise(requestAnimationFrame);
          check(glStats.supported, 'Hardware EXT_disjoint_timer_query_webgl2 is required for this proof');
          for (let i = 0; i < 120 && !glStats.poll(); i++) await new Promise(requestAnimationFrame);
          const timing = glStats.toJSON();
          check(timing.sampleId > 0 && timing.frameMilliseconds >= 0, 'Completed asynchronous GL frame query');
          check(timing.drawCalls === 1, 'Native preview draw count');
          check(
            timing.passes.some((pass) => pass.name === 'main'),
            'Named main pass',
          );
          check(
            timing.passes.some((pass) => pass.name === 'timer-probe'),
            'Named custom pass',
          );
          check(
            timing.passes.every((pass) => pass.milliseconds >= 0),
            'Nonnegative native pass times',
          );
          check(
            timing.passes.reduce((sum, pass) => sum + pass.milliseconds, 0) <= timing.frameMilliseconds + 1e-9,
            'Passes lie inside segmented GPU frame',
          );
          results.glTiming = timing;
        }
        glStats?.dispose();
        geometry.dispose();
        const panels = StatsPanels.attach(engine, { samples: 64 });
        const runtime = engineRuntime(engine);
        let buffer;
        if (runtime.gpu) {
          const device = runtime.gpu;
          buffer = device.createBuffer({ size: 4096, usage: GPUBufferUsage.COPY_DST });
          const module = device.createShaderModule({ code: '@compute @workgroup_size(1) fn main() {}' });
          const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module } });
          runtime.frameGraph.add({
            name: 'panel-compute',
            order: 2,
            execute: (context) => {
              const pass = context.encoder.beginComputePass({ label: 'panel-compute' });
              pass.setPipeline(pipeline);
              pass.dispatchWorkgroups(1);
              pass.end();
            },
          });
        } else
          runtime.frameGraph.add({
            name: 'panel-post',
            order: 3,
            execute: (context) => {
              context.gl.clear(context.gl.DEPTH_BUFFER_BIT);
            },
          });
        try {
          engine.start();
          for (let i = 0; i < 48; i++) await new Promise(requestAnimationFrame);
          engine.stop();
          panels.refresh();
          const history = panels.toJSON();
          check(
            history.fps.length >= 30 && history.cpuMilliseconds.every((value) => value >= 0),
            backend + ': CPU/FPS histories',
          );
          check(
            history.gpuMilliseconds.some((value) => value !== null),
            backend + ': GPU history',
          );
          check(
            history.memoryBytes.some((value) => value !== null && value > 0),
            backend + ': memory history',
          );
          const expected = backend === 'webgpu' ? 'panel-compute' : 'panel-post';
          check(
            history.passes.some((pass) => pass.name === expected),
            backend + ': named panel GPU pass',
          );
          check(panels.element.querySelectorAll('canvas[role="img"]').length === 4, backend + ': four labelled graphs');
          results[backend + 'Panels'] = history;
        } finally {
          panels.dispose();
          buffer?.destroy();
        }
      } finally {
        glStats?.dispose();
        geometry.dispose();
        engine.dispose();
        canvas.remove();
      }
    }
    const review = new StatsPanels({ samples: 64 });
    const history = results.webgpuPanels;
    for (let i = 0; i < history.fps.length; i++)
      review.sample({
        fps: history.fps[i],
        cpuMilliseconds: history.cpuMilliseconds[i],
        gpuMilliseconds: history.gpuMilliseconds[i],
        memoryBytes: history.memoryBytes[i],
        passes: history.passes,
      });
    review.refresh();
    window.__panelsReview = review;
    return results;
  });
  assert.deepEqual(errors, []);
  await browser.page.screenshot({ path: 'test-results/stats-panels-hardware.png' });
  await browser.page.evaluate(() => {
    window.__panelsReview.dispose();
    delete window.__panelsReview;
  });
  console.log(JSON.stringify({ hardware: browser.hardware, proof }, null, 2));
} finally {
  await browser.close();
}
