// KB-WATER-NEARDETAIL1 and KB-WATER-TAASMEAR1 regressions: the near sea of the Kitty Hawk s18 shot was a smooth, smeared
// wash, with no fine ripples and no crisp relief. A camera 3.6 m above a 12 m/s wind sea (chop 0.75) looks 15 degrees
// down at 960 x 540, the horizon in frame and the water 5 to 9 m off in the lower third, where a pixel covers about a
// centimetre, on WebGPU or (MARGO_COMPAT=1) the WebGL2 compatibility layer. Fine relief is the RMS of the luma less its
// 3 x 3 box mean over the lower third: the sea's detail at 2 to 5 cm.
// (a) Near detail: the gravity-capillary octaves give the chop-0.75 sea at least 6 levels of fine relief (13.7 measured;
//     it had 1.8, from ripple layers of 30 cm and longer only).
// (b) Reactive mask: Water.reactiveTexture is 1 over the near sea while the waves move (delta 1/30), 0 above the
//     horizon where no water is drawn, and 0 everywhere when nothing moves (delta 0).
// (c) TAA on a plain kernel, `TAA.attach(engine)` with nothing wired: after 24 moving frames it keeps at least 0.8 of
//     the fine relief of the frame drawn with no TAA, as Water publishes its mask and TAA reads it by itself
//     (shared/reactive-mask.js). The parent, where TAA never saw the mask, kept 0.34: the moving waves averaged into a
//     smear. With TAA's own `reactive` (a black 4 x 4 mask) as well, TAA takes the maximum of the two in its combine
//     pass and keeps the relief the same way.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const compat = process.env.MARGO_COMPAT === '1' || process.argv.includes('--compat');
const WIDTH = 960,
  HEIGHT = 540,
  FRAMES = 24;
const browser = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' }),
  { page } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
