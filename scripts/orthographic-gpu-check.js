// Real-adapter check of clustered lighting and Gaussian splats under an orthographic camera (@margoengine/cameras).
// Run from the repository root after building packages, with the GPU lock held: node scripts/orthographic-gpu-check.js
// (points has its own orthographic section in `npm run test:browser --workspace packages/points`).
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { decodePNG } from '../tests/support/png.js';

const browser = await openBrowser({ startPath: '/tests/modern-game.html', port: 5231 }),
  { page, hardware } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
const shot = async () => {
  const image = await decodePNG(await page.locator('#ortho').screenshot());
  return (x, y) => [...image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)];
};
try {
  await page.evaluate(async () => {
    const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
      { engineRuntime } = await import('/packages/core/dist/extension.js');
    const { CameraProjection } = await import('/packages/cameras/dist/index.js'),
      { Clustered } = await import('/packages/clustered/dist/index.js'),
      { Splats } = await import('/packages/splats/dist/index.js');
    const canvas = document.createElement('canvas');
    canvas.id = 'ortho';
    canvas.style.cssText = 'display:block;width:400px;height:200px';
    document.body.prepend(canvas);
    const engine = await Engine.create(canvas, {
        backend: 'webgpu',
        camera: { position: [0, 0, 6], target: [0, 0, 0], near: 0.1, far: 100 },
      }),
      runtime = engineRuntime(engine),
      device = runtime.gpu,
      gpuErrors = [];
    device.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
    // Off-centre frustum, 50 px per world unit: x in [-3, 5], y in [-2, 2]; the near plane is 4 units behind the eye.
    const projection = new CameraProjection({ left: -3, right: 5, top: 2, bottom: -2, near: -4, far: 20 });
    engine.use(projection);
    const plane = engine
      .createMesh()
      .setGeometry(box())
      .setScale([20, 20, 0.1])
      .setMaterial(new PbrMaterial({ color: '#ffffff', roughness: 1 }));
    runtime.lighting.radiance.fill(0);
    const lights = Clustered.attach(engine, { grid: [8, 4, 6] });
    const render = async () => {
      device.pushErrorScope('validation');
      for (let i = 0; i < 3; i++) {
        engine.render({ culling: false });
        await device.queue.onSubmittedWorkDone();
      }
      const e = await device.popErrorScope();
      if (e) gpuErrors.push(e.message);
    };
    const read = async (buffer, size = buffer.size) => {
      const out = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
        encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(buffer, 0, out, 0, size);
      device.queue.submit([encoder.finish()]);
      await out.mapAsync(GPUMapMode.READ);
      const bytes = out.getMappedRange().slice(0);
      out.unmap();
      out.destroy();
      return bytes;
    };
    window.ortho = {
      engine,
      projection,
      plane,
      lights,
      gpuErrors,
      async light(list, camera) {
        engine.camera.position = camera.position;
        engine.camera.target = camera.target;
        plane.visible = true;
        lights.setLights(list);
        await render();
      },
      async splats() {
        plane.visible = false;
        lights.setLights([]);
        engine.camera.position = [0, 0, 6];
        engine.camera.target = [0, 0, 0];
        // Two equal isotropic splats 9 units apart in depth; the second is 3 units behind the eye (near plane: 4 behind).
        const cloud = Splats.attach(engine, {
          positions: new Float32Array([1, 0, 0, -1, 0.5, 9]),
          covariances: new Float32Array([0.04, 0, 0, 0.04, 0, 0.04, 0.04, 0, 0, 0.04, 0, 0.04]),
          colors: new Float32Array([1, 0, 0, 0.9, 0, 0, 1, 0.9]),
        });
        await render();
        const ellipses = new Float32Array(await read(cloud.gpuState.ellipses)),
          sorted = new Uint32Array(await read(cloud.gpuState.sorted));
        return { ellipses: [...ellipses], sorted: [...sorted], matrix: [...engine.camera.matrix] };
      },
    };
  });

  // 1. Clustered lights at several screen cells: lit within range on the plane, dark outside, at positive and negative view depths.
  const lights = [
      [-2, 1.2],
      [0, 0],
      [1.5, -1.2],
      [4, 1],
      [3.2, -0.4],
    ],
    px = (x, y) => [Math.round((x + 3) * 50), Math.round((2 - y) * 50)];
  const result = { hardware, clustered: [] };
  // Both cameras look down -z; from z=-0.5 the plane and the lights are behind the eye (negative view depth).
  for (const [label, camera] of [
    ['in front of the eye', { position: [0, 0, 6], target: [0, 0, 0] }],
    ['behind the eye (negative near)', { position: [0, 0, -0.5], target: [0, 0, -1] }],
  ]) {
    await page.evaluate(([camera]) => window.ortho.light([], camera), [camera]);
    const dark = await shot();
    await page.evaluate(
      ([list, camera]) => window.ortho.light(list, camera),
      [lights.map(([x, y]) => ({ position: [x, y, 0.35], range: 0.9, color: [1, 0, 0], intensity: 3 })), camera],
    );
    const lit = await shot(),
      rows = [];
    for (const [x, y] of lights) {
      // Below the light, 0.6 units to the right (in range) and 0.96 units to the left (out of range).
      const [cx, cy] = px(x, y),
        inside = lit(cx, cy)[0] - dark(cx, cy)[0],
        edge = lit(cx + 30, cy)[0] - dark(cx + 30, cy)[0],
        outside = lit(cx - 48, cy)[0] - dark(cx - 48, cy)[0];
      rows.push({ light: [x, y], inside, edge, outside });
      assert.ok(
        inside > 60 && edge > 8 && Math.abs(outside) <= 3,
        `${label}: light at ${x},${y} -> inside ${inside}, 0.6 units ${edge}, 0.96 units ${outside}`,
      );
    }
    result.clustered.push({ label, rows });
    console.log('ok clustered', label, JSON.stringify(rows));
  }

  // 2. Splats: the orthographic Jacobian gives equal pixel sizes at any depth; a splat behind the eye (inside the negative near plane) is kept and drawn after the farther one.
  const s = await page.evaluate(() => window.ortho.splats());
  const axis = (i) => Math.hypot(s.ellipses[i * 8 + 4] * 200, s.ellipses[i * 8 + 5] * 100),
    expected = 3 * Math.sqrt(0.04 * 50 * 50 + 0.3);
  const ndc = (p) =>
    [0, 1].map((r) => s.matrix[r] * p[0] + s.matrix[4 + r] * p[1] + s.matrix[8 + r] * p[2] + s.matrix[12 + r]);
  assert.ok(
    Math.abs(axis(0) - expected) < 0.05 && Math.abs(axis(1) - expected) < 0.05,
    `splat axes ${axis(0)}, ${axis(1)} px, expected ${expected} at both depths`,
  );
  for (const [i, p] of [
    [0, [1, 0, 0]],
    [1, [-1, 0.5, 9]],
  ])
    assert.ok(
      ndc(p).every((v, k) => Math.abs(v - s.ellipses[i * 8 + k]) < 1e-4),
      `splat ${i} centre`,
    );
  assert.ok(
    s.ellipses[3] > 0 && s.ellipses[11] > 0 && s.sorted[1] === 0 && s.sorted[3] === 1,
    `splat order ${s.sorted}`,
  );
  const image = await shot(),
    red = image(...px(1, 0)),
    blue = image(...px(-1, 0.5));
  assert.ok(red[0] > 150 && red[2] < 80 && blue[2] > 150 && blue[0] < 80, `splat pixels ${red} ${blue}`);
  result.splats = { axes: [axis(0), axis(1)], expected, sorted: s.sorted, pixels: { red, blue } };
  console.log('ok splats', JSON.stringify(result.splats));

  const gpuErrors = await page.evaluate(() => window.ortho.gpuErrors);
  assert.deepEqual(gpuErrors, []);
  assert.deepEqual(errors, []);
  await writeFile('test-results/orthographic-gpu.json', JSON.stringify(result, null, 2));
  console.log('orthographic GPU check passed');
} finally {
  await browser.close();
}
