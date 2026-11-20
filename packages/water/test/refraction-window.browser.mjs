// Water refraction at a grazing view follows the bent ray (Snell), so ground far along the unbent eye ray does not show
// through: its light could only leave the water outside Snell's window. Regression for the blue speckles on the Storm
// Light moon path: the in-air highlights of submerged rock tens of metres off came through the sea tinted blue.
// Real WebGPU; run: node scripts/run-with-timeout.mjs -- node packages/water/test/refraction-window.browser.mjs
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

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
  const setup = await page.evaluate(async () => {
    const { EngineKernel, box, PbrMaterial } = await import('/packages/core/dist/index.js'),
      { Water } = await import('/packages/water/dist/index.js'),
      { Bloom } = await import('/packages/post/dist/bloom.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:512px;height:320px';
    document.body.append(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 16,
      camera: { position: [0, 3, 10], target: [0, -1, -25], near: 0.1, far: 200 },
    });
    const mesh = (geometry, color, at) =>
      engine
        .createMesh()
        .setGeometry(geometry)
        .setMaterial(new PbrMaterial({ color, roughness: 0.9 }))
        .setPosition(at);
    mesh(box(200, 0.2, 200), '#000000', [0, -3.1, 0]); // a black seabed 3 m down
    // A white slab 1 m under the surface, 9 m beyond where the eye ray meets the water; the bent ray reaches 1.1 m.
    mesh(box(8, 0.2, 10), '#ffffff', [0, -1.1, -25]);
    const post = Bloom.attach(engine, { strength: 0, exposure: 0 });
    const water = Water.attach(engine, {
      size: [200, 200],
      segments: 128,
      height: 0,
      depth: () => post.depthTexture,
      sceneColor: () => post.sceneTexture,
      lights: [],
      waves: [{ direction: [1, 0.3], amplitude: 0.0001, wavelength: 9, steepness: 0.01 }],
    });
    engine.gpu.pushErrorScope('validation');
    const frame = async () => {
      engine.render({ delta: 0 });
      await engine.gpu.queue.onSubmittedWorkDone();
    };
    await frame();
    const project = (p) => {
      const m = engine.camera.matrix,
        x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
      return [Math.round(((x / w) * 0.5 + 0.5) * 512), Math.round((0.5 - (y / w) * 0.5) * 320)];
    };
    window.windowTest = { engine, water, frame };
    return { slab: project([0, -1, -25]), beside: project([10, -1, -25]) };
  });
  const vendor = hardware.webgpu.vendor,
    shot = async (name) =>
      decodePNG(await page.locator('canvas').screenshot({ path: `test-results/water-window-${vendor}-${name}.png` }));
  const refracted = await shot('refracted');
  await page.evaluate(async () => {
    const t = window.windowTest;
    t.water.options.sceneColor = undefined;
    await t.frame();
  });
  const approximate = await shot('approximate');
  const validation = await page.evaluate(async () => {
    const { engine } = window.windowTest,
      error = await engine.gpu.popErrorScope();
    engine.dispose();
    return error?.message;
  });
  const mean = (image, [cx, cy], r = 2) => {
    let sum = 0,
      n = 0;
    for (let y = cy - r; y <= cy + r; y++)
      for (let x = cx - r; x <= cx + r; x++) {
        const i = (y * image.width + x) * 4;
        sum += image.data[i] + image.data[i + 1] + image.data[i + 2];
        n++;
      }
    return sum / n / 3;
  };
  const result = {
    hardware,
    setup,
    refracted: { slab: mean(refracted, setup.slab), beside: mean(refracted, setup.beside) },
    approximate: { slab: mean(approximate, setup.slab), beside: mean(approximate, setup.beside) },
    validation,
    errors,
  };
  await writeFile(`test-results/water-window-${vendor}.json`, JSON.stringify(result, null, 2));
  assert.equal(validation, undefined, 'No WebGPU validation errors');
  assert.deepEqual(errors, []);
  assert.ok(setup.slab[1] >= 140 && setup.slab[1] < 320, `The slab projects onto the water: ${setup.slab}`);
  // The slab lies far outside what the bent ray reaches from these pixels: the black seabed beside the entry point
  // shows there instead, no brighter than the approximate seabed the water draws without a scene colour.
  assert.ok(
    result.refracted.slab <= result.approximate.slab + 2,
    `Ground outside Snell's window stays hidden: refracted ${result.refracted.slab}, approximate ${result.approximate.slab}`,
  );
  console.log('water refraction window', JSON.stringify(result));
} finally {
  await browser.close();
}
