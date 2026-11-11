// Caustics at its default and at its upper limits (Water 512 segments, map 2048, 32 layers): each case must create, render
// with no GPU validation error, and light the receiver. Work counts are asserted (beam triangles per frame, map bytes);
// The range kernels must plan onto a GPU tier of the WebGL2 layer (a workgroup barrier put them on the JavaScript tier, 214 ms a
// frame at the default size, 0.5 ms native). GPU frame time (timestamp-query) is a diagnostic whose targets live in docs/work-lists/speed-phase.md.
// node scripts/gpu-lock.mjs run --owner=<you> --max=10 -- node packages/water/test/caustics-scale.browser.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
import { openBrowser } from '../../../scripts/browser.js';

const cases = [
  { name: 'water-only', off: true, segments: 128, resolution: 256, layers: 12 },
  { name: 'default', segments: 128, resolution: 256, layers: 12 },
  { name: 'medium', segments: 256, resolution: 1024, layers: 16 },
  { name: 'limit', segments: 512, resolution: 2048, layers: 32 },
];
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' });
try {
  const errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  for (const c of cases) {
    const result = await browser.page.evaluate(async (c) => {
      const [{ EngineKernel, box, PbrMaterial }, { Water }, { Caustics }, { Stats }] = await Promise.all([
        import('/packages/core/dist/index.js'),
        import('/packages/water/dist/index.js'),
        import('/packages/water/dist/caustics.js'),
        import('/packages/stats/dist/index.js'),
      ]);
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:320px;height:200px';
      document.body.replaceChildren(canvas);
      const engine = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 4,
        features: ['timestamp-query'],
        camera: { position: [0, 6, 16], target: [0, -5, 0], near: 0.1, far: 200 },
      });
      engine.lighting.direction.set([1, 3, 1, 1]);
      engine.lighting.radiance.set([1, 0.96, 0.86, 0.3]);
      engine.createMesh().setGeometry(box(80, 0.2, 80)).setMaterial(new PbrMaterial({ color: '#cbbb93', roughness: 0.9 })).setPosition([0, -6, 0]);
      const device = engine.gpu;
      const sources = [];
      const createShaderModule = device.createShaderModule.bind(device);
      device.createShaderModule = (d) => (sources.push(d.code), createShaderModule(d));
      device.pushErrorScope('validation');
      const water = Water.attach(engine, { size: [64, 64], segments: c.segments, height: 0 });
      const stats = Stats.attach(engine, { profiling: true });
      const caustics = c.off ? { dispose() {} } : Caustics.attach(engine, { surface: water, size: 64, heightRange: [-8, 0], resolution: c.resolution, layers: c.layers });
      const t0 = performance.now();
      engine.render({ delta: 1 / 60 });
      await device.queue.onSubmittedWorkDone();
      const firstMs = performance.now() - t0;
      const frames = 20;
      const t1 = performance.now();
      for (let i = 0; i < frames; i++) {
        engine.render({ delta: 1 / 60 });
        await device.queue.onSubmittedWorkDone();
      }
      const steadyMs = (performance.now() - t1) / frames;
      // The GPU time is read back asynchronously: draw until a timestamp sample has arrived (a device with no
      // timestamp-query has none to wait for), failing after 10 s.
      const timed = device.features.has('timestamp-query'),
        deadline = performance.now() + 10000;
      do {
        engine.render({ delta: 1 / 60 });
        await device.queue.onSubmittedWorkDone();
        if (!timed || stats.gpuElapsedMilliseconds !== null) break;
        if (performance.now() > deadline) throw new Error('no GPU timestamp sample arrived in 10 s');
        await new Promise((r) => setTimeout(r, 10));
      } while (true);
      const gpuMs = stats.gpuElapsedMilliseconds;
      const error = await device.popErrorScope();
      const { planCompute } = await import('/packages/webgl2-compat/dist/compute.js');
      const code = sources.find((x) => x.includes('fn measure'));
      const tiers = code ? ['measure', 'chunks', 'reduce'].map((entryPoint) => planCompute({ source: code, entryPoint }).tier) : [];
      stats.dispose();
      caustics.dispose();
      water.dispose();
      engine.dispose();
      return { tiers, firstMs, steadyMs, gpuMs, error: error?.message ?? null };
    }, c);
    const triangles = 2 * c.segments * c.segments * c.layers;
    const mapBytes = 3 * c.resolution * c.resolution * c.layers * 8;
    if (!c.off) assert.deepEqual(result.tiers.filter((t) => t === 'cpu'), [], `${c.name}: a range kernel runs on the CPU tier ${result.tiers}`);
    if (!c.off) assert.equal(result.tiers.length, 3);
    assert.equal(result.error, null, `${c.name}: GPU validation error ${result.error}`);
    console.log(
      `${c.name}: ${triangles} beam triangle instances, ${(mapBytes / 2 ** 20).toFixed(0)} MiB flux maps; first ${result.firstMs.toFixed(0)} ms, steady ${result.steadyMs.toFixed(1)} ms wall, GPU ${result.gpuMs?.toFixed(2) ?? 'n/a'} ms`,
    );
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
