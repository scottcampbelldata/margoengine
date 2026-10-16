// Real-adapter check (run from the repository root after building packages): node packages/selection/test/models.browser.mjs
// GPU picking and outlines on loaded gltf-pro models, cross-checked against the bvh Raycaster, in perspective and orthographic views.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser(),
  { page, hardware } = browser,
  errors = [];
console.log('browser open');
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.text().startsWith('[models]')) console.log(message.text());
  if (message.type() === 'error' || /ValidationError|Error while parsing|Invalid .*Pipeline/.test(message.text()))
    errors.push(message.text());
});
const outlinePixels = async () => {
  const image = await decodePNG(await page.locator('canvas').screenshot());
  let n = 0;
  for (let i = 0; i < image.data.length; i += 4)
    if (image.data[i] > 200 && image.data[i + 1] < 60 && image.data[i + 2] > 200) n++;
  return n;
};
try {
  await page.waitForFunction(() => window.modern);
  const report = await page.evaluate(async () => {
    const { Engine, box, PbrMaterial: _PbrMaterial } = await import('/packages/core/dist/extension.js'),
      { Picking, Selection } = await import('/packages/selection/dist/index.js');
    const { loadGLTF } = await import('/packages/gltf-pro/dist/index.js'),
      { Raycaster } = await import('/packages/bvh/dist/index.js'),
      { CameraProjection } = await import('/packages/cameras/dist/index.js');
    const { Material, createMesh } = await import('/packages/materials/dist/index.js');
    const assert = (ok, message) => {
      if (!ok) throw new Error(message);
    };
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:480px;height:320px;display:block';
    document.body.prepend(canvas);
    const e = await Engine.create(canvas, {
        backend: 'webgpu',
        capacity: 4096,
        camera: { position: [0, 0, 5], target: [0, 0, 0], fov: 50 },
      }),
      gpuErrors = [];
    e.gpu.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
    window.engine = e;
    const helmet = await loadGLTF(e, '/examples/assets/damaged-helmet.glb');
    helmet.root.setPosition([-1.3, 0, 0]);
    const robot = await loadGLTF(e, '/examples/assets/robot-expressive.glb');
    robot.root.setScale([0.35, 0.35, 0.35]).setPosition([1.4, -1.3, 0]);
    const plane = createMesh(
      e,
      {
        positions: [-0.4, -0.4, 0, 0.4, -0.4, 0, 0.4, 0.4, 0, -0.4, 0.4, 0],
        normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
        indices: [0, 1, 2, 0, 2, 3],
      },
      new Material({ shading: 'basic', color: [0.2, 0.8, 0.2, 1] }),
    );
    plane.root.setPosition([0.2, 1.1, 0.5]);
    const core = e.createMesh().setGeometry(box()).setScale([0.35, 0.35, 0.35]).setPosition([0.1, -0.9, 0]);
    const picking = Picking.attach(e),
      raycaster = new Raycaster(),
      checks = [];
    const pixel = (point) => {
      e.render();
      const m = e.camera.matrix,
        x = m[0] * point[0] + m[4] * point[1] + m[8] * point[2] + m[12],
        y = m[1] * point[0] + m[5] * point[1] + m[9] * point[2] + m[13],
        w = m[3] * point[0] + m[7] * point[1] + m[11] * point[2] + m[15];
      return [
        Math.floor(((x / w) * 0.5 + 0.5) * canvas.clientWidth),
        Math.floor((0.5 - (y / w) * 0.5) * canvas.clientHeight),
      ];
    };
    const owner = (mesh) =>
      [helmet, robot, plane].find((model) => model.nodes.includes(mesh) || model.root === mesh) ?? mesh;
    const name = (value) =>
      value === helmet
        ? 'helmet'
        : value === robot
          ? 'robot'
          : value === plane
            ? 'plane'
            : value === core
              ? 'core'
              : value
                ? 'mesh ' + value.id
                : 'none';
    e.render();
    console.log('[models] loaded');
    // Known pixels: helmet, plane and core box centres, empty corner.
    const [hx, hy] = pixel([-1.3, 0, 0]),
      helmetHit = await picking.pick(hx, hy);
    assert(
      helmetHit?.model === helmet && helmetHit.mesh === helmet.primitives[0].node && helmetHit.primitiveIndex === 0,
      'helmet centre did not pick the helmet',
    );
    assert((await e.pick(hx, hy)) === helmet.primitives[0].node, 'engine.pick did not return the helmet node');
    const [px, py] = pixel([0.2, 1.1, 0.5]);
    assert((await picking.pick(px, py))?.model === plane, 'materials mesh was not picked');
    const [cx, cy] = pixel([0.1, -0.9, 0]);
    assert((await e.pick(cx, cy)) === core, 'core mesh was not picked');
    assert((await e.pick(2, 2)) === null, 'empty corner picked something');
    checks.push({ name: 'Known pixels: helmet node, materials mesh, core box, background', helmet: [hx, hy] });
    console.log('[models] known pixels ok');
    // Occlusion between core meshes and models in the shared micro depth buffer, both ways (the box sits on the camera ray through the helmet centre).
    core.setPosition([-0.52, 0, 3]);
    assert((await e.pick(hx, hy)) === core, 'core box in front of the helmet lost');
    core.setPosition([-1.95, 0, -2.5]);
    assert((await picking.pick(hx, hy))?.model === helmet, 'helmet in front of the core box lost');
    core.setPosition([0.1, -0.9, 0]);
    helmet.root.visible = false;
    assert((await picking.pick(hx, hy))?.model !== helmet, 'hidden helmet still picked');
    helmet.root.visible = true;
    checks.push({ name: 'Model/core occlusion and hidden models' });
    console.log('[models] occlusion ok');
    // GPU picking against the CPU Raycaster over a pixel grid. GPU picks fall back to a 1-pixel neighbour on silhouettes, so a
    // mismatch at the pixel centre counts as agreement within one pixel when a ray through a neighbouring pixel hits the same object.
    const cpuAt = (x, y) => {
      const [hit] = raycaster.setFromEngine(e, x + 0.5, y + 0.5).intersectEngine(e);
      return hit ? (hit.model ?? hit.mesh) : null;
    };
    const compare = async (label) => {
      e.render();
      let exact = 0,
        agree = 0,
        total = 0,
        modelPixels = 0;
      const disagreements = [];
      for (let y = 8; y < canvas.clientHeight; y += 16)
        for (let x = 8; x < canvas.clientWidth; x += 16) {
          const gpu = await e.pick(x, y),
            want = gpu ? owner(gpu) : null,
            cpu = cpuAt(x, y);
          total++;
          if (cpu && cpu !== core) modelPixels++;
          if (want === cpu) {
            exact++;
            agree++;
            continue;
          }
          if ([-1, 0, 1].some((dy) => [-1, 0, 1].some((dx) => cpuAt(x + dx, y + dy) === want))) agree++;
          else if (disagreements.length < 5) disagreements.push([x, y, name(want), name(cpu)]);
        }
      return { name: label, exact, agree, total, modelPixels, rate: agree / total, disagreements };
    };
    const perspective = await compare('GPU pick vs bvh Raycaster, perspective');
    checks.push(perspective);
    assert(
      perspective.rate === 1 && perspective.modelPixels > 50,
      'GPU and CPU picking disagree: ' + JSON.stringify(perspective),
    );
    // Pick latency on the micro pass with models attached.
    let start = performance.now();
    for (let i = 0; i < 30; i++) await e.pick(hx, hy);
    const pickMs = (performance.now() - start) / 30;
    start = performance.now();
    for (let i = 0; i < 300; i++) raycaster.setFromEngine(e, hx, hy).intersectEngine(e);
    const rayMs = (performance.now() - start) / 300;
    checks.push({ name: 'Latency', gpuPickMs: +pickMs.toFixed(2), raycastMs: +rayMs.toFixed(3) });
    console.log('[models] perspective ' + JSON.stringify(perspective));
    // Orthographic camera from @margoengine/cameras.
    e.use(new CameraProjection({ mode: 'orthographic', height: 4 }));
    const [ox, oy] = pixel([-1.3, 0, 0]);
    assert((await picking.pick(ox, oy))?.model === helmet, 'orthographic helmet pick failed');
    const ortho = await compare('GPU pick vs bvh Raycaster, orthographic');
    checks.push(ortho);
    assert(ortho.rate === 1, 'orthographic GPU and CPU picking disagree: ' + JSON.stringify(ortho));
    e.removePlugin('cameras');
    // Outlines: a picked node and a whole model; the equal-depth mask needs the replay to match gltf-pro's depth exactly.
    const selection = Selection.attach(e, { color: [1, 0, 1], width: 3 });
    window.selection = selection;
    window.select = (which) => {
      selection.set(
        which === 'helmet'
          ? [helmetHit.mesh]
          : which === 'robot'
            ? [robot]
            : which === 'occluded' || which === 'plane'
              ? [plane]
              : [],
      );
      e.render();
      return gpuErrors.length;
    };
    window.occlude = () => {
      core.setScale([1.2, 1.2, 0.05]).setPosition([0.2, 1.1, 1]);
      e.render();
    };
    await e.gpu.queue.onSubmittedWorkDone();
    return { checks, gpuErrors };
  });
  const outline = {};
  for (const which of ['none', 'helmet', 'robot', 'plane', 'occluded']) {
    if (which === 'occluded') await page.evaluate(() => window.occlude());
    assert.equal(await page.evaluate((w) => window.select(w), which), 0);
    outline[which] = await outlinePixels();
  }
  assert.equal(outline.none, 0, 'outline colour present without a selection');
  assert.ok(
    outline.helmet > 300 && outline.robot > 200 && outline.plane > 100,
    'model outlines missing: ' + JSON.stringify(outline),
  );
  assert.ok(outline.occluded < 40, 'an occluded selection drew an outline: ' + JSON.stringify(outline));
  report.checks.push({ name: 'Outline pixels (magenta)', ...outline });
  assert.deepEqual(report.gpuErrors, []);
  assert.deepEqual(errors, []);
  await writeFile('test-results/selection-models.json', JSON.stringify({ hardware, ...report }, null, 2));
  console.log(JSON.stringify({ hardware: hardware.webgpu, ...report }, null, 2));
} finally {
  await browser.close();
}
