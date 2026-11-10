import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser({ port: 'free' }),
  { page } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
try {
  await page.waitForFunction(() => window.modern);
  await page.evaluate(async () => {
    const { Engine, box } = await import('/packages/core/dist/extension.js');
    const { loadGLTF } = await import('/packages/gltf-pro/dist/index.js');
    const { CameraProjection } = await import('/packages/cameras/dist/index.js');
    const { Highlight } = await import('/packages/selection/dist/highlight.js');
    const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:160px;height:160px;display:block';
    document.body.prepend(canvas);
    const e = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 0, 5], target: [0, 0, 0] } });
    e.gpu.addEventListener('uncapturederror', (ev) => {
      throw ev.error;
    });
    CameraProjection.attach(e, { mode: 'orthographic', height: 4 });
    const model = await loadGLTF(e, '/packages/exporters/tests/fixtures/Box.glb');
    model.root.setScale([2, 2, 2]);
    const blocker = e.createMesh().setGeometry(box()).setScale([3, 3, 0.2]).setPosition([0, 0, 2]);
    blocker.visible = false;
    const effect = Highlight.attach(e, { color: [1, 0, 1] });
    window.mode = async (style, selected = true, occluded = false) => {
      Object.assign(effect.options, style);
      effect.set(selected ? [model] : []);
      blocker.visible = occluded;
      await waitForPipelines(async () => {
        e.render();
        await e.gpu.queue.onSubmittedWorkDone();
      });
    };
    window.finish = () => {
      effect.dispose();
      model.dispose();
      e.dispose();
    };
  });
  const frame = async (style, selected = true, occluded = false) => {
    await page.evaluate(({ style, selected, occluded }) => window.mode(style, selected, occluded), {
      style,
      selected,
      occluded,
    });
    return decodePNG(await page.locator('canvas').screenshot());
  };
  const pixel = (image, x, y) =>
    Array.from(image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3));
  const energy = (p) => Math.min(p[0], p[2]) - p[1];
  const base = await frame({}, false),
    fill = await frame({ fillOpacity: 1, glowOpacity: 0 });
  const center = pixel(fill, 80, 80);
  assert.ok(center[0] > 200 && center[2] > 200 && center[1] < 30, 'fill missing ' + center);
  const outer = await frame({ fillOpacity: 0, glowOpacity: 1, innerGlow: false, outerGlow: true, radius: 12 });
  assert.deepEqual(pixel(outer, 80, 80), pixel(base, 80, 80), 'outer glow must not fill the interior');
  assert.ok(energy(pixel(outer, 123, 80)) > energy(pixel(base, 123, 80)) + 5, 'outer halo missing');
  const inner = await frame({ innerGlow: true, outerGlow: false });
  assert.ok(energy(pixel(inner, 42, 80)) > energy(pixel(base, 42, 80)) + 5, 'inner glow missing');
  assert.deepEqual(pixel(inner, 123, 80), pixel(base, 123, 80), 'inner glow leaked outside');
  const narrow = await frame({ innerGlow: false, outerGlow: true, radius: 4 }),
    wide = await frame({ radius: 16 });
  assert.deepEqual(pixel(narrow, 128, 80), pixel(base, 128, 80), 'radius support exceeded');
  assert.ok(energy(pixel(wide, 128, 80)) > energy(pixel(base, 128, 80)) + 3, 'radius did not broaden the halo');
  const hiddenBase = await frame({}, false, true),
    hidden = await frame({ fillOpacity: 1, glowOpacity: 1 }, true, true);
  assert.deepEqual(hidden.data, hiddenBase.data, 'fully hidden selection must contribute no fill/glow');
  await page.evaluate(() => window.finish());
  assert.deepEqual(errors, []);
  console.log('highlight pixels: fill, inner/outer halo, radius support, occlusion passed');
} finally {
  await browser.close();
}
