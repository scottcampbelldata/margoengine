// Raw WebGL2 and raw WebGPU trilinear blend weights on one adapter; the page (mip-blend-control.html) holds no Margo
// code. Prints the level-1 weight each API's hardware sampler used at LODs 0.125 to 0.875; exact trilinear filtering
// gives weight = LOD fraction. Not a gate: the known-bugs entry "AMD Direct3D 11 steepens the trilinear blend" quotes
// its output. From the repository root, AMD iGPU of the dev PC:
//   MARGO_GPU=amd GPU_POWER=low-power node scripts/gpu-lock.mjs run --owner=<you> --gpu=render-correctness -- node scripts/reference-rendering/mip-blend-control.mjs
import { openBrowser } from '../browser.js';
import { runSuite } from '../support/shutdown.mjs';

const ctx = await openBrowser({ startPath: '/scripts/reference-rendering/mip-blend-control.html', port: 'free' });
await runSuite(
  async () => {
    await ctx.page.waitForFunction(() => window.probe, null, { timeout: 30000 });
    const r = await ctx.page.evaluate((powerPreference) => window.probe({ powerPreference }), ctx.hardware.powerPreference);
    const shown = [8, 16, 24, 32, 40, 48, 56];
    const pick = (w) => w && shown.map((i) => +w[i].toFixed(5));
    const worst = (w) => w && Math.max(...w.map((x, i) => Math.abs(x - r.lods[i])));
    const rows = (api) =>
      api && !api.error
        ? {
            explicit: pick(api.explicit),
            implicit: pick(api.implicit),
            worstExplicit: worst(api.explicit),
            worstImplicit: worst(api.implicit),
          }
        : api;
    console.log(
      JSON.stringify({
        webglRenderer: r.webgl2.renderer,
        webgpuAdapter: r.webgpu?.adapter,
        lods: shown.map((i) => r.lods[i]),
        webgl2: rows(r.webgl2),
        webgpu: rows(r.webgpu),
      }),
    );
  },
  () => ctx.close(),
);
