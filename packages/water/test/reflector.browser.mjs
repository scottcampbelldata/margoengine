import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { decodePNG } from '../../../tests/support/png.js';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
await mkdir('test-results', { recursive: true });
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' }),
  { page, hardware } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
const wind = (await readFile(new URL('./data/46042-20230101.txt', import.meta.url), 'utf8'))
  .trim()
  .split('\n')[2]
  .trim()
  .split(/\s+/)
  .map(Number)[5];
try {
  await page.evaluate(async (wind) => {
    const { EngineKernel, box, PbrMaterial } = await import('/packages/core/dist/index.js');
    const { Water } = await import('/packages/water/dist/index.js');
    const { Reflector } = await import('/packages/environment/dist/reflector.js');
    const { WaterReflection } = await import('/packages/water/dist/reflector.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:256px;height:192px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 8,
        camera: { position: [0, 5, 12], target: [0, 0, 0], near: 0.1, far: 100 },
      }),
      gpu = engine.gpu;
    gpu.pushErrorScope('validation');
    const angle = (wind * Math.PI) / 180;
    engine.lighting.direction = [Math.sin(angle), 0.8, Math.cos(angle), 1];
    const marker = engine
      .createMesh()
      .setGeometry(box(3, 2, 3))
      .setMaterial(new PbrMaterial({ color: '#ff0808', roughness: 0.9 }))
      .setPosition([0, 9, -2]);
    const water = Water.attach(engine, {
      size: [60, 60],
      segments: 32,
      waves: [{ direction: [1, 0], amplitude: 0, wavelength: 10 }],
    });
    const mirror = Reflector.attach(engine, { width: 60, height: 60, captureOnly: true, autoUpdate: false });
    mirror.node.setRotation([-Math.PI / 2, 0, 0]);
    engine.render({ delta: 0 });
    window.reflectTest = { engine, water, mirror, marker, WaterReflection };
  }, wind);
  const baseline = await page.locator('canvas').screenshot();
  await page.evaluate(() => {
    const t = window.reflectTest;
    t.original = t.mirror.passes;
    t.adapter = t.WaterReflection.attach(t.engine, { surface: t.water, reflector: t.mirror });
    t.engine.render({ delta: 0 });
  });
  const pending = await page.locator('canvas').screenshot();
  assert.ok(baseline.equals(pending), 'unready capture falls back exactly');
  const first = await page.evaluate(() => {
    const t = window.reflectTest;
    const captured = t.mirror.update();
    t.engine.render({ delta: 0 });
    const m = t.engine.camera.matrix;
    const project = (p) => {
      const c = [0, 1, 2, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
      return [
        ((c[0] / c[3]) * 0.5 + 0.5) * t.engine.canvas.width,
        (0.5 - (c[1] / c[3]) * 0.5) * t.engine.canvas.height,
      ];
    };
    return {
      pixel: project([0, -9, -2]),
      direct: project([0, 9, -2]),
      captured,
      ready: !!t.mirror.textureMatrix,
      excluded: !t.mirror.passes({ name: t.water.name + ':draw', order: 4 }),
      matches: Array.from(t.mirror.textureMatrix).every((v, i) => v === t.mirror.camera.matrix[i]),
    };
  });
  assert.equal(first.captured, true);
  assert.equal(first.ready, true);
  assert.equal(first.excluded, true);
  assert.equal(first.matches, true);
  assert.ok(first.direct[1] < 0, 'marker centre is outside the main camera');
  const reflected = await page.locator('canvas').screenshot({
    path: `test-results/water-reflector-${browser.hardware?.compat ? 'compat' : 'webgpu'}.png`,
  });
  assert.ok(!baseline.equals(reflected), 'planar scene reflection changes the water');
  const images = await Promise.all([decodePNG(baseline), decodePNG(reflected)]);
  const red = (image) => {
    let sum = 0,
      count = 0;
    const [cx, cy] = first.pixel.map(Math.round);
    for (let y = cy - 3; y <= cy + 3; y++)
      for (let x = cx - 3; x <= cx + 3; x++) {
        const i = (y * image.width + x) * 4;
        sum += image.data[i] - (image.data[i + 1] + image.data[i + 2]) * 0.5;
        count++;
      }
    return sum / count;
  };
  const redGain = red(images[1]) - red(images[0]);
  assert.ok(redGain > 3, 'offscreen red object appears at its independent mirrored projection: ' + redGain);
  // Exercise SSR capture, with independently owned MRT targets, at the scene's actual sample count.
  const lifecycle = await page.evaluate(async () => {
    const t = window.reflectTest,
      gpu = t.engine.gpu;
    let captured = false;
    const removePass = t.engine.frameGraph.add({
      name: 'water-planar-ssr-proof',
      order: 5,
      execute: (c) => {
        if (c.backend !== 'webgpu') return;
        const samples = c.descriptor.multisample?.count ?? 1;
        const images = Array.from({ length: 3 }, () =>
          gpu.createTexture({
            size: [c.width, c.height],
            format: 'rgba16float',
            sampleCount: samples,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
          }),
        );
        const depth = gpu.createTexture({
          size: [c.width, c.height],
          format: c.descriptor.depthStencil.format,
          sampleCount: samples,
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        let pass;
        const clearCapture = t.water.setCapture({
          targets: images.map(() => ({ format: 'rgba16float' })),
          declarations: () =>
            `struct MargoSSR {@location(0) specular:vec4f,@location(1) weight:vec4f,@location(2) normal:vec4f}\n`,
          begin: () => {
            pass = c.encoder.beginRenderPass({
              colorAttachments: images.map((image) => ({
                view: image.createView(),
                loadOp: 'clear',
                storeOp: 'store',
              })),
              depthStencilAttachment: {
                view: depth.createView(),
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
                depthClearValue: 0,
                stencilReadOnly: true,
              },
            });
            return pass;
          },
        });
        t.water.draw(c, 'capture');
        pass.end();
        clearCapture();
        captured = true;
        t.captureResources = [...images, depth];
      },
    });
    t.engine.render({ delta: 0 });
    await gpu.queue.onSubmittedWorkDone();
    removePass();
    for (const r of t.captureResources) r.destroy();
    const { Water } = await import('/packages/water/dist/index.js');
    const secondWater = Water.attach(t.engine, { size: [1, 1], height: -100, segments: 1 });
    const second = t.WaterReflection.attach(t.engine, { surface: secondWater, reflector: t.mirror });
    t.adapter.dispose();
    const sharedSurvives = !t.mirror.passes({ name: secondWater.name + ':draw', order: 4 });
    second.dispose();
    secondWater.dispose();
    const restoredFilter = t.mirror.passes === t.original;
    t.engine.render({ delta: 0 });
    t.adapter = t.WaterReflection.attach(t.engine, {
      surface: t.water,
      reflector: t.mirror,
      roughness: 0.25,
      distortion: 0.01,
    });
    t.adapter.onDeviceRestored(t.engine);
    t.mirror.update();
    t.engine.render({ delta: 0 });
    const validation = await gpu.popErrorScope();
    t.adapter.dispose();
    t.mirror.dispose();
    t.engine.dispose();
    return { captured, restoredFilter, sharedSurvives, validation: validation?.message };
  });
  assert.deepEqual(lifecycle, { captured: true, restoredFilter: true, sharedSurvives: true, validation: undefined });
  assert.deepEqual(errors, []);
  const report = { hardware, first, lifecycle, redGain, visibleChange: true, unreadyExact: true, windBearing: wind };
  console.log(JSON.stringify(report));
  await writeFile(
    `test-results/water-reflector-${browser.hardware?.compat ? 'compat' : 'webgpu'}.json`,
    JSON.stringify(report, null, 2),
  );
} finally {
  await browser.close();
}
