import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
// Existing NOAA/NDBC public-domain real wind forcing; source/licence in test/data/README.md.
const wind = Number(
  (await readFile(new URL('./data/46042-20230101.txt', import.meta.url), 'utf8'))
    .trim()
    .split('\n')[2]
    .trim()
    .split(/\s+/)[6],
);
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' });
const errors = [];
browser.page.on('pageerror', (e) => errors.push(e.message));
try {
  await browser.page.evaluate(async (wind) => {
    const { EngineKernel, box, PbrMaterial } = await import('/packages/core/dist/index.js');
    const { FFTOcean } = await import('/packages/water/dist/fft.js');
    const { Underwater } = await import('/packages/water/dist/underwater.js');
    const { Caustics } = await import('/packages/water/dist/caustics.js');
    const { PostStack } = await import('/packages/post/dist/stack.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:640px;height:400px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 8,
      camera: { position: [5, -2, 8], target: [0, 0, -5], near: 0.1, far: 150 },
    });
    engine.lighting.direction.set([0.3, 1, 0.2, 3]);
    engine.lighting.radiance.set([1, 0.96, 0.86, 0.3]);
    for (const [size, color, position] of [
      [[80, 0.2, 80], '#cbbb93', [0, -6, 0]],
      [[3, 3, 3], '#d34620', [-4, -4.4, 0]],
      [[2, 5, 2], '#518d72', [4, -3.4, -6]],
      [[6, 3, 2], '#d9cba0', [0, 3, -12]],
    ])
      engine
        .createMesh()
        .setGeometry(box(...size))
        .setMaterial(new PbrMaterial({ color, roughness: 0.9 }))
        .setPosition(position);
    const ocean = FFTOcean.attach(engine, {
      resolution: 64,
      cascades: [
        { length: 128, minWavelength: 16 },
        { length: 32, minWavelength: 2, maxWavelength: 16 },
        { length: 8, maxWavelength: 2 },
      ],
      windSpeed: wind,
      size: 80,
      segments: 256,
      followCamera: false,
    });
    const caustics = new Caustics({
      surface: ocean,
      size: 48,
      heightRange: [-8, 0],
      intensity: 0.8,
      absorption: [0.08, 0.03, 0.015],
    });
    const underwater = new Underwater({
      surface: ocean,
      absorption: [0.08, 0.03, 0.015],
      scattering: [0.015, 0.025, 0.03],
    });
    PostStack.attach(engine, [caustics, underwater]);
    window.preview = { engine, ocean };
  }, wind);
  await mkdir('test-results/batch234', { recursive: true });
  const mode = browser.hardware?.compat ? 'compat' : 'webgpu';
  for (const [name, time, position, target] of [
    ['below', 3, [5, -2, 8], [0, 1, -5]],
    ['animated', 5, [5, -2, 8], [0, 1, -5]],
    ['split', 3, [5, 0, 8], [0, 0, -5]],
  ]) {
    await browser.page.evaluate(
      async ({ time, position, target }) => {
        const { engine, ocean } = window.preview;
        const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
        engine.camera.position = position;
        engine.camera.target = target;
        ocean.setTime(time);
        await waitForPipelines(async () => {
          engine.render({ delta: 0 });
          await engine.gpu.queue.onSubmittedWorkDone();
        });
      },
      { time, position, target },
    );
    await browser.page.locator('canvas').screenshot({ path: `test-results/batch234/underwater-${name}-${mode}.png` });
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
