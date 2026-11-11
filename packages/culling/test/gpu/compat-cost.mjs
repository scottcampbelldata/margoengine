// Cost of CulledMeshes on the backend under test (native WebGPU, or the WebGL2 layer with MARGO_COMPAT=1 / --compat):
// for each crowd size, no plugin, frustum culling, occlusion culling and WebGL2Culling (CPU depth), with GL draws, triangles, stalls and frame
// times per frame. Prints one JSON line per case. Takes a GPU slot itself. Run from the repository root after building:
//   node packages/culling/test/gpu/compat-cost.mjs [--compat] [--sizes=1500,12000] [--frames=20]
import { openBrowser } from '../../../../scripts/browser.js';
import { acquire } from '../../../../scripts/gpu-lock.mjs';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d,
  sizes = arg('sizes', '1500,12000').split(',').map(Number),
  frames = Number(arg('frames', '20')),
  release = await acquire({ owner: 'culling-compat-cost' });
try {
  for (const n of sizes)
    for (const mode of ['none', 'frustum', 'occlusion', 'software']) {
      const context = await openBrowser({ startPath: '/packages/culling/test/gpu/compat-cost.html', port: 5291 }),
        { page } = context;
      try {
        await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
        const r = await page.evaluate((o) => window.check.run(o), { n, mode, frames });
        console.log(JSON.stringify(r));
      } finally {
        // fixed-wait: a bounded close, so a browser that hangs while closing cannot hold the GPU slot past 15 s
        await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 15000).unref())]);
      }
    }
} finally {
  await release();
}
