// The photographed sky and its water reflection use the same compass heading.
// The callback form used by Sky has its original longitude convention.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' });
const { page } = browser;
try {
  await page.evaluate(async () => {
    const { EngineKernel } = await import('/packages/core/dist/index.js');
    const { Environment, EnvironmentBackground } = await import('/packages/environment/dist/index.js');
    const { Water } = await import('/packages/water/dist/index.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:480px;height:320px';
    document.body.append(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 4,
      camera: { position: [0, 1.2, 6], target: [0, 1.2, -18], near: 0.1, far: 300 },
    });
    window.skyTest = { engine };
    engine.lighting.direction.set([0, 1, 0, 0]);
    engine.lighting.radiance.set([0, 0, 0, 0.28]);
    engine.gpu.pushErrorScope('validation');
    const width = 64;
    const height = 32;
    const data = new Float32Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const u = (x + 0.5) / width;
        const color = u < 0.36 ? [0.65, 0.015, 0.015] : u < 0.64 ? [0.015, 0.015, 0.65] : [0.015, 0.65, 0.015];
        data.set([...color, 1], (y * width + x) * 4);
      }
    }
    const sky = await Environment.attach(
      engine,
      { width, height, data },
      { size: 16, specularSize: 16, float32: false },
    );
    EnvironmentBackground.attach(engine, sky);
    const sea = Water.attach(engine, {
      horizon: true,
      size: [160, 160],
      segments: 24,
      color: [0, 0, 0],
      waves: [{ direction: [1, 0], amplitude: 0, wavelength: 8 }],
      lights: [],
      reflection: () => sky.equirectTexture,
    });
    Object.assign(window.skyTest, { sky, sea });
  });

  const frame = async (model, rotation, color = [0, 0, 0], radianceScale = 1) => {
    await page.evaluate(
      async ({ model, rotation, color, radianceScale }) => {
        const { engine, sky, sea } = window.skyTest;
        sea.options.reflectionEnvironment = model ? sky : undefined;
        sky.rotation = rotation;
        sky.radianceScale = radianceScale;
        sea.setColor(color);
        const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
        await waitForPipelines(async () => {
          engine.render({ delta: 0 });
          await engine.gpu.queue.onSubmittedWorkDone();
        });
      },
      { model, rotation, color, radianceScale },
    );
    const png = await decodePNG(await page.locator('canvas').screenshot());
    const rgb = (y) => [
      ...png.data.subarray((y * png.width + png.width / 2) * 4, (y * png.width + png.width / 2) * 4 + 3),
    ];
    return [rgb(147), rgb(174), rgb(295)];
  };
  const legacy = await frame(false, 0);
  const initial = await frame(true, 0);
  const turned = await frame(true, Math.PI / 2);
  const dominant = (rgb) => rgb.indexOf(Math.max(...rgb));
  assert.deepEqual(legacy.slice(0, 2).map(dominant), [2, 0], 'the Sky callback retains its historic +X-centred map');
  assert.deepEqual(initial.slice(0, 2).map(dominant), [2, 2], 'forward sky and reflected sky use the same longitude');
  assert.deepEqual(
    turned.slice(0, 2).map(dominant),
    [1, 1],
    'turning the HDR environment also turns the water reflection',
  );
  // The coloured body minus a black body isolates transmitted radiance at the same Fresnel angle.
  const linear = (v) => (v <= 10 ? v / 3294.6 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  const body = async (scale) => {
    const black = await frame(true, 0, [0, 0, 0], scale);
    const tinted = await frame(true, 0, [0.04, 0.08, 0.14], scale);
    return linear(tinted[2][2]) - linear(black[2][2]);
  };
  const dimBody = await body(0.5);
  const brightBody = await body(1);
  assert.ok(dimBody > 0.005 && brightBody > dimBody * 1.5, `HDR illuminates the water body: ${dimBody}, ${brightBody}`);
  const validation = await page.evaluate(async () => (await window.skyTest.engine.gpu.popErrorScope())?.message);
  assert.equal(validation, undefined);
  console.log(JSON.stringify({ legacy, initial, turned, dimBody, brightBody }));
} finally {
  await page.evaluate(() => window.skyTest?.engine.dispose());
  await closeAll({ browser });
}
