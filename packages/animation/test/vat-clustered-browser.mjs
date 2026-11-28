// Real-GPU proof that a VATCrowd receives clustered point lights (gap row 138): `lights.add(crowd)` composes the
// clustered light loop into the crowd's lit shader, so a red point light in front of a white crowd adds red where it
// falls, and a light out of range adds nothing. The crowd is a hand-built one-frame VAT quad facing the camera.
// Run from the repository root after building packages, with a hard limit:
//   node scripts/run-with-timeout.mjs run --max=5 -- node packages/animation/test/vat-clustered-browser.mjs
// (MARGO_COMPAT=1 for the WebGL2 compatibility layer).
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

const compat = compatRun();
const browser = await openBrowser({ startPath: '/tests/modern-game.html' }),
  { page } = browser,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});

try {
  const report = await page.evaluate(async () => {
    const { EngineKernel } = await import('/packages/core/dist/index.js');
    const { Clustered } = await import('/packages/clustered/dist/index.js');
    const { VATCrowd } = await import('/packages/animation/dist/vat.js');
    const { Shadows } = await import('/packages/shadows/dist/index.js');
    const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    // A 2 x 2 quad at z = 0 facing +z, both rows the same pose.
    const corners = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    const vat = {
      vertexCount: 4,
      rows: 2,
      width: 16,
      texels: new Float32Array(64),
      uvs: new Float32Array(8),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      clips: [{ name: 'still', start: 0, frames: 1, duration: 1, loop: true }],
    };
    for (let row = 0; row < 2; row++)
      for (let v = 0; v < 4; v++) {
        vat.texels.set([corners[v][0], corners[v][1], 0, 1], (row * 8 + v * 2) * 4);
        vat.texels.set([0, 0, 1, 0], (row * 8 + v * 2 + 1) * 4);
      }
    const problems = [];
    const shoot = async (light, shadowed = false) => {
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:64px;height:64px';
      document.body.append(canvas);
      const engine = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        exactSize: [64, 64],
        capacity: 16,
        camera: { position: [0, 0, 4], target: [0, 0, 0] },
      });
      engine.stop?.();
      engine.gpu.addEventListener('uncapturederror', (e) => problems.push(e.error.message));
      // Key light from behind the quad: only the hemisphere fill and the clustered light reach its front.
      engine.lighting.direction.set([0, 0, -1, 1]);
      const crowd = VATCrowd.attach(engine, vat, { roughness: 0.8 });
      crowd.add();
      const lights = Clustered.attach(engine);
      lights.setLights(light ? [light] : []);
      lights.add(crowd);
      // Shadows lights the crowd in the same bind group: their bindings must not collide.
      const shadows = shadowed ? Shadows.attach(engine) : null;
      shadows?.add(crowd);
      await waitForPipelines(async () => {
        engine.render({ delta: 1 / 60 });
        await engine.gpu.queue.onSubmittedWorkDone();
      });
      engine.render({ delta: 1 / 60 });
      const bitmap = await createImageBitmap(canvas);
      const read = new OffscreenCanvas(64, 64).getContext('2d');
      read.drawImage(bitmap, 0, 0);
      const px = read.getImageData(0, 0, 64, 64).data,
        at = (x, y) => [...px.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 3)];
      const out = { centre: at(32, 32), corner: at(2, 2) };
      crowd.dispose();
      lights.dispose();
      shadows?.dispose();
      engine.dispose();
      canvas.remove();
      return out;
    };
    return {
      none: await shoot(null),
      red: await shoot({ position: [0, 0, 0.6], color: [1, 0, 0], intensity: 4, range: 3 }),
      both: await shoot({ position: [0, 0, 0.6], color: [1, 0, 0], intensity: 4, range: 3 }, true),
      far: await shoot({ position: [0, 0, 30], color: [1, 0, 0], intensity: 4, range: 3 }),
      problems,
    };
  });
  console.log(JSON.stringify(report));
  assert.deepEqual(report.problems, [], 'no GPU validation errors');
  assert.deepEqual(pageErrors, [], 'no page errors');
  const [r0, g0, b0] = report.none.centre,
    [r1, g1, b1] = report.red.centre;
  assert.ok(r0 > 10, 'the crowd draws (fill light) at the centre');
  assert.ok(r1 - r0 > 40, `the red point light brightens the crowd's red channel: ${r0} -> ${r1}`);
  // PBR Neutral tone mapping desaturates a channel near 1 toward white, so green and blue rise a little too.
  assert.ok(r1 - r0 > 2 * (g1 - g0) && r1 - r0 > 2 * (b1 - b0), `the light is red: ${report.red.centre}`);
  assert.deepEqual(report.red.corner, report.none.corner, 'the background is untouched');
  assert.ok(
    report.both.centre[0] - r0 > 40,
    `with Shadows too, the point light still lights it: ${report.both.centre}`,
  );
  assert.deepEqual(report.far.centre, report.none.centre, 'a light out of range adds nothing');
  console.log(`vat-clustered: PASS on ${compat ? 'WebGL2 layer' : 'WebGPU'}`);
} finally {
  await closeAll({ browser });
}
