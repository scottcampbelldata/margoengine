// KB5700f: runs the standalone folded blend repeat page (fold-blend-repeat.html, raw WebGPU and raw WebGL2, no Margo
// code) and prints each case's repeat counts. Not a gate: docs/upstream-reports/KB5700f/report.md quotes its output, and
// the sciviz regression (packages/sciviz/tests/surface-repeat-browser.mjs) pins Margo's stable cases. From the repository
// root, with the GPU lock held:
//   node scripts/gpu-lock.mjs run --owner=<you> -- node scripts/reference-rendering/fold-blend-repeat.mjs [--frames=24]
// The dev PC's AMD iGPU: MARGO_GPU=amd GPU_POWER=low-power node scripts/gpu-lock.mjs run --owner=<you>
//   --gpu=render-correctness -- node scripts/reference-rendering/fold-blend-repeat.mjs
import { openBrowser } from '../browser.js';
import { runSuite } from '../support/shutdown.mjs';

const frames = Number(process.argv.find((a) => a.startsWith('--frames='))?.split('=')[1] ?? 24);
if (!Number.isInteger(frames) || frames < 2 || frames > 512) throw new RangeError('--frames must be 2..512');
const context = await openBrowser({ startPath: '/scripts/reference-rendering/fold-blend-repeat.html', port: 'free' });
await runSuite(
  async () => {
    await context.page.waitForFunction(() => window.repeatFold, null, { timeout: 30000 });
    for (const api of ['webgpu', 'webgl2']) {
      let timer;
      const result = await Promise.race([
        context.page.evaluate((o) => window.repeatFold(o), {
          api,
          frames,
          powerPreference: context.hardware.powerPreference ?? 'high-performance',
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${api} repeat exceeded its 120 s deadline`)), 120_000);
        }),
      ]).finally(() => clearTimeout(timer));
      console.log('RESULT', JSON.stringify(result));
    }
  },
  () => context.close(),
);
