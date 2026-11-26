// KB-WATER-WHITEWATERLIGHT1 regression: white water is a bright layer of bubbles lit from above by the sky, with the
// relief of a broken bore. In the Kitty Hawk s18 shot it was lit as a flat sheet, every pixel of dense foam the same
// grey, about as bright as the sky the water around it reflected; and surf or shoreline foam on a sea without whitecaps
// took no sky light at all, only the scene's ambient. Both cases here are seen from straight above under a uniform grey
// HDR sky of radiance L, with no sun and no ambient, on WebGPU or (MARGO_COMPAT=1) the WebGL2 compatibility layer. The
// water's own foam buffer says which pixels are dense foam, and the foam's radiance is backed out of each such pixel's
// colour: F = (pixel - (1 - foam) W) / foam, W being the open water's radiance.
// (a) Whitecaps on an open sea, drawn with no post effect, so the display transform can be undone: dense foam returns
//     up to Kokhanovsky's deep-layer reflectance, so its brightest twentieth reaches 0.78 L (the flat sheet held 0.72 L
//     everywhere), never more than L, and it varies from lump to hollow (coefficient of variation at least 0.04; the
//     flat sheet's was quantisation, under 0.01).
// (b) Surf on a 1:50 beach with no whitecaps and no wind: its foam is lit by the sky, many times brighter than the dark
//     water round it (it was black: no ambient, no sun, no sky).
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const compat = process.env.MARGO_COMPAT === '1' || process.argv.includes('--compat');
const WIDTH = 320,
  HEIGHT = 240,
  L = 0.5;
const browser = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' }),
  { page } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
