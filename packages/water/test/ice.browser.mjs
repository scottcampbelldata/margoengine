// Ice on the GPU (WebGPU, and the WebGL2 layer with MARGO_COMPAT=1): an IceMaterial ball drawn side on is bluer with
// blueIce 1 than 0, darker below the water line with wet darkening on, and narrower at the waterline with the notch cut
// (the vertex displacement); BergFoam on a flat Water seen from above whitens the water round a floating Iceberg more on
// the weather side than abeam. The bounds of the laws are held on the CPU in ice.test.js; this checks the drawn picture.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
await mkdir('test-results', { recursive: true });
const WIDTH = 320,
  HEIGHT = 240;
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' }),
  { page, hardware } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
const shot = () => page.locator('canvas').screenshot();
const draw = (code, arg) => page.evaluate(code, arg).then(shot);
try {
  await page.evaluate(
    async ({ WIDTH, HEIGHT }) => {
      const { EngineKernel } = await import('/packages/core/dist/index.js');
      const { createMesh } = await import('/packages/materials/dist/index.js');
      const { sphereGeometry } = await import('/packages/geometry/dist/index.js');
      const { IceMaterial } = await import('/packages/water/dist/ice.js');
      const canvas = document.createElement('canvas');
      canvas.style.cssText = `width:${WIDTH}px;height:${HEIGHT}px`;
      document.body.replaceChildren(canvas);
      const engine = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 8,
        camera: { position: [0, 0, 60], target: [0, 0, 0], near: 0.1, far: 2000 },
      });
      engine.gpu.pushErrorScope('validation');
      engine.lighting.direction.set([0.3, 0.6, 0.75, 1]);
      // A ball 10 m across in radius with smooth normals and about 5 vertices a metre round its equator, so the notch
      // bends its silhouette; its waterline at mesh and world y = 0.
      const material = new IceMaterial({ look: { blueIce: 0, wetDarkening: 0, notchDepth: 0, scallopDepth: 0, subsurface: 0 } });
      material.setWater({ x: 0, z: 0, height: 0 }, 0, 0);
      const mesh = createMesh(engine, sphereGeometry(10, 192, 128), material);
      window.iceTest = { engine, material, mesh };
    },
    { WIDTH, HEIGHT },
  );
  const look = (values) =>
    draw(async (values) => {
      const { engine, material } = window.iceTest;
      material.setLook(values);
      engine.render({ delta: 0 });
      await engine.gpu.queue.onSubmittedWorkDone();
    }, values);
  const base = { blueIce: 0, wetDarkening: 0, notchDepth: 0, scallopDepth: 0, subsurface: 0 };
  const white = await look(base);
  const blue = await look({ ...base, blueIce: 1 });
  const wet = await look({ ...base, wetDarkening: 0.8, wetHeight: 0.01 });
  const notched = await look({ ...base, notchDepth: 3, notchHeight: 2 });

  // Berg foam on a flat Water seen from above.
  await page.evaluate(async () => {
    const { engine, mesh } = window.iceTest;
    mesh.destroy();
    const { Water } = await import('/packages/water/dist/index.js');
    const { createMesh } = await import('/packages/materials/dist/index.js');
    const { boxGeometry } = await import('/packages/geometry/dist/index.js');
    const { IceMaterial, Iceberg, BergFoam } = await import('/packages/water/dist/ice.js');
    const sea = Water.attach(engine, { size: [200, 200], segments: 64, wind: { speed: 10, direction: [1, 0] }, waves: [{ direction: [1, 0], amplitude: 0, wavelength: 10 }] });
    const geometry = boxGeometry(20, 12, 20);
    const material = new IceMaterial();
    const berg = new Iceberg({ mesh: geometry, material, heave: { period: 0 }, roll: { period: 0 }, pitch: { period: 0 } });
    berg.update({ sample: () => ({ height: 0 }) }, 0);
    const ice = createMesh(engine, geometry, material);
    ice.root.setPosition(berg.position);
    const foam = BergFoam.attach(engine, { surface: sea, bergs: [berg], look: { foamTrail: 0 } });
    engine.camera.position = [0, 90, 0.01];
    engine.camera.target = [0, 0, 0];
    window.iceTest = { engine, sea, foam, ice };
  });
  const foamLook = (values) =>
    draw(async (values) => {
      const { engine, foam } = window.iceTest;
      foam.setLook(values);
      engine.render({ delta: 0 });
      await engine.gpu.queue.onSubmittedWorkDone();
    }, values);
  const foamOn = await foamLook({ foamWidth: 3, breakFoam: 1, waveHeight: 2 });
  const foamOff = await foamLook({ foamWidth: 0, breakFoam: 0, waveHeight: 0 });
  const validation = await page.evaluate(async () => {
    const { engine, sea, foam, ice } = window.iceTest;
    foam.dispose();
    ice.destroy();
    sea.dispose();
    const error = await engine.gpu.popErrorScope();
    return error?.message ?? null;
  });

  const decode = async (bytes) => decodePNG(bytes);
  const [W, B, D, N, F1, F0] = await Promise.all([white, blue, wet, notched, foamOn, foamOff].map(decode));
  const px = (img, x, y) => [img.data[(y * img.width + x) * 4], img.data[(y * img.width + x) * 4 + 1], img.data[(y * img.width + x) * 4 + 2]];
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  // Mean colour over a box of pixels.
  const mean = (img, x0, y0, x1, y1) => {
    const s = [0, 0, 0];
    let n = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const c = px(img, x, y);
        for (let k = 0; k < 3; k++) s[k] += c[k];
        n++;
      }
    return s.map((v) => v / n);
  };
  const cx = W.width >> 1,
    cy = W.height >> 1;
  const face = (img) => mean(img, cx - 20, cy - 30, cx + 20, cy + 30);
  const fw = face(W),
    fb = face(B);
  const ratio = (c) => c[2] / Math.max(1, c[0]);
  // Above and below the waterline (the image centre row).
  const above = (img) => lum(mean(img, cx - 20, cy - 30, cx + 20, cy - 6)),
    under = (img) => lum(mean(img, cx - 20, cy + 6, cx + 20, cy + 30));
  // Ice pixels across a row: brighter than the black background.
  const width = (img, y) => {
    let n = 0;
    for (let x = 0; x < img.width; x++) if (lum(px(img, x, y)) > 12) n++;
    return n;
  };
  // Foam the effect adds along the centre row (weather side, -X, to the left) and down the centre column (abeam).
  const added = (x, y) => lum(px(F1, x, y)) - lum(px(F0, x, y));
  let weather = 0,
    abeam = 0;
  for (let x = 0; x < cx; x++) weather = Math.max(weather, added(x, cy));
  for (let y = cy; y < F1.height; y++) abeam = Math.max(abeam, added(cx, y));
  const report = {
    hardware,
    blue: { white: fw, blue: fb },
    wet: { dry: [above(W), under(W)], wet: [above(D), under(D)] },
    notch: { plain: width(W, cy), notched: width(N, cy), above: [width(W, cy - 24), width(N, cy - 24)] },
    foam: { weather, abeam },
  };
  console.log(JSON.stringify(report));
  assert.ok(lum(fw) > 30, `the ice is lit (${fw})`);
  assert.ok(ratio(fb) > ratio(fw) * 1.3, `blueIce 1 is bluer: ${fb} against ${fw}`);
  assert.ok(under(D) / above(D) < (under(W) / above(W)) * 0.7, 'wet ice below the waterline is darker');
  assert.ok(Math.abs(above(D) - above(W)) < 4, 'the dry ice above is unchanged');
  assert.ok(report.notch.notched < report.notch.plain - 4, `the notch narrows the waterline (${report.notch.plain} -> ${report.notch.notched})`);
  assert.ok(Math.abs(report.notch.above[0] - report.notch.above[1]) <= 2, 'the ice well above the notch keeps its width');
  assert.ok(weather > 20, `the berg foam whitens the water (${weather})`);
  assert.ok(weather > abeam + 10, `more foam on the weather side (${weather}) than abeam (${abeam})`);
  assert.equal(validation, null);
  assert.deepEqual(errors, []);
  await writeFile(`test-results/water-ice-${hardware?.compat ? 'compat' : 'webgpu'}.json`, JSON.stringify(report, null, 2));
  console.log(`water ice browser check passed (${hardware.webgpu?.vendor ?? 'compat'})`);
} finally {
  await page.evaluate(() => window.iceTest?.engine.dispose());
  await closeAll({ browser });
}
