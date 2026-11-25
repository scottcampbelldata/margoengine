// Real-GPU check (run from the repository root after building packages):
//   node packages/terrain/test/wetness.browser.mjs   (MARGO_COMPAT=1 for the WebGL2 compatibility layer)
// KB-TERRAIN-WETSAND1: TerrainColors darkened sand only where the water's depth texture showed water in the current
// frame, so sand the swash had left dried the moment it went. Terrain now keeps a moisture record over the water's
// grid. A flat beach (y -0.2, inside the default wet heights) under a 4 x 4 depth map is drawn dry, under 10 cm of water,
// and then with the water gone. One second after the water leaves, the sand must still be as dark as under water
// (on main it was back to dry). Later frames are compared with dry sand whose albedo is scaled to what the record
// predicts (`wetSandAfter`): after the film drains, after a 10 s dry time and once fully dry.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
await mkdir('test-results', { recursive: true });
const browser = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' }),
  { page, hardware } = browser;
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
try {
  const result = await page.evaluate(async () => {
    const { Engine, PbrMaterial } = await import('/packages/core/dist/index.js'),
      { TerrainColors, heightfield, wetSandAfter } = await import('/packages/terrain/dist/index.js'),
      { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    const W = 320,
      H = 240,
      canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    canvas.style.cssText = `width:${W}px;height:${H}px`;
    document.body.append(canvas);
    const engine = await Engine.create(canvas, {
        backend: 'webgpu',
        camera: { position: [0, 5, -7], target: [0, -0.2, 0], fov: 40, near: 0.1, far: 200 },
      }),
      device = engine.gpu,
      errors = [];
    device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    engine.lighting.radiance.set([1, 1, 1, 0.35]);
    engine.scene.background = '#b8c4d0';
    const SAND = [0.5, 0.42, 0.29],
      DARK = 0.6;
    const depth = device.createTexture({
      size: [4, 4],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
    });
    const water = (m) =>
      device.queue.writeTexture({ texture: depth }, new Float32Array(16).fill(m), { bytesPerRow: 16 }, [4, 4]);
    const beach = (sand) => {
      const mesh = engine
        .createMesh()
        .setGeometry(heightfield(() => -0.2, { size: [40, 40], origin: [-20, -20], resolution: 32 }))
        .setMaterial(new PbrMaterial({ color: sand, roughness: 0.92 }));
      const colors = TerrainColors.attach(engine, mesh, {
        sand,
        detail: 0,
        wetDarkening: DARK,
        wetness: { texture: () => depth, origin: [-20, -20], size: [40, 40] },
      });
      return { mesh, colors };
    };
    // Mean sRGB luma of the middle of the frame.
    const luma = () => {
      const c = new OffscreenCanvas(W, H).getContext('2d');
      c.drawImage(canvas, 0, 0);
      const d = c.getImageData(W * 0.3, H * 0.4, W * 0.4, H * 0.3).data;
      let sum = 0;
      for (let k = 0; k < d.length; k += 4) sum += 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2];
      return sum / (d.length / 4);
    };
    const frames = async (n, delta) => {
      for (let i = 1; i < n; i++) engine.render({ delta });
      await device.queue.onSubmittedWorkDone();
      // Read in the same task as the frame that drew it (a WebGPU canvas is presented, then cleared).
      engine.render({ delta });
      return luma();
    };
    // Dry sand at a scaled albedo: the reference a drying frame must match.
    const reference = async (share) => {
      water(0);
      const { mesh, colors } = beach(SAND.map((v) => v * (1 - (1 - DARK) * share)));
      const value = await frames(2, 0);
      colors.dispose();
      mesh.dispose();
      return value;
    };
    const share = (m) => (1 - Math.exp(-3 * m)) / (1 - Math.exp(-3)),
      moistureB = Math.exp(-11 / 900),
      moistureC = moistureB * Math.exp(-1);
    // One run under a light: `back` lights the beach from behind the camera (albedo only), `glare` from ahead, so the
    // wet film's sheen shows.
    const run = async (direction) => {
      engine.lighting.direction.set([...direction, 3]);
      water(0);
      const { mesh, colors } = beach(SAND);
      await waitForPipelines(async () => {
        engine.render({ delta: 0 });
        await device.queue.onSubmittedWorkDone();
      });
      const out = { dry: await frames(2, 0) };
      water(0.1);
      out.wet = await frames(3, 0.1);
      water(0);
      // One second after the water left, at the default 900 s dry time and 20 s gloss time.
      out.afterOne = await frames(10, 0.1);
      // Ten more seconds with a 1 s gloss time: the film has drained, the sand is still almost fully dark.
      colors.setLook({ wetGlossTime: 1 });
      out.filmGone = await frames(10, 1);
      // Ten more seconds with a 10 s dry time: moisture e^-1 of that.
      colors.setLook({ wetDryTime: 10 });
      out.drying = await frames(10, 1);
      // Twenty more seconds with a 1 s dry time: dry.
      colors.setLook({ wetDryTime: 1 });
      out.dried = await frames(20, 1);
      colors.dispose();
      mesh.dispose();
      out.refFilmGone = await reference(share(moistureB));
      out.refDrying = await reference(share(moistureC));
      out.refWetAlbedo = await reference(1);
      return out;
    };
    device.pushErrorScope('validation');
    const back = await run([0, 0.6, -0.8]),
      glare = await run([0, 0.6, 0.8]);
    const predicted = {
      afterOne: wetSandAfter(1).darkening,
      filmGone: share(moistureB),
      filmGoneHelper: wetSandAfter(11).darkening,
      drying: share(moistureC),
    };
    const error = await device.popErrorScope();
    if (error) errors.push(error.message);
    depth.destroy();
    engine.dispose();
    return { back, glare, predicted, errors };
  });
  const report = { hardware, result };
  await writeFile(
    `test-results/terrain-wetness-${process.env.MARGO_COMPAT === '1' ? 'compat' : 'webgpu'}.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(result));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(pageErrors, []);
  const near = (a, b, tolerance, what) =>
    assert.ok(
      Math.abs(a - b) <= tolerance * b,
      `${what}: ${a.toFixed(2)} against ${b.toFixed(2)} (within ${tolerance * 100}%)`,
    );
  const { back, glare, predicted } = result;
  assert.ok(
    Math.abs(predicted.filmGone - predicted.filmGoneHelper) < 1e-9,
    'wetSandAfter gives the darkening the record holds',
  );
  assert.ok(back.dry > 40, `the sand is lit (${back.dry.toFixed(1)})`);
  assert.ok(
    back.wet < back.dry * 0.85,
    `water darkens the sand (${back.wet.toFixed(1)} against ${back.dry.toFixed(1)} dry)`,
  );
  // The bug: on main the sand was back to dry one second after the water left.
  near(back.afterOne, back.wet, 0.02, 'one second after the water left, the sand is as dark as under water');
  near(back.filmGone, back.refFilmGone, 0.02, 'eleven seconds on, the sand matches sand at the predicted darkening');
  near(back.drying, back.refDrying, 0.02, 'after one dry time the sand matches the predicted darkening');
  assert.ok(back.drying > back.filmGone + 2, 'the sand pales as it dries');
  near(back.dried, back.dry, 0.01, 'dried sand matches dry sand');
  // Toward the light: the water film shines, and once it has drained the sand is matte at its darkening.
  assert.ok(
    glare.wet > glare.refWetAlbedo * 1.05,
    `the wet film shines (${glare.wet.toFixed(1)} against ${glare.refWetAlbedo.toFixed(1)} matte)`,
  );
  near(glare.filmGone, glare.refFilmGone, 0.02, 'with the film drained the sand is matte at the predicted darkening');
  near(glare.dried, glare.dry, 0.01, 'dried sand matches dry sand toward the light');
  const f = (v) => v.toFixed(1);
  console.log(
    `ok terrain wet sand (sRGB luma): dry ${f(back.dry)}, under water ${f(back.wet)}, 1 s after ${f(back.afterOne)}, ` +
      `11 s ${f(back.filmGone)} (ref ${f(back.refFilmGone)}), one 10 s dry time ${f(back.drying)} (ref ${f(back.refDrying)}), ` +
      `dried ${f(back.dried)}; toward the light wet ${f(glare.wet)} against matte ${f(glare.refWetAlbedo)}, film drained ` +
      `${f(glare.filmGone)} (ref ${f(glare.refFilmGone)})`,
  );
} finally {
  await browser.close();
}
