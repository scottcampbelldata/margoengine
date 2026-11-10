// Real-WebGPU check of @margoengine/clustered/stochastic (after npm run build:packages; takes the GPU lock).
// A core floor under a pillar and eight posts, lit by 12 white point lights that cast LocalShadows, rendered by a real engine:
// 1. With StochasticLights (2 samples, quad sharing, a new pattern each frame) the shaders compile and render without a
//    validation error; with quad false too.
// 2. The mean of 64 stochastic frames matches the exact picture: mean absolute difference under 1.5 of 255 and the
//    picture's mean within 1%; one stochastic frame is noisier than the 64-frame mean (the noise averages away).
// 3. With samples 8 and 6 shadowed lights every pixel is exact: within 1 of 255 of the exact picture everywhere.
// Run: node scripts/stochastic-lights-gpu-check.js
import assert from 'node:assert/strict';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';

const release = await acquire({ owner: 'stochastic-lights-gpu-check' });
let browser;
try {
  browser = await openBrowser({ startPath: '/tests/modern-game.html', port: 5243 });
  assert.equal(browser.hardware.webgpu?.fallback, false, 'Physical GPU required');
  const got = await browser.page.evaluate(async () => {
    const { EngineKernel } = await import('/packages/core/dist/index.js'),
      core = await import('/packages/core/dist/extension.js'),
      { Clustered } = await import('/packages/clustered/dist/index.js'),
      { LocalShadows } = await import('/packages/clustered/dist/shadows.js'),
      { StochasticLights } = await import('/packages/clustered/dist/stochastic.js');
    const width = 128,
      canvas = document.createElement('canvas');
    canvas.style.cssText = `width:${width}px;height:${width}px`;
    canvas.width = canvas.height = width;
    document.body.append(canvas);
    const instance = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 8,
        camera: { position: [0, 7, 5], target: [0, 0, 0], fov: 50, near: 0.1, far: 40 },
      }),
      engine = core.engineRuntime(instance),
      device = engine.gpu,
      uncaptured = [];
    instance.stop();
    // Only the point lights: no sun, little ambient.
    engine.lighting.radiance.set([0, 0, 0, 0.02]);
    device.addEventListener('uncapturederror', (event) => uncaptured.push(event.error.message));
    const grey = new core.PbrMaterial({ color: [0.7, 0.7, 0.7], roughness: 0.8 }),
      floor = instance.createMesh().setGeometry(core.box()).setScale([10, 0.2, 10]).setPosition([0, -0.1, 0]),
      // A pillar inside the ring of lights and eight posts outside it.
      blocks = [
        [0, 0, 0.8],
        ...Array.from({ length: 8 }, (_, i) => [
          2.3 * Math.cos((i + 0.5) * 0.785),
          2.3 * Math.sin((i + 0.5) * 0.785),
          0.35,
        ]),
      ].map(([x, z, size]) =>
        instance.createMesh().setGeometry(core.box()).setScale([size, 2, size]).setPosition([x, 1, z]),
      );
    floor.setMaterial(grey);
    for (const block of blocks) block.setMaterial(grey);
    const ring = (count, radius, height) =>
      Array.from({ length: count }, (_, i) => {
        const a = (i / count) * Math.PI * 2;
        return {
          position: [Math.cos(a) * radius, height + (i % 3) * 0.3, Math.sin(a) * radius],
          range: 9,
          intensity: 0.3 + 0.1 * (i % 4),
          castShadow: true,
        };
      });
    const context = canvas.getContext('webgpu'),
      format = navigator.gpu.getPreferredCanvasFormat(),
      bytesPerRow = width * 4;
    let current;
    context.configure({ device, format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const getCurrentTexture = context.getCurrentTexture.bind(context);
    context.getCurrentTexture = () => (current = getCurrentTexture());
    const render = async () => {
      const read = device.createBuffer({
        size: bytesPerRow * width,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      instance.render({ culling: false });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: current }, { buffer: read, bytesPerRow }, [width, width]);
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const bytes = new Uint8Array(read.getMappedRange()).slice();
      read.destroy();
      const rgb = new Float64Array(width * width * 3);
      for (let i = 0, j = 0; i < bytes.length; i += 4) for (let k = 0; k < 3; k++) rgb[j++] = bytes[i + k];
      return rgb;
    };
    const average = async (frames) => {
      const sum = new Float64Array(width * width * 3);
      for (let f = 0; f < frames; f++) (await render()).forEach((v, i) => (sum[i] += v / frames));
      return sum;
    };
    const setup = (lights) => {
      const lit = Clustered.attach(instance, { grid: [4, 4, 4] });
      lit.setLights(lights);
      const local = LocalShadows.attach(instance, { lights: lit, resolution: 256, maxLights: 16 });
      local.add(floor);
      for (const block of blocks) local.add(block);
      return { lit, local };
    };
    const out = {};
    let scene = setup(ring(12, 1.4, 0.8));
    out.exact = await render();
    scene.local.dispose();
    out.unshadowed = await render();
    scene.local = LocalShadows.attach(instance, { lights: scene.lit, resolution: 256, maxLights: 16 });
    scene.local.add(floor);
    for (const block of blocks) scene.local.add(block);
    out.repeat = (await render()).every((v, i) => v === out.exact[i]);
    let sampled = StochasticLights.attach(instance, { lights: scene.lit });
    out.one = await render();
    out.mean = await average(64);
    out.shader = sampled.lights.pbr(0).declarations.includes('clusterStochasticQuad(vec4f');
    sampled.dispose();
    sampled = StochasticLights.attach(instance, { lights: scene.lit, quad: false });
    out.unquad = await average(16);
    sampled.dispose();
    scene.local.dispose();
    scene.lit.dispose();
    scene = setup(ring(6, 1.4, 0.8));
    out.exactFew = await render();
    sampled = StochasticLights.attach(instance, { lights: scene.lit, samples: 8 });
    out.few = await render();
    sampled.dispose();
    scene.local.dispose();
    scene.lit.dispose();
    instance.dispose();
    canvas.remove();
    for (const key of Object.keys(out)) if (out[key] instanceof Float64Array) out[key] = Array.from(out[key]);
    return { ...out, uncaptured };
  });
  assert.deepEqual(got.uncaptured, [], 'no validation or compilation error');
  assert.ok(got.shader, 'the composed shader shares estimates across the quad');
  const meanOf = (a) => a.reduce((s, v) => s + v, 0) / a.length,
    diff = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length,
    maxDiff = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);
  const exactMean = meanOf(got.exact),
    shadowed = got.exact.filter((v, i) => v !== got.one[i]).length;
  assert.ok(exactMean > 20, `the lights reach the floor: mean ${exactMean}`);
  assert.ok(got.repeat, 'the exact picture renders the same twice');
  const shadowDepth = diff(got.unshadowed, got.exact);
  assert.ok(shadowDepth > 5, `the shadows darken the picture: mean ${shadowDepth} of 255`);
  assert.ok(shadowed > 0, 'a single stochastic frame differs from the exact picture somewhere (12 lights > 2 samples)');
  const oneError = diff(got.one, got.exact),
    meanError = diff(got.mean, got.exact),
    unquadError = diff(got.unquad, got.exact);
  // Quantisation alone gives up to 0.5 of 255 per frame; the ratio estimator is consistent, with a small bias where the
  // quad's four pixels see different shadows (one pixel of blur at shadow edges inside a triangle).
  assert.ok(meanError < 1.5, `64-frame mean within 1.5 of 255 of the exact picture: ${meanError}`);
  assert.ok(Math.abs(meanOf(got.mean) - exactMean) < 0.01 * exactMean, `mean ${meanOf(got.mean)} vs ${exactMean}`);
  assert.ok(oneError > meanError, `the noise averages away: one frame ${oneError}, 64 frames ${meanError}`);
  assert.ok(unquadError < 3, `quad false also converges: ${unquadError}`);
  const fewError = maxDiff(got.few, got.exactFew);
  assert.ok(fewError <= 1, `6 lights with 8 samples are exact: worst ${fewError} of 255`);
  console.log(
    `stochastic lights on ${browser.hardware.webgpu?.vendor} ${browser.hardware.webgpu?.architecture}: 12 shadowed lights, 2 lookups per pixel; mean |error| one frame ${oneError.toFixed(2)}, 64 frames ${meanError.toFixed(2)}, 16 frames without the quad ${unquadError.toFixed(2)} of 255 (picture mean ${exactMean.toFixed(1)}, shadows take ${shadowDepth.toFixed(1)}); 6 lights exact within ${fewError}`,
  );
} finally {
  await browser?.close();
  release();
}
