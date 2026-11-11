// Jump flooding on the real GPU, native WebGPU and the WebGL2 compatibility layer (one GPU job; from the repository root):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/compute/tests/distance-browser.mjs
// Checks the error bars at 1024^2 and 128^3 against the exact transform, that the nearest-seed buffer equals the CPU
// backend's bit for bit, the Voronoi map and signed distance, and the limits; prints GPU pass times as diagnostics.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const browser = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free', compat: false });
try {
  for (const compat of [false, true]) {
    if (compat) await browser.page.reload();
    const result = await browser.page.evaluate(async (compat) => {
      if (compat) {
        const { install } = await import('/packages/webgl2-compat/dist/index.js');
        await install({ force: true });
      }
      const { createCompute } = await import('/packages/compute/dist/index.js');
      const cases = await import('/packages/compute/tests/distance-cases.js');
      const { jumpFlood, distanceTransform } = await import('/packages/compute/dist/distance.js');
      const { squaredDistanceTransformNd } = await import('/packages/shared/distance-exact.js');
      using c = await createCompute({ backend: 'webgpu' });
      using cpu = await createCompute({ backend: 'cpu' });
      const exact = (grid, shape) => squaredDistanceTransformNd(grid, shape);
      const report = await cases.floodErrorRates(c, exact, 1024, 128);
      const extra = await cases.voronoiAndSigned(c, 512);
      // Same nearest-seed buffer on the GPU and the CPU backend (integer arithmetic, ties to the lower index).
      let identical = 0;
      for (const [shape, count] of [
        [[300, 200], 25],
        [[96, 80], 'curve'],
        [[40, 33, 29], 60],
      ]) {
        const mask = cases.makeMask(shape, count, 5);
        using a = c.array(mask, { dtype: 'u32', shape });
        using b = cpu.array(mask, { dtype: 'u32', shape });
        using fa = await jumpFlood(a);
        using fb = await jumpFlood(b);
        const [x, y] = await Promise.all([fa.nearest.read(), fb.nearest.read()]);
        assert_equal(x.length, y.length);
        for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) throw new Error(`nearest differs at ${i} for ${shape}`);
        identical++;
      }
      // Timings (diagnostic, busy machine): the passes of a 4096^2 field and a 256^3 field.
      const timed = {};
      for (const shape of [
        [4096, 4096],
        [256, 256, 256],
      ]) {
        const mask = cases.makeMask(shape, 1000, 9);
        using a = c.array(mask, { dtype: 'u32', shape });
        const t = await c.profile(async () => {
          (await distanceTransform(a)).dispose();
        });
        timed[shape.join('x')] = { passes: t.length, ms: +t.reduce((s, p) => s + p.ms, 0).toFixed(2) };
      }
      let limit = '';
      try {
        await distanceTransform(c.zeros([512, 512, 512], 'u32'));
        limit = 'ok';
      } catch (e) {
        limit = String(e.message).slice(0, 120);
      }
      function assert_equal(a, b) {
        if (a !== b) throw new Error(`${a} !== ${b}`);
      }
      return { report, extra, identical, timed, limit, bytes: c.device.limits.maxStorageBufferBindingSize };
    }, compat);
    assert.equal(result.identical, 3);
    console.log(`distance ${compat ? 'WebGL2' : 'WebGPU'}: ` + JSON.stringify(result));
  }
} finally {
  await browser.close();
}