// RMS of luma less its 3 x 3 box mean over rows [y0, y1).
const R = 1;
const fine = (png, y0, y1) => {
  const l = (x, y) => {
    const i = (y * png.width + x) * 4;
    return 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
  };
  let sum = 0,
    n = 0;
  for (let y = y0 + R; y < y1 - R; y++)
    for (let x = R; x < png.width - R; x++) {
      let mean = 0;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) mean += l(x + dx, y + dy);
      const d = l(x, y) - mean / (2 * R + 1) ** 2;
      sum += d * d;
      n++;
    }
  return Math.sqrt(sum / n);
};
try {
  await page.evaluate(
    async ({ compat, WIDTH, HEIGHT, FRAMES }) => {
      if (compat) await (await import('/packages/webgl2-compat/dist/index.js')).install({ force: true });
      const { EngineKernel } = await import('/packages/core/dist/index.js'),
        { Water } = await import('/packages/water/dist/index.js'),
        { TAA } = await import('/packages/taa/dist/index.js'),
        { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
      // The s18 sea: dune-coast's swell and the 12 m/s north wind's sea and chop.
      const waves = [
        { direction: [-0.97, 0.24], amplitude: 0.45, wavelength: 72, steepness: 0.45, phase: 0.4 },
        { direction: [-0.88, -0.47], amplitude: 0.24, wavelength: 41, steepness: 0.45, phase: 2.2 },
        { direction: [0, 1], amplitude: 0.3, wavelength: 11, steepness: 0.3, phase: 4.1 },
        { direction: [-0.2, 1], amplitude: 0.12, wavelength: 5, steepness: 0.35, phase: 1.3 },
      ];
      let canvas, engine, water, taa, black;
      const open = async ({ chop, mode }) => {
        canvas?.remove();
        canvas = document.createElement('canvas');
        canvas.style.cssText = `width:${WIDTH}px;height:${HEIGHT}px`;
        document.body.append(canvas);
        engine = await EngineKernel.create(canvas, {
          backend: 'webgpu',
          capacity: 16,
          camera: { position: [0, 3.6, 0], target: [0, 0, -13.4], near: 0.1, far: 4000, fov: 40 },
        });
        engine.gpu.pushErrorScope('validation');
        black = engine.gpu.createTexture({
          size: [4, 4],
          format: 'r8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        engine.lighting.direction.set([0.3, 0.5, -0.6, 1]);
        engine.lighting.radiance.set([1, 1, 1, 1]);
        water = Water.attach(engine, { size: [400, 400], segments: 512, waves, chop, color: [0.018, 0.04, 0.036] });
        taa =
          mode === 'plain'
            ? TAA.attach(engine)
            : mode === 'combined'
              ? TAA.attach(engine, { reactive: () => black })
              : undefined;
        water.setTime(31.7);
        await waitForPipelines(async () => {
          engine.render({ delta: 0 });
          await engine.gpu.queue.onSubmittedWorkDone();
        });
        water.setTime(31.7);
      };
      const run = async (delta, frames) => {
        for (let f = 0; f < frames; f++) {
          engine.render({ delta });
          await engine.gpu.queue.onSubmittedWorkDone();
        }
      };
      const readReactive = async () => {
        const texture = water.reactiveTexture;
        if (!texture) return null;
        const device = engine.gpu,
          count = texture.width * texture.height,
          out = device.createBuffer({ size: count * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
          read = device.createBuffer({ size: count * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
          module = device.createShaderModule({
            code: `@group(0) @binding(0) var mask:texture_2d<f32>;
@group(0) @binding(1) var<storage,read_write> out:array<f32>;
@compute @workgroup_size(64) fn copy(@builtin(global_invocation_id) id:vec3u){
 let size=textureDimensions(mask);if(id.x>=size.x*size.y){return;}
 out[id.x]=textureLoad(mask,vec2i(i32(id.x%size.x),i32(id.x/size.x)),0).r;
}`,
          }),
          pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'copy' } }),
          group = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: texture.createView() },
              { binding: 1, resource: { buffer: out } },
            ],
          }),
          encoder = device.createCommandEncoder(),
          pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(Math.ceil(count / 64));
        pass.end();
        encoder.copyBufferToBuffer(out, 0, read, 0, out.size);
        device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const values = Array.from(new Float32Array(read.getMappedRange()));
        read.unmap();
        out.destroy();
        read.destroy();
        // Means over the top tenth (sky) and the lower third (near sea).
        const band = (y0, y1) => {
          let s = 0,
            n = 0;
          for (let y = Math.floor(y0 * texture.height); y < Math.floor(y1 * texture.height); y++)
            for (let x = 0; x < texture.width; x++) {
              s += values[y * texture.width + x];
              n++;
            }
          return s / n;
        };
        return { sky: band(0, 0.1), near: band(2 / 3, 1) };
      };
      const close = async () => {
        taa?.dispose();
        water.dispose();
        black.destroy();
        const error = await engine.gpu.popErrorScope();
        engine.dispose();
        return error?.message ?? null;
      };
      window.nearTest = { open, run, readReactive, close, FRAMES };
    },
    { compat, WIDTH, HEIGHT, FRAMES },
  );
  const shot = async () => decodePNG(await page.locator('canvas').screenshot());
  const near = (png) => fine(png, Math.floor((png.height * 2) / 3), png.height);
  const frame = async (chop, mode) => {
    await page.evaluate(({ chop, mode }) => window.nearTest.open({ chop, mode }), { chop, mode });
    await page.evaluate(() => window.nearTest.run(1 / 30, window.nearTest.FRAMES));
    const png = await shot();
    const mask = await page.evaluate(() => window.nearTest.readReactive());
    let still = null;
    if (mode === 'none' && chop > 0) {
      await page.evaluate(() => window.nearTest.run(0, 1));
      still = await page.evaluate(() => window.nearTest.readReactive());
    }
    const error = await page.evaluate(() => window.nearTest.close());
    assert.equal(error, null, `GPU error at chop ${chop}, ${mode}`);
    return { detail: near(png), mask, still };
  };

  // (a) Near detail.
  const calm = await frame(0, 'none'),
    windy = await frame(0.75, 'none');
  console.log(`near fine relief: chop 0 ${calm.detail.toFixed(3)}, chop 0.75 ${windy.detail.toFixed(3)}`);
  assert.ok(windy.detail >= 6, `chop 0.75 near relief is ${windy.detail} levels, under 6: no gravity-capillary waves`);
  // (b) Reactive mask.
  assert.ok(windy.mask, 'Water.reactiveTexture is undefined after a frame');
  console.log(
    `reactive: moving near ${windy.mask.near.toFixed(3)}, sky ${windy.mask.sky.toFixed(3)}; still near ${windy.still.near.toFixed(3)}`,
  );
  assert.ok(windy.mask.near >= 0.95, `moving near sea's reactive mask is ${windy.mask.near}, not 1`);
  assert.equal(windy.mask.sky, 0, 'reactive mask set above the horizon');
  assert.equal(windy.still.near, 0, 'reactive mask set with nothing moving');
  // (c) TAA keeps the near detail with nothing wired.
  const plain = await frame(0.75, 'plain'),
    combined = await frame(0.75, 'combined');
  console.log(
    `TAA near relief: none ${windy.detail.toFixed(3)}, plain ${plain.detail.toFixed(3)} (${(plain.detail / windy.detail).toFixed(2)}), combined ${combined.detail.toFixed(3)} (${(combined.detail / windy.detail).toFixed(2)})`,
  );
  assert.ok(
    plain.detail >= 0.8 * windy.detail,
    `TAA.attach(engine) keeps ${plain.detail} of ${windy.detail}: it did not read Water's published mask`,
  );
  assert.ok(
    combined.detail >= 0.8 * windy.detail,
    `TAA with its own mask too keeps ${combined.detail} of ${windy.detail}`,
  );
  assert.deepEqual(errors, []);
  console.log(`water near detail check passed${compat ? ' (WebGL2 layer)' : ''}`);
} finally {
  await closeAll({ browser });
}