const toLinear = (v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
// Khronos PBR Neutral below its 0.76 knee only subtracts 0.04 once every channel is past 0.08 (packages/shared/display.js).
const undoNeutral = (x) => (x >= 0.08 - 0.0004 ? x + 0.04 : x);
try {
  const result = await page.evaluate(
    async ({ compat, WIDTH, HEIGHT, L }) => {
      if (compat) await (await import('/packages/webgl2-compat/dist/index.js')).install({ force: true });
      const { EngineKernel } = await import('/packages/core/dist/index.js'),
        { Water } = await import('/packages/water/dist/index.js'),
        { Environment } = await import('/packages/environment/dist/index.js'),
        { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
      const canvas = document.createElement('canvas');
      canvas.style.cssText = `width:${WIDTH}px;height:${HEIGHT}px`;
      document.body.append(canvas);
      const engine = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 16,
        camera: { position: [0, 40, 0.01], target: [0, 0, 0], near: 0.1, far: 2000 },
      });
      const device = engine.gpu;
      device.pushErrorScope('validation');
      // No sun and no ambient: the sky is the only light.
      engine.lighting.direction.set([0.3, 0.8, 0.2, 0]);
      engine.lighting.radiance.set([0, 0, 0, 0]);
      const data = new Float32Array(64 * 32 * 4);
      for (let i = 0; i < 64 * 32; i++) data.set([L, L, L, 1], i * 4);
      const sky = await Environment.attach(engine, { width: 64, height: 32, data }, { size: 16, specularSize: 16 });
      const optics = {
        reflection: () => sky.equirectTexture,
        reflectionEnvironment: sky,
        color: [0, 0, 0],
        lights: [],
      };
      const readFoam = async (water) => {
        const view = water.view,
          texture = view.foam[1 - view.current],
          count = texture.width * texture.height,
          out = device.createBuffer({ size: count * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
          read = device.createBuffer({ size: count * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
          module = device.createShaderModule({
            code: `@group(0) @binding(0) var foam:texture_2d<f32>;
@group(0) @binding(1) var<storage,read_write> out:array<f32>;
@compute @workgroup_size(64) fn copy(@builtin(global_invocation_id) id:vec3u){
 let size=textureDimensions(foam);if(id.x>=size.x*size.y){return;}
 out[id.x]=textureLoad(foam,vec2i(i32(id.x%size.x),i32(id.x/size.x)),0).r;
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
        return { width: texture.width, height: texture.height, values };
      };
      const draw = async () => {
        await waitForPipelines(async () => {
          engine.render({ delta: 0 });
          await device.queue.onSubmittedWorkDone();
        });
      };
      // (a) Whitecaps on the open sea, no post.
      // A steep wind sea that breaks (as whitecaps.browser.mjs).
      const sea = Water.attach(engine, {
        size: [400, 400],
        segments: 128,
        waves: [
          { direction: [-0.8, -0.6], amplitude: 1, wavelength: 60, steepness: 0.5, phase: 0.4 },
          { direction: [-0.95, -0.2], amplitude: 0.85, wavelength: 12, steepness: 0.3, phase: 4.3 },
        ],
        whitecaps: 1,
        ...optics,
      });
      sea.setTime(47.3);
      await draw();
      window.whitewater = { engine, sea, sky, readFoam, draw };
      return { sea: await readFoam(sea) };
    },
    { compat, WIDTH, HEIGHT, L },
  );
  const seaPixels = await decodePNG(await page.locator('canvas').screenshot());
  const beach = await page.evaluate(async () => {
    const { engine, sea, sky, readFoam, draw } = window.whitewater;
    sea.dispose();
    const { Water } = await import('/packages/water/dist/index.js'),
      { Bloom } = await import('/packages/post/dist/index.js'),
      { TerrainHeightmap } = await import('/packages/terrain/dist/index.js');
    const device = engine.gpu;
    const post = Bloom.attach(engine, { strength: 0, exposure: 0 });
    // Shore at x = 0, the sea toward +x: 1:50 below the waterline, 1:28 above it (as surf-crests.browser.mjs).
    const ground = (x) => (x > 0 ? -x / 50 : -x / 28);
    const terrain = TerrainHeightmap.attach(engine, (x) => ground(x), {
      size: [240, 320],
      origin: [-40, -160],
      resolution: 512,
    });
    const scene = device.createTexture({
      size: [engine.canvas.width, engine.canvas.height],
      format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    engine.camera.position = [32, 40, 0.01];
    engine.camera.target = [32, 0, 0];
    const surf = Water.attach(engine, {
      size: [1200, 1200],
      segments: 128,
      horizon: true,
      terrain: { heightmap: () => terrain.texture, origin: [-40, -160], size: [240, 320] },
      depth: () => post.depthTexture,
      sceneColor: () => scene,
      waves: [
        { direction: [-0.97, 0.24], amplitude: 0.45, wavelength: 72, steepness: 0.45, phase: 0.4 },
        { direction: [-0.88, -0.47], amplitude: 0.24, wavelength: 41, steepness: 0.45, phase: 2.2 },
      ],
      reflection: () => sky.equirectTexture,
      reflectionEnvironment: sky,
      color: [0, 0, 0],
      lights: [],
    });
    surf.setTime(47.3);
    await draw();
    const foam = await readFoam(surf);
    const validation = (await device.popErrorScope())?.message;
    window.whitewater.dispose = () => {
      scene.destroy();
      engine.dispose();
    };
    return { foam, validation };
  });
  const beachPixels = await decodePNG(await page.locator('canvas').screenshot());
  await page.evaluate(() => window.whitewater.dispose());
  assert.equal(beach.validation, undefined, beach.validation);
  assert.deepEqual(errors, []);

  // Per pixel: foam amount and the colour's luminance (display-linear, or linear radiance where `undo` is given).
  const samples = (foam, png, undo) => {
    assert.equal(png.width, foam.width, 'the canvas and the foam buffer differ in size');
    assert.equal(png.height, foam.height, 'the canvas and the foam buffer differ in size');
    const out = [];
    for (let y = 4; y < png.height - 4; y++)
      for (let x = 4; x < png.width - 4; x++) {
        const o = (y * png.width + x) * 4,
          rgb = [0, 1, 2].map((c) => toLinear(png.data[o + c])).map(undo ?? ((v) => v));
        out.push([foam.values[y * png.width + x], 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]]);
      }
    return out;
  };
  const foamRadiance = (pixels) => {
    const open = pixels.filter(([f]) => f < 0.01).map(([, v]) => v);
    open.sort((a, b) => a - b);
    const water = open[Math.floor(open.length / 2)] ?? 0,
      dense = pixels.filter(([f]) => f >= 0.85).map(([f, v]) => (v - (1 - f) * water) / f);
    dense.sort((a, b) => a - b);
    const mean = dense.reduce((s, v) => s + v, 0) / Math.max(1, dense.length),
      deviation = Math.sqrt(dense.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, dense.length));
    return {
      water,
      count: dense.length,
      openCount: open.length,
      mean,
      p95: dense[Math.floor(dense.length * 0.95)] ?? 0,
      max: dense[dense.length - 1] ?? 0,
      variation: deviation / Math.max(mean, 1e-6),
    };
  };
  const a = foamRadiance(samples(result.sea, seaPixels, undoNeutral)),
    b = foamRadiance(samples(beach.foam, beachPixels));
  console.log(
    `whitewater light${compat ? ' (WebGL2 layer)' : ''}: sea ${JSON.stringify(a, (k, v) => (typeof v === 'number' ? +v.toFixed(4) : v))}; surf ${JSON.stringify(b, (k, v) => (typeof v === 'number' ? +v.toFixed(4) : v))}`,
  );
  assert.ok(a.count >= 100 && a.openCount >= 100, `the sea shows ${a.count} dense foam and ${a.openCount} open pixels`);
  assert.ok(
    b.count >= 100 && b.openCount >= 100,
    `the surf shows ${b.count} dense foam and ${b.openCount} open pixels`,
  );
  // (a) A deep bubble layer under a sky of radiance L: up to about 0.86 L, never past L.
  assert.ok(
    a.p95 >= 0.78 * L,
    `dense whitecap foam's brightest twentieth is ${(a.p95 / L).toFixed(3)} L, under 0.78 L`,
  );
  assert.ok(a.max <= 1.0 * L, `dense whitecap foam returns ${(a.max / L).toFixed(3)} L, more than the sky gives`);
  // Lumps and hollows: not one flat grey.
  assert.ok(a.variation >= 0.04, `dense whitecap foam is one flat tone (variation ${a.variation.toFixed(4)})`);
  // (b) Surf foam with no whitecaps takes the sky's light.
  assert.ok(
    b.mean >= 5 * Math.max(b.water, 0.002),
    `surf foam ${b.mean.toFixed(4)} against water ${b.water.toFixed(4)}`,
  );
  assert.ok(b.variation >= 0.04, `dense surf foam is one flat tone (variation ${b.variation.toFixed(4)})`);
} finally {
  await closeAll({ browser });
}
