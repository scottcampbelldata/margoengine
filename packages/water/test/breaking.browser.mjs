// FG-04 and FG-12 on the GPU (WebGPU, and the WebGL2 layer with MARGO_COMPAT=1): a 3 m bore into 1 m of water, made to
// plunge, drawn side on along its front over a ground plane. Down the column through the jet the picture runs sky, the
// jet, sky again (the tube under the lip), then the plane: the crest overturns, which a flood height field cannot draw.
// The face's look: with the sun behind the lip, transmission brightens the lip; sediment browns it (red over blue).
// The CPU side (fronts, sections, mesh) is held in breaking.test.js; this checks the drawn picture.
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
try {
  await page.evaluate(
    async ({ WIDTH, HEIGHT }) => {
      const { EngineKernel } = await import('/packages/core/dist/index.js');
      const { createMesh, Material } = await import('/packages/materials/dist/index.js');
      const { breakingFronts, breakingWaveGeometry, BreakingWaveMaterial } = await import(
        '/packages/water/dist/breaking.js'
      );
      const canvas = document.createElement('canvas');
      canvas.style.cssText = `width:${WIDTH}px;height:${HEIGHT}px`;
      document.body.replaceChildren(canvas);
      // 40 x 8 cells of 2 m at origin [100, 50]: 4 m of water up to column 20 running +x at 5 m/s, 1 m deep ahead. The
      // front is at x = 141, from z = 50 to 66; the camera looks along it (+z) from in front of its start.
      const W = 40,
        H = 8,
        n = W * H,
        depth = new Float32Array(n),
        bed = new Float32Array(n),
        velocity = new Float32Array(2 * n),
        breaker = new Float32Array(n);
      for (let k = 0; k < n; k++) {
        const x = k % W;
        depth[k] = x <= 20 ? 4 : 1;
        velocity[2 * k] = x <= 20 ? 5 : 0;
        breaker[k] = x >= 18 && x <= 20 ? 1 : 0;
      }
      const reading = { time: 0, width: W, height: H, depth, bed, velocity, foam: new Float32Array(n), breaker };
      const fronts = breakingFronts(reading, { place: { origin: [100, 50], size: [80, 16] }, plunge: 1 });
      const engine = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 8,
        camera: { position: [143, 2.5, 20], target: [143, 2.5, 58], near: 0.1, far: 500, fov: 20 },
      });
      engine.gpu.pushErrorScope('validation');
      const material = new BreakingWaveMaterial();
      const wave = createMesh(engine, breakingWaveGeometry(fronts), material);
      // The water ahead: a plane 0.3 m under its surface, so the tube's floor shows as its own band.
      const ground = createMesh(
        engine,
        {
          positions: [130, 0.7, 40, 170, 0.7, 40, 170, 0.7, 80, 130, 0.7, 80],
          normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
          indices: [0, 2, 1, 0, 3, 2],
        },
        new Material({ color: [0.8, 0.8, 0.8], roughness: 1 }),
      );
      window.breakTest = { engine, material, wave, ground };
    },
    { WIDTH, HEIGHT },
  );
  const draw = (look, sun) =>
    page
      .evaluate(
        async ({ look, sun }) => {
          const { engine, material } = window.breakTest;
          material.setLook(look);
          engine.lighting.direction.set([...sun, 1]);
          engine.render({ delta: 0 });
          await engine.gpu.queue.onSubmittedWorkDone();
        },
        { look, sun },
      )
      .then(shot);
  const base = { scatter: [0.03, 0.06, 0.05], foam: [0.85, 0.87, 0.88], transmission: 1, sediment: 0 };
  // The mask: everything bright and lit from the camera's side, no light through the lip.
  const mask = await draw(
    { ...base, scatter: [0.8, 0.8, 0.8], foam: [0.8, 0.8, 0.8], transmission: 0 },
    [0.2, 0.6, -0.77],
  );
  // The sun low behind the wave, shining toward the camera.
  const behind = [0.1, 0.35, 0.93];
  const dark = await draw({ ...base, transmission: 0 }, behind);
  const lit = await draw({ ...base, transmission: 2 }, behind);
  const muddy = await draw({ ...base, transmission: 2, sediment: 5 }, behind);
  const validation = await page.evaluate(async () => {
    const { engine, wave, ground } = window.breakTest;
    wave.destroy();
    ground.destroy();
    const error = await engine.gpu.popErrorScope();
    return error?.message ?? null;
  });

  await writeFile('test-results/water-breaking-mask.png', mask);
  await writeFile('test-results/water-breaking-lit.png', lit);
  await writeFile('test-results/water-breaking-dark.png', dark);
  await writeFile('test-results/water-breaking-muddy.png', muddy);
  const [M, D, L, U] = await Promise.all([mask, dark, lit, muddy].map((b) => decodePNG(b)));
  const px = (img, x, y) => {
    const i = (y * img.width + x) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  // Runs of drawn (bright) and empty pixels down a column of the mask, top to bottom.
  const runs = (x) => {
    const out = [];
    for (let y = 0; y < M.height; y++) {
      const on = lum(px(M, x, y)) > 40;
      if (!out.length || out.at(-1).on !== on) out.push({ on, from: y, to: y });
      else out.at(-1).to = y;
    }
    return out.filter((r) => r.to - r.from >= 1);
  };
  // A column shows the tube when it runs empty, drawn (the jet), empty (the tube), drawn (the floor).
  // The crest: the highest drawn pixel. The camera looks along +z, so ahead of the front (+x) is to its left; the
  // back, a sheet over the flood's own surface, is to its right.
  let crest = 0,
    top = M.height;
  for (let x = 0; x < M.width; x++) {
    const first = runs(x).find((r) => r.on);
    if (first && first.from < top) (top = first.from), (crest = x);
  }
  // The column ahead of the crest with the widest tube.
  let tube = null;
  for (let x = 0; x < crest; x++) {
    const r = runs(x),
      i = r.findIndex((run, j) => run.on && j > 0 && r[j - 1].on === false && r[j + 1]?.on === false && r[j + 2]?.on);
    if (i > 0 && (!tube || r[i + 1].to - r[i + 1].from > tube.hollow.to - tube.hollow.from))
      tube = { x, jet: r[i], hollow: r[i + 1] };
  }
  // Mean colour of the jet pixels of the tube column's neighbourhood.
  const jetMean = (img) => {
    const s = [0, 0, 0];
    let k = 0;
    for (let x = tube.x - 2; x <= tube.x + 2; x++)
      for (let y = tube.jet.from; y <= tube.jet.to; y++) {
        if (lum(px(M, x, y)) <= 40) continue;
        const c = px(img, x, y);
        for (let j = 0; j < 3; j++) s[j] += c[j];
        k++;
      }
    return s.map((v) => v / Math.max(1, k));
  };
  const report = {
    backend: hardware?.compat ? 'webgl2' : 'webgpu',
    tube,
    jet: tube && { dark: jetMean(D), lit: jetMean(L), muddy: jetMean(U) },
  };
  console.log(JSON.stringify(report));
  assert.equal(validation, null);
  assert.deepEqual(errors, []);
  assert.ok(tube, 'a column runs sky, jet, tube, floor: the crest overturns');
  assert.ok(tube.hollow.to - tube.hollow.from >= 3, 'the tube is open under the lip');
  assert.ok(lum(report.jet.lit) > lum(report.jet.dark) + 4, 'light through the lip brightens it');
  const ratio = (c) => c[0] / Math.max(1, c[2]);
  // Part of the jet is white water (the crest), which sediment leaves as it is: the rest turns red over blue.
  assert.ok(ratio(report.jet.muddy) > ratio(report.jet.lit) * 1.1, 'sediment browns the lip');
  assert.ok(report.jet.muddy[2] < report.jet.lit[2] - 10, 'sediment takes the blue out of the light through the lip');
  await writeFile(`test-results/water-breaking-${report.backend}.json`, JSON.stringify(report, null, 2));
} finally {
  await closeAll({ browser });
}
