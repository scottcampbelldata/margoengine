// water/flood mud mode on the GPU, on WebGPU and, with MARGO_COMPAT=1, the WebGL2 compatibility layer: a 1 m column of
// mud released against a wall on a flat bed spreads and stops, at rest in the static profile of a yield-stress fluid,
// h(x)^2 = 2 tau_y (x_f - x) / (rho_m g) (the balance g h dh/dx = tau_y / rho_m of the quadratic rheology's yield term,
// O'Brien, Julien and Fullerton 1993), while water from the same column runs to the far wall; the volume holds.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { mudRheology } from '../dist/flood.js';

const MUD = { sediment: 'aspen-natural-soil', concentration: 0.45, resistance: 24 };
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' }),
  { page } = browser,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
try {
  const result = await page.evaluate(
    async ({ mud }) => {
      const { EngineKernel } = await import('/packages/core/dist/index.js');
      const { Water } = await import('/packages/water/dist/index.js');
      const { Flood } = await import('/packages/water/dist/flood.js');
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:64px;height:48px';
      document.body.replaceChildren(canvas);
      const engine = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 4,
        camera: { position: [25, 40, 30], target: [25, 0, 1], near: 0.1, far: 500 },
      });
      const d = engine.gpu;
      // 200 x 4 cells of 0.25 m over a flat bed, 1 m of fluid behind a dam at x = 10 m, walls all round.
      const run = async (options, seconds) => {
        const width = 200,
          height = 4,
          size = [50, 1],
          terrain = d.createTexture({
            size: [width, height],
            format: 'r32float',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
          });
        d.queue.writeTexture({ texture: terrain }, new Float32Array(width * height), { bytesPerRow: width * 4 }, [
          width,
          height,
        ]);
        const water = Water.attach(engine, {
          height: -100,
          size: [200, 200],
          segments: 16,
          waves: [{ direction: [1, 0], amplitude: 0, wavelength: 10 }],
          terrain: { heightmap: () => terrain, origin: [0, 0], size },
          fill: (x) => (x < 10 ? 1 : -1),
        });
        const flood = Flood.attach(engine, { surface: water, maxDepth: 1, maxSpeed: 7, ...options });
        engine.render({ delta: 0 });
        const target = flood.steps + Math.round(seconds / flood.dt);
        flood.advanceTime(seconds);
        for (let i = 0; i < 20000 && flood.steps < target; i++) engine.render({ delta: 0 });
        const r = await flood.read();
        const out = {
          steps: flood.steps,
          target,
          depth: Array.from(r.depth.subarray(0, width)),
          u: Array.from(r.velocity.subarray(0, 2 * width)).filter((_, i) => i % 2 === 0),
        };
        flood.dispose();
        water.dispose();
        terrain.destroy();
        return out;
      };
      return { mud: await run({ roughness: 0.03, mud }, 240), water: await run({ roughness: 0.03 }, 20) };
    },
    { mud: MUD },
  );
  assert.deepEqual(errors, []);
  const { mud, water } = result,
    cell = 0.25,
    rheology = mudRheology(MUD),
    k = rheology.yieldStress / (rheology.density * 9.80665),
    front = (r) => r.depth.reduce((f, h, i) => (h > 0.01 ? (i + 1) * cell : f), 0),
    volume = (r) => r.depth.reduce((s, h) => s + h * cell, 0);
  assert.equal(mud.steps, mud.target, 'ran every step');
  assert.ok(Math.abs(volume(mud) - 10) < 0.05, `mud volume ${volume(mud)} of 10 m^2`);
  assert.ok(front(water) > 45, `water runs to the far wall: front ${front(water)} m`);
  // The static profile holds 10 m^2: (2/3) sqrt(2 k) x_f^(3/2) = 10.
  const xf = (15 / Math.sqrt(2 * k)) ** (2 / 3);
  assert.ok(Math.abs(front(mud) / xf - 1) < 0.15, `mud stops at ${front(mud)} m, the yield profile ${xf.toFixed(1)} m`);
  assert.ok(Math.max(...mud.u.map(Math.abs)) < 0.01, `the mud is at rest: ${Math.max(...mud.u.map(Math.abs))} m/s`);
  for (const x of [0.25 * xf, 0.5 * xf, 0.75 * xf]) {
    const h = mud.depth[Math.floor(x / cell)],
      want = Math.sqrt(2 * k * (xf - x));
    assert.ok(
      Math.abs(h / want - 1) < 0.15,
      `depth ${h.toFixed(3)} at ${x.toFixed(1)} m, the profile ${want.toFixed(3)}`,
    );
  }
  console.log(`ok flood mud: stops at ${front(mud)} m (profile ${xf.toFixed(1)} m), water reaches ${front(water)} m`);
} finally {
  await closeAll({ browser });
}
