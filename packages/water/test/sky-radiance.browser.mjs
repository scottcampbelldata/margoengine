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
  await page.evaluate(async () => {
    const { engine, sea } = window.skyTest;
    const { Environment } = await import('/packages/environment/dist/index.js');
    const width = 64;
    const height = 64;
    const data = new Float32Array(width * height * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const color = y < 28 ? [1, 0.01, 0.01, 1] : [0, 0.02, 0.24, 1];
        data.set(color, (y * width + x) * 4);
      }
    const levels = await Environment.attach(
      engine,
      { width, height, data },
      { name: 'reflection-elevation', size: 16, specularSize: 16 },
    );
    sea.options.reflection = () => levels.equirectTexture;
  });
  await page.evaluate(() => window.skyTest.sea.setGlitterRoughness(0.12));
  const narrow = (await frame(false, 0))[1];
  await page.evaluate(() => window.skyTest.sea.setGlitterRoughness(0.6));
  const wide = (await frame(false, 0))[1];
  assert.ok(
    wide[0] > narrow[0] + 20 && narrow[2] > narrow[0] + 20,
    `The callback reflection lobe must sample the red sky above its blue horizon: ${narrow} to ${wide}`,
  );
  // KB-WATER-HORIZONBAND1: a map whose rows below the horizon are red (what a sky environment holds there, its ground or
  // a horizon of another colour) and above it grey. The sea's grazing rows reflect the horizon, and a horizon tap must
  // read the rows above it alone: the bilinear filter at v 0.5 (or 0.49 for the 0.02 lift) took half (or 0.29) of
  // the first row below, a red band along the sea's far edge.
  await page.evaluate(async () => {
    const { engine, sky, sea } = window.skyTest;
    const { Environment } = await import('/packages/environment/dist/index.js');
    const width = 64;
    const height = 32;
    const data = new Float32Array(width * height * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) data.set(y < 16 ? [0.2, 0.2, 0.2, 1] : [1, 0.01, 0.01, 1], (y * width + x) * 4);
    const band = await Environment.attach(
      engine,
      { width, height, data },
      { name: 'reflection-horizon', size: 16, specularSize: 16, float32: false },
    );
    sea.options.reflection = () => band.equirectTexture;
    sea.setGlitterRoughness(0.12);
    Object.assign(window.skyTest, { band, oldSky: sky });
  });
  const farRows = async (model) => {
    await page.evaluate((model) => {
      const { sea, band } = window.skyTest;
      sea.options.reflectionEnvironment = model ? band : undefined;
    }, model);
    await frame(false, 0);
    const png = await decodePNG(await page.locator('canvas').screenshot()),
      centre = Math.floor(png.height / 2),
      rows = [];
    for (let y = centre + 2; y < centre + 14; y++) {
      const i = (y * png.width + png.width / 2) * 4;
      rows.push([png.data[i], png.data[i + 1], png.data[i + 2]]);
    }
    return rows;
  };
  for (const model of [false, true]) {
    const rows = await farRows(model);
    for (const [r, g] of rows)
      assert.ok(
        r - g < 12,
        `${model ? 'the HDR' : 'the callback'} sea's far rows reflect the grey above the horizon, not the red below it: ${JSON.stringify(rows)}`,
      );
  }
  const validation = await page.evaluate(async () => (await window.skyTest.engine.gpu.popErrorScope())?.message);
  assert.equal(validation, undefined);
  console.log(JSON.stringify({ legacy, initial, turned, dimBody, brightBody, narrow, wide }));
} finally {
  await page.evaluate(() => window.skyTest?.engine.dispose());
  await closeAll({ browser });
}
