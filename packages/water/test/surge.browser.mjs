// A storm surge on today's coastal flow (disaster water push 1): `setSeaLevel` is live, so a sea level raised slowly
// floods a beach through the open map edge and a fall drains it again. A 64 x 64 heightmap of 1 m cells rises 0.1 m per
// metre of x from -2.95 m to 3.35 m; the level climbs from 0 to 1 m over 10 s, holds 15 s, falls back over 10 s and
// holds 10 s. A cell whose ground is 0.5 m stays dry at first, stands under about 0.5 m of water at the top of the
// surge and is drained at the end; a cell at 1.5 m stays dry all through. Run natively and (MARGO_COMPAT=1) on the
// WebGL2 layer.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
await mkdir('test-results', { recursive: true });
const browser = await openBrowser({ startPath: '/tests/modern-game.html' }),
  { page, hardware } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
try {
  const r = await page.evaluate(async () => {
    const { EngineKernel } = await import('/packages/core/dist/index.js'),
      { Water } = await import('/packages/water/dist/index.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:320px;height:200px';
    document.body.append(canvas);
    const engine = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 16,
        camera: { position: [0, 60, 40], target: [0, 0, 0], near: 0.5, far: 1000 },
      }),
      device = engine.gpu;
    device.pushErrorScope('validation');
    const N = 64,
      groundAt = (i) => -2.95 + 0.1 * i,
      ground = new Float32Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) ground[j * N + i] = groundAt(i);
    const texture = device.createTexture({
      size: [N, N],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture }, ground, { bytesPerRow: N * 4 }, [N, N]);
    const water = Water.attach(engine, {
      size: [64, 64],
      segments: 64,
      terrain: { heightmap: () => texture, origin: [-32, -32], size: [64, 64] },
      // A near-flat swell, so the depths read back are the surge's own.
      waves: [{ direction: [1, 0], amplitude: 0.005, wavelength: 20 }],
    });
    const read = device.createBuffer({ size: N * N * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const state = async () => {
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: water.coastalDepthTexture }, { buffer: read, bytesPerRow: N * 16 }, [
        N,
        N,
      ]);
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const data = new Float32Array(read.getMappedRange()).slice();
      read.unmap();
      return data;
    };
    // Depth (m) down the middle row at ground 0.5 m (i = 34.5 -> 34) and 1.5 m (i = 44), and the water volume (m^3).
    const probe = async () => {
      const s = await state(),
        row = 32 * N;
      let volume = 0;
      for (let k = 0; k < N * N; k++) volume += s[k * 4];
      return { low: s[(row + 34) * 4], high: s[(row + 44) * 4], volume };
    };
    // Steps of 1/60 s while the level follows `level(t)`.
    let t = 0;
    const run = async (seconds, level) => {
      for (let f = 0; f < seconds * 60; f++) {
        t += 1 / 60;
        water.setSeaLevel(level(t));
        engine.render({ delta: 1 / 60 });
        if (f % 60 === 59) await device.queue.onSubmittedWorkDone();
      }
      await device.queue.onSubmittedWorkDone();
    };
    await run(2, () => 0);
    const calm = await probe();
    await run(10, (s) => Math.min(1, (s - 2) / 10));
    await run(15, () => 1);
    const peak = await probe();
    await run(10, (s) => Math.max(0, 1 - (s - 27) / 10));
    await run(10, () => 0);
    const after = await probe();
    const error = await device.popErrorScope();
    return { calm, peak, after, level: water.seaLevel, error: error?.message ?? null };
  });
  console.log(JSON.stringify(r));
  assert.equal(r.error, null);
  assert.ok(r.calm.low < 0.01 && r.calm.high < 0.01, 'the beach is dry before the surge');
  assert.ok(
    Math.abs(r.peak.low - 0.55) < 0.1,
    `the surge floods the beach to its level (${r.peak.low} m at ground 0.45 m)`,
  );
  assert.ok(r.peak.high < 0.01, 'ground above the surge stays dry');
  // The sea at rest at level L holds the still water over every cell below it: 64 rows of sum (L - ground) over the
  // cells under L, 2,880 m^3 at 0 and 5,120 m^3 at 1 m (a ratio of 1.78; the swell's 5 mm adds under 0.3%). Until
  // KB-WATER-SURGEVOL1 this asked only for a ratio over 1.2, and native WebGPU on an Intel xe-2lpg passed a sea drained
  // to 1,431 m^3 by a NaN surf (tanh overflow) almost through it, at 1.17.
  const still = (level) => {
    let v = 0;
    for (let i = 0; i < 64; i++) v += 64 * Math.max(0, level - (-2.95 + 0.1 * i));
    return v;
  };
  assert.ok(
    Math.abs(r.calm.volume - still(0)) < still(0) * 0.01,
    `the sea at rest holds its still water (${r.calm.volume} m^3 of ${still(0)})`,
  );
  assert.ok(
    Math.abs(r.peak.volume - still(1)) < still(1) * 0.02,
    `the surge brings the sea in to its raised level (${r.peak.volume} m^3 of ${still(1)})`,
  );
  assert.ok(r.after.low < 0.02, `the beach drains when the level falls (${r.after.low} m)`);
  assert.ok(Math.abs(r.after.volume - r.calm.volume) < r.calm.volume * 0.02, 'the sea returns to its volume');
  assert.equal(r.level, 0);
  assert.deepEqual(errors, []);
  console.log(`water surge browser check passed (${hardware.webgpu.vendor}${hardware.compat ? ', WebGL2 layer' : ''})`);
} finally {
  await closeAll({ browser });
}
