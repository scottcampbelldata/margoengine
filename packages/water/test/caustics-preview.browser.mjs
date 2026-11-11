import { fileURLToPath } from 'node:url';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const wind = Number(
  (await readFile(new URL('./data/46042-20230101.txt', import.meta.url), 'utf8'))
    .trim()
    .split('\n')[2]
    .trim()
    .split(/\s+/)[6],
);
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' });
try {
  await browser.page.evaluate(async (wind) => {
    const { EngineKernel, box, PbrMaterial } = await import('/packages/core/dist/index.js');
    const { FFTOcean } = await import('/packages/water/dist/fft.js');
    const { Caustics } = await import('/packages/water/dist/caustics.js');
    const { Shadows } = await import('/packages/shadows/dist/index.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:640px;height:400px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 8,
      camera: { position: [8, -1, 12], target: [0, -5, 0], near: 0.1, far: 150 },
    });
    engine.lighting.direction.set([1, 3, 1, 1]);
    engine.lighting.radiance.set([1, 0.96, 0.86, 0.3]);
    const meshes = [];
    for (const [size, color, position] of [
      [[80, 0.2, 80], '#cbbb93', [0, -6, 0]],
      [[3, 3, 3], '#c84e25', [-4, -4.4, 0]],
      [[2, 5, 2], '#6e8d72', [4, -3.4, -6]],
      [[7, 0.3, 7], '#b8aaa0', [0, 3, -8]],
    ])
      meshes.push(
        engine
          .createMesh()
          .setGeometry(box(...size))
          .setMaterial(new PbrMaterial({ color, roughness: 0.9 }))
          .setPosition(position),
      );
    const shadows = Shadows.attach(engine, { resolution: 512, cascades: 1, filter: 'pcf', distance: 100 });
    for (const m of meshes) shadows.add(m);
    const ocean = FFTOcean.attach(engine, {
      resolution: 64,
      cascades: [
        { length: 128, minWavelength: 16 },
        { length: 32, minWavelength: 2, maxWavelength: 16 },
        { length: 8, maxWavelength: 2 },
      ],
      windSpeed: wind,
      size: 40,
      segments: 256,
      followCamera: false,
    });
    const options = {
      surface: ocean,
      shadows,
      size: 32,
      heightRange: [-8, 0],
      intensity: 0.8,
      absorption: [0.08, 0.03, 0.015],
    };
    Caustics.attach(engine, options);
    window.preview = { engine, ocean, options };
  }, wind);
  await mkdir('test-results/batch234', { recursive: true });
  for (const [name, time, enabled] of [
    ['independent-on', 3, true],
    ['independent-off', 3, false],
    ['independent-animated', 5, true],
  ]) {
    await browser.page.evaluate(
      async ({ time, enabled }) => {
        const { engine, ocean, options } = window.preview;
        const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
        ocean.setTime(time);
        options.enabled = enabled;
        await waitForPipelines(async () => {
          engine.render({ delta: 0 });
          await engine.gpu.queue.onSubmittedWorkDone();
        });
      },
      { time, enabled },
    );
    await browser.page.locator('canvas').screenshot({ path: `test-results/batch234/caustics-${name}.png` });
  }
  await writeFile(
    `test-results/batch234/caustics-preview-${browser.hardware?.compat ? 'compat' : 'webgpu'}.json`,
    JSON.stringify({ hardware: browser.hardware, wind }, null, 2),
  );
  await browser.page.evaluate(() => window.preview.engine.dispose());
} finally {
  await browser.close();
}
