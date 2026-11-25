// Real-GPU frames of planar water reflections with contact hardening, built packages. Three thin white posts stand in
// calm water. The contrast of each post's reflection is measured just below its foot and below its top on the
// screenshot: `contactHardening` with a roughness floor of 0.15 keeps most of the sharp reflection's contrast at the
// foot and spreads the top. Run from the repository root, with --compat for the WebGL2 compatibility layer; the
// frames land in test-results/water-reflector-cone-*.png.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { decodePNG } from '../../../tests/support/png.js';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
await mkdir('test-results', { recursive: true });
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' }),
  { page, hardware } = browser,
  backend = hardware?.compat ? 'compat' : 'webgpu',
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
try {
  const points = await page.evaluate(async () => {
    const { EngineKernel, box, PbrMaterial } = await import('/packages/core/dist/index.js');
    const { Water } = await import('/packages/water/dist/index.js');
    const { Reflector } = await import('/packages/environment/dist/reflector.js');
    const { WaterReflection } = await import('/packages/water/dist/reflector.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:320px;height:240px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 8,
      camera: { position: [0, 2.5, 9], target: [0, -0.4, 0], near: 0.1, far: 100 },
    });
    engine.stop();
    engine.gpu.pushErrorScope('validation');
    for (const x of [-1.5, 0, 1.5])
      engine
        .createMesh()
        .setGeometry(box(0.15, 2, 0.15))
        .setMaterial(new PbrMaterial({ color: '#ffffff', emissive: [4, 4, 4], roughness: 1 }))
        .setPosition([x, 1, 0]);
    const water = Water.attach(engine, {
      size: [60, 60],
      segments: 32,
      waves: [{ direction: [1, 0], amplitude: 0, wavelength: 10 }],
    });
    const mirror = Reflector.attach(engine, {
      width: 60,
      height: 60,
      captureOnly: true,
      autoUpdate: false,
      roughness: 1,
    });
    mirror.node.setRotation([-Math.PI / 2, 0, 0]);
    let effect;
    window.frame = (options) => {
      effect?.dispose();
      effect = WaterReflection.attach(engine, { surface: water, reflector: mirror, ...options });
      engine.render({ delta: 0 });
      mirror.update();
      engine.render({ delta: 0 });
    };
    window.finish = async () => {
      await engine.gpu.queue.onSubmittedWorkDone();
      const error = await engine.gpu.popErrorScope();
      effect?.dispose();
      mirror.dispose();
      engine.dispose();
      return error?.message;
    };
    engine.render({ delta: 0 });
    const m = engine.camera.matrix,
      project = (p) => {
        const c = [0, 1, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
        return [((c[0] / c[2]) * 0.5 + 0.5) * canvas.width, (0.5 - (c[1] / c[2]) * 0.5) * canvas.height];
      };
    return [-1.5, 0, 1.5].map((x) => ({ foot: project([x, -0.3, 0]), top: project([x, -1.2, 0]) }));
  });
  /** Contrast of a reflected post: peak over background of the luma profile across it. Blur spreads the post's light
   * over a wider span, so its peak falls. */
  const contrast = (image, [cx, cy]) => {
    const y = Math.round(cy),
      row = [];
    for (let x = Math.round(cx) - 24; x <= Math.round(cx) + 24; x++) {
      const i = (y * image.width + x) * 4;
      row.push(0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2]);
    }
    return Math.max(...row) - Math.min(...row);
  };
  const frame = async (name, options) => {
    await page.evaluate((options) => window.frame(options), options);
    const image = await decodePNG(
      await page.locator('canvas').screenshot({ path: `test-results/water-reflector-cone-${name}-${backend}.png` }),
    );
    return image;
  };
  const measure = (image) => {
    const at = (key) => points.reduce((sum, p) => sum + contrast(image, p[key]), 0) / points.length;
    return { foot: at('foot'), top: at('top') };
  };
  const sharpImage = await frame('sharp', {}),
    coneImage = await frame('rough', { roughness: 0.15, contactHardening: true }),
    validation = await page.evaluate(() => window.finish());
  assert.equal(validation, undefined);
  assert.deepEqual(errors, []);
  const sharp = measure(sharpImage),
    cone = measure(coneImage);
  const report = { hardware, backend, sharp, cone, validation };
  console.log(JSON.stringify(report));
  await writeFile(`test-results/water-reflector-cone-${backend}.json`, JSON.stringify(report, null, 2));
  assert.ok(sharp.foot > 8 && sharp.top > 8, 'the sharp reflection shows the posts');
  // Kept share of each reflected post's contrast: most at the contact, little at the far end.
  const foot = cone.foot / sharp.foot,
    top = cone.top / sharp.top;
  assert.ok(foot > 0.6, `the contact stays sharp: ${foot}`);
  assert.ok(top < 0.5, `the far end blurs: ${top}`);
  assert.ok(top < foot * 0.6, `blur grows with distance from the water: ${foot} to ${top}`);
} finally {
  await browser.close();
}
