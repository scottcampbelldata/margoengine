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
  const sample = await page.evaluate(async (compat) => {
    if (compat) await (await import('/packages/webgl2-compat/dist/index.js')).install({ force: true });
    const { Engine, box, PbrMaterial } = await import('/packages/core/dist/index.js');
    const { Water } = await import('/packages/water/dist/index.js');
    const { Bloom } = await import('/packages/post/dist/bloom.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:512px;height:320px';
    document.body.append(canvas);
    const camera = { position: [0, 3, 10], target: [0, -1, -25], near: 0.1, far: 200 };
    const engine = await Engine.create(canvas, { backend: 'webgpu', capacity: 16, camera });
    const paint = (color) => new PbrMaterial({ color, roughness: 0.92 });
    const floor = engine
      .createMesh()
      .setGeometry(box(180, 0.1, 180))
      .setMaterial(paint('#d9dad4'))
      .setPosition([0, -4.05, 0]);
    // This slab is visible through the straight depth buffer ray, around 9 m farther inland than the bent ray.
    const slab = engine
      .createMesh()
      .setGeometry(box(10, 0.1, 1.8))
      .setMaterial(paint('#d9dad4'))
      .setPosition([0, -1.05, -25]);
    const post = Bloom.attach(engine, { strength: 0, exposure: 0 });
    Water.attach(engine, {
      size: [200, 200],
      segments: 32,
      waves: [{ direction: [1, 0], amplitude: 0, wavelength: 9, steepness: 0 }],
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
    window.refractionDepth = { engine, floor, slab, frame, dark: paint('#222322') };
    // The straight eye ray at the screen center points to the middle of the slab.
    return [canvas.width / 2, canvas.height / 2];
  }, compat);
  const capture = async (name) =>
    decodePNG(
      await page
        .locator('canvas')
        .screenshot({ path: `test-results/water-refraction-depth-${compat ? 'compat' : 'native'}-${name}.png` }),
    );
  const slab = await capture('slab');
  await page.evaluate(async () => {
    const { slab, frame } = window.refractionDepth;
    slab.visible = false;
    await frame();
  });
  const clear = await capture('clear');
  await page.evaluate(async () => {
    const { floor, dark, frame } = window.refractionDepth;
    floor.setMaterial(dark);
    await frame();
  });
  const dark = await capture('dark');
  const mean = (image) => {
    const rgb = [0, 0, 0];
    let count = 0;
    for (let y = sample[1] - 3; y <= sample[1] + 3; y++) {
      for (let x = sample[0] - 3; x <= sample[0] + 3; x++) {
        const i = 4 * (y * image.width + x);
        for (let channel = 0; channel < 3; channel++) rgb[channel] += image.data[i + channel];
        count++;
      }
    }
    return rgb.map((value) => value / count);
  };
  const match = { slab: mean(slab), clear: mean(clear), dark: mean(dark) };
  const validation = await page.evaluate(async () => {
    const { engine } = window.refractionDepth;
    const error = await engine.gpu.popErrorScope();
    engine.dispose();
    return error?.message;
  });
  await writeFile(
    `test-results/water-refraction-depth-${compat ? 'compat' : 'native'}.json`,
    JSON.stringify({ hardware, sample, match, validation, errors }, null, 2) + '\n',
  );
  assert.deepEqual(errors, []);
  assert.equal(validation, undefined);
  for (const [channel, hidden] of match.slab.entries()) {
    assert.ok(
      Math.abs(hidden - match.clear[channel]) < 1.0,
      `Unbent depth must leave no silhouette: ${JSON.stringify(match)}`,
    );
  }
  const contrast = Math.hypot(...match.clear.map((channel, i) => channel - match.dark[i]));
  assert.ok(contrast > 8, `The real bent ray still sees the seabed: ${JSON.stringify(match)}`);
  console.log('Matched refraction and absorption', match);
} finally {
  await browser.close();
}
