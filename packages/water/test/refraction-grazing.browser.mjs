// KB-WATER-SEABEDMAZE1 regression: a shallow seabed seen at a grazing angle through Water, as the Kitty Hawk s18 shot
// looks over the near surf. Water finds the bed its bent ray reaches in the screen's depth: a texel reprojection, then
// a widening crossing search. The reprojection does not settle on a bed seen at a shallow angle, and the crossing
// search handed its bisected crossing back to it, so a third of the water drew the flat fallback bottom in a contour
// maze of hits and misses; where the bent ray left the frame, a hard band along its foot did too. This test paints
// the bed two colours and counts the water pixels whose colour does not follow the bed (a miss), on WebGPU or with
// --compat (MARGO_COMPAT=1) the WebGL2 compatibility layer.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
await mkdir('test-results', { recursive: true });
const compat = process.argv.includes('--compat') || process.env.MARGO_COMPAT === '1';
const browser = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' });
const { page, hardware } = browser;
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.evaluate(async (compat) => {
    if (compat) await (await import('/packages/webgl2-compat/dist/index.js')).install({ force: true });
    const { Engine, box, PbrMaterial } = await import('/packages/core/dist/index.js');
    const { Water } = await import('/packages/water/dist/index.js');
    const { Bloom } = await import('/packages/post/dist/bloom.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:480px;height:270px';
    document.body.append(canvas);
    // s18's framing: 6 m up, looking 30 m out over water about a metre deep.
    const camera = { position: [0, 6, 0], target: [32, 0, 0], fov: 40, near: 0.1, far: 400 };
    const engine = await Engine.create(canvas, { backend: 'webgpu', capacity: 16, camera });
    const paint = (color) => new PbrMaterial({ color, roughness: 0.92 });
    const bed = engine
      .createMesh()
      .setGeometry(box(400, 0.1, 400))
      .setMaterial(paint('#d9d4c4'))
      .setPosition([0, -1.25, 0]);
    const post = Bloom.attach(engine, { strength: 0, exposure: 0 });
    Water.attach(engine, {
      size: [400, 400],
      segments: 128,
      // A short swell and chop: the normals vary, as over the surf.
      waves: [
        { direction: [-1, 0.2], amplitude: 0.08, wavelength: 7, steepness: 0.3 },
        { direction: [-0.6, -0.8], amplitude: 0.04, wavelength: 3.1, steepness: 0.3, phase: 1.3 },
      ],
      chop: 0.6,
      color: [0.012, 0.028, 0.042],
      lights: [],
      depth: () => post.depthTexture,
      sceneColor: () => post.sceneTexture,
    });
    engine.gpu.pushErrorScope('validation');
    const frame = async () => {
      engine.render({ delta: 0 });
      await engine.gpu.queue.onSubmittedWorkDone();
      engine.render({ delta: 0 });
      await engine.gpu.queue.onSubmittedWorkDone();
    };
    await frame();
    window.refractionGrazing = { engine, bed, frame, dark: paint('#1c1d1a') };
  }, compat);
  const capture = async (name) =>
    decodePNG(
      await page
        .locator('canvas')
        .screenshot({ path: `test-results/water-refraction-grazing-${compat ? 'compat' : 'native'}-${name}.png` }),
    );
  const light = await capture('light');
  await page.evaluate(async () => {
    const { bed, dark, frame } = window.refractionGrazing;
    bed.setMaterial(dark);
    await frame();
  });
  const dark = await capture('dark');
  const validation = await page.evaluate(async () => {
    const { engine } = window.refractionGrazing;
    const error = await engine.gpu.popErrorScope();
    engine.dispose();
    return error?.message;
  });
  // The water from below the horizon band to the foot of the frame: every pixel there sees the bed through the water.
  let total = 0,
    missed = 0,
    footMissed = 0,
    foot = 0;
  for (let y = Math.round(light.height * 0.6); y < light.height; y++) {
    for (let x = 0; x < light.width; x++) {
      const i = 4 * (y * light.width + x),
        change = Math.hypot(
          light.data[i] - dark.data[i],
          light.data[i + 1] - dark.data[i + 1],
          light.data[i + 2] - dark.data[i + 2],
        );
      total++;
      if (change < 2) missed++;
      if (y >= light.height - 12) {
        foot++;
        if (change < 2) footMissed++;
      }
    }
  }
  const result = { hardware, total, missed: missed / total, footMissed: footMissed / foot, validation, errors };
  await writeFile(
    `test-results/water-refraction-grazing-${compat ? 'compat' : 'native'}.json`,
    JSON.stringify(result, null, 2) + '\n',
  );
  assert.deepEqual(errors, []);
  assert.equal(validation, undefined);
  assert.ok(
    result.missed < 0.005,
    `the bent ray misses the bed under ${(result.missed * 100).toFixed(1)}% of the water`,
  );
  assert.ok(
    result.footMissed < 0.005,
    `the bent ray misses the bed along the foot of the frame on ${(result.footMissed * 100).toFixed(1)}% of it`,
  );
  console.log(`grazing refraction: ${(result.missed * 100).toFixed(2)}% of ${total} water pixels miss the bed`);
} finally {
  await browser.close();
}
