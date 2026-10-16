// Real-adapter check for x-ray outlines (run from the repository root after building packages): node packages/selection/test/xray.browser.mjs
// A core box and a @margoengine/materials (gltf-pro) plane, each half hidden behind an occluder box, selected in magenta.
// Inside each occluder (inset past the visible outline): no magenta with x-ray off, dashed magenta with it on, one solid
// run with `dash: 0`; perspective and orthographic (@margoengine/cameras).
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser({ port: 5241 }),
  { page, hardware } = browser,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' || /ValidationError|Error while parsing|Invalid .*Pipeline/.test(message.text()))
    errors.push(message.text());
});
const magenta = (d, i) => d[i] > 150 && d[i + 1] < 90 && d[i + 2] > 150;
/** Magenta pixels inside a rectangle, and the most dash runs found along one of its rows. */
async function measure(rect, file) {
  const png = await page.locator('canvas').screenshot();
  if (file) await writeFile(file, png);
  const image = await decodePNG(png);
  let count = 0,
    runs = 0;
  for (let y = rect[1]; y < rect[3]; y++) {
    let row = 0,
      previous = false;
    for (let x = rect[0]; x < rect[2]; x++) {
      const on = magenta(image.data, (y * image.width + x) * 4);
      if (on) count++;
      if (on && !previous) row++;
      previous = on;
    }
    runs = Math.max(runs, row);
  }
  return { count, runs };
}
try {
  await page.waitForFunction(() => window.modern);
  await page.evaluate(async () => {
    const { Engine, box, PbrMaterial } = await import('/packages/core/dist/extension.js'),
      { Selection } = await import('/packages/selection/dist/index.js');
    const { Material, createMesh } = await import('/packages/materials/dist/index.js'),
      { CameraProjection } = await import('/packages/cameras/dist/index.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:480px;height:320px;display:block';
    document.body.prepend(canvas);
    const e = await Engine.create(canvas, {
        backend: 'webgpu',
        camera: { position: [0, 0, 8], target: [0, 0, 0], fov: 50 },
      }),
      gpuErrors = [];
    e.gpu.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
    const grey = new PbrMaterial({ color: '#7a8088', roughness: 0.8 });
    const part = e.createMesh().setGeometry(box()).setScale([1.6, 1.2, 1.2]).setPosition([-1.6, 0, 0]);
    const plane = createMesh(
      e,
      {
        positions: [-0.8, -0.6, 0, 0.8, -0.6, 0, 0.8, 0.6, 0, -0.8, 0.6, 0],
        normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
        indices: [0, 1, 2, 0, 2, 3],
      },
      new Material({ shading: 'basic', color: [0.2, 0.7, 0.3, 1] }),
    );
    plane.root.setPosition([1.6, 0, 0]);
    // Occluders cover the right half of each selected object, closer to the camera.
    const spots = [
        [-1.0, 0, 2],
        [1.8, 0, 2],
      ],
      _occluders = spots.map((p) =>
        e.createMesh().setGeometry(box()).setMaterial(grey).setScale([1.4, 2.4, 0.2]).setPosition(p),
      );
    const selection = Selection.attach(e, { color: [1, 0, 1], width: 3 });
    selection.set([part, plane]);
    // Screen rectangle of an occluder's far face (inside its silhouette in both projections), inset past the visible outline.
    const rect = (p, inset) => {
      const m = e.camera.matrix,
        xs = [],
        ys = [];
      for (const dx of [-0.7, 0.7])
        for (const dy of [-1.2, 1.2]) {
          const q = [p[0] + dx, p[1] + dy, p[2] - 0.1],
            w = m[3] * q[0] + m[7] * q[1] + m[11] * q[2] + m[15];
          xs.push((((m[0] * q[0] + m[4] * q[1] + m[8] * q[2] + m[12]) / w) * 0.5 + 0.5) * canvas.clientWidth);
          ys.push((0.5 - ((m[1] * q[0] + m[5] * q[1] + m[9] * q[2] + m[13]) / w) * 0.5) * canvas.clientHeight);
        }
      return [
        Math.ceil(Math.min(...xs)) + inset,
        Math.ceil(Math.min(...ys)) + inset,
        Math.floor(Math.max(...xs)) - inset,
        Math.floor(Math.max(...ys)) - inset,
      ];
    };
    window.view = async (mode, xray) => {
      selection.options.xray = xray;
      if (mode === 'orthographic' && !e.hasPlugin('cameras'))
        e.use(new CameraProjection({ mode: 'orthographic', height: 4 }));
      e.render();
      await e.gpu.queue.onSubmittedWorkDone();
      return { rects: spots.map((p) => rect(p, 7)), gpuErrors };
    };
  });
  const results = {};
  for (const mode of ['perspective', 'orthographic'])
    for (const [name, xray] of [
      ['off', false],
      ['dashed', true],
      ['solid', { dash: 0, opacity: 1 }],
    ]) {
      const { rects, gpuErrors } = await page.evaluate(([m, x]) => window.view(m, x), [mode, xray]);
      assert.deepEqual(gpuErrors, []);
      const file = name === 'dashed' ? `test-results/selection-xray-${mode}.png` : undefined;
      results[`${mode} ${name}`] = [await measure(rects[0], file), await measure(rects[1])];
    }
  for (const mode of ['perspective', 'orthographic']) {
    const off = results[`${mode} off`],
      dashed = results[`${mode} dashed`],
      solid = results[`${mode} solid`];
    for (let i = 0; i < 2; i++) {
      const what = `${mode} ${i ? 'materials plane' : 'core box'}`;
      assert.equal(off[i].count, 0, `${what}: hidden part outlined with x-ray off`);
      assert.ok(
        dashed[i].count > 60 && dashed[i].runs >= 3,
        `${what}: no dashed hidden outline ${JSON.stringify(dashed[i])}`,
      );
      assert.ok(
        solid[i].count > dashed[i].count && solid[i].runs <= 2,
        `${what}: dash 0 is not solid ${JSON.stringify(solid[i])}`,
      );
    }
  }
  assert.deepEqual(errors, []);
  await writeFile('test-results/selection-xray.json', JSON.stringify({ hardware, results }, null, 2));
  console.log(JSON.stringify({ hardware: hardware.webgpu, results }, null, 2));
  console.log('selection x-ray browser check passed');
} finally {
  await browser.close();
}
