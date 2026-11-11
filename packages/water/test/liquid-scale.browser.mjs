// ParticleLiquid at its default scale (32,768 particles, 1280 x 720), a medium case and its limit (4,194,304 particles,
// 1920 x 1080), with the engine's default multisampling. Each case must render with no GPU validation error and the
// steady-frame work counts (6 passes, 6 draws, 320 uniform bytes, no bind group). GPU frame time (timestamp-query) and
// wall time are diagnostics whose targets live in docs/work-lists/speed-phase.md.
// node scripts/gpu-lock.mjs run --owner=<you> --max=10 -- node packages/water/test/liquid-scale.browser.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
import { openBrowser } from '../../../scripts/browser.js';

const cases = [
  { name: 'scene-only', count: 0, width: 1280, height: 720 },
  { name: 'default', count: 32768, width: 1280, height: 720 },
  { name: 'medium', count: 262144, width: 1920, height: 1080 },
  { name: 'limit', count: 4194304, width: 1920, height: 1080 },
];
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' });
try {
  const errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  for (const c of cases) {
    const result = await browser.page.evaluate(async (c) => {
      const [{ EngineKernel, box, PbrMaterial }, { ParticleLiquid }, { Stats }] = await Promise.all([
        import('/packages/core/dist/index.js'),
        import('/packages/water/dist/liquid.js'),
        import('/packages/stats/dist/index.js'),
      ]);
      const canvas = document.createElement('canvas');
      canvas.width = c.width;
      canvas.height = c.height;
      canvas.style.cssText = `width:${c.width}px;height:${c.height}px`;
      document.body.replaceChildren(canvas);
      const engine = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 4,
        features: ['timestamp-query'],
        camera: { position: [0, 2.2, 3.2], target: [0, 0.2, 0], near: 0.05, far: 100 },
      });
      engine.lighting.direction.set([0.4, 1, 0.3, 2]);
      engine
        .createMesh()
        .setGeometry(box(4, 0.1, 4))
        .setMaterial(new PbrMaterial({ color: '#b8b0a0', roughness: 0.8 }))
        .setPosition([0, -0.05, 0]);
      const device = engine.gpu;
      device.pushErrorScope('validation');
      // A pool of liquid: particles on a jittered lattice filling a 2 x 0.5 x 2 m box, spacing from the count.
      const n = Math.max(1, c.count),
        spacing = Math.cbrt((2 * 0.5 * 2) / n),
        positions = new Float32Array(c.count * 3);
      const nx = Math.ceil(2 / spacing),
        nz = Math.ceil(2 / spacing);
      let seed = 7;
      const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5;
      for (let i = 0; i < c.count; i++) {
        const x = i % nx,
          z = Math.floor(i / nx) % nz,
          y = Math.floor(i / (nx * nz));
        positions.set(
          [
            -1 + (x + 0.5 + rand() * 0.3) * spacing,
            (y + 0.5 + rand() * 0.3) * spacing,
            -1 + (z + 0.5 + rand() * 0.3) * spacing,
          ],
          i * 3,
        );
      }
      const stats = Stats.attach(engine, { profiling: true });
      const liquid = c.count ? ParticleLiquid.attach(engine, { particles: { positions }, radius: spacing }) : undefined;
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
      await new Promise((r) => setTimeout(r, 200));
      engine.render({ delta: 1 / 60 });
      await device.queue.onSubmittedWorkDone();
      const gpuMs = stats.gpuElapsedMilliseconds;
      const work = liquid ? { ...liquid.frameStats } : undefined;
      const error = await device.popErrorScope();
      stats.dispose();
      liquid?.dispose();
      engine.dispose();
      return { work, firstMs, steadyMs, gpuMs, spacing, error: error?.message ?? null };
    }, c);
    assert.equal(result.error, null, `${c.name}: GPU validation error ${result.error}`);
    if (c.count) assert.deepEqual(result.work, { passes: 6, draws: 6, bytes: 320, particles: c.count, groups: 0, whitewater: 0 });
    console.log(
      `${c.name}: ${c.count} particles at ${c.width} x ${c.height} (radius ${result.spacing.toFixed(4)} m); first ${result.firstMs.toFixed(0)} ms, steady ${result.steadyMs.toFixed(1)} ms wall, GPU ${result.gpuMs?.toFixed(2) ?? 'n/a'} ms`,
    );
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
