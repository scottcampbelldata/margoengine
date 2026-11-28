// Real-GPU check that ambient occlusion leaves no pale outlines along covered grass blades (KB-SCATTER-AOFRINGE1) and
// still darkens the ground under them, built packages, GTAO by default or SSAO with --effect=ssao, on WebGPU and with
// --compat the WebGL2 layer:
//   node scripts/run-with-timeout.mjs --max=10 -- node packages/scatter/test/grass-ao-fringe.browser.mjs
// A covered blade writes depth where a hash of its coverage passes, so a pixel it barely covers can hold its depth while
// most of its colour is the floor. Before the fix the occlusion of such a pixel was found at the blade's depth, so the
// floor's share of it stayed lit while the bare floor beside it darkened: a one-pixel line brighter than everything
// around it. A pale pixel is one whose luma is over 8 codes above the median of its 5 x 5 neighbourhood with the effect
// on and not with it off. The grass must still darken the floor (over 3 percent of the frame by over 8 codes), so taking
// the occlusion out cannot pass, and a view with no blade in it must draw exactly as it does with no grass at all.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from '../../post/test/post-browser.mjs';

const compat = process.argv.includes('--compat'),
  effectName = process.argv.find((a) => a.startsWith('--effect='))?.slice(9) ?? 'gtao';
if (compat) process.env.MARGO_COMPAT = '1';
assert.ok(effectName === 'gtao' || effectName === 'ssao', '--effect is gtao or ssao');
await postBrowser(
  'scatter-grass-ao-fringe',
  5471,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async (effectName) => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { GTAO, SSAO } = await import('/packages/post/dist/index.js'),
        { GrassScatter } = await import('/packages/scatter/dist/grass.js'),
        { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
      const canvas = document.querySelector('canvas'),
        engine = await Engine.create(canvas, {
          backend: 'webgpu',
          camera: { position: [0, 1.4, 3.2], target: [0, 0.15, 0], fov: 45, near: 0.1, far: 80 },
        });
      engine.stop();
      const errors = [];
      engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
      engine.scene.background = '#b0b0b0';
      engine.lighting.radiance.set([0, 0, 0]);
      engine.lighting.ambient.set([1, 1, 1]);
      engine.lighting.radiance[3] = 1;
      engine
        .createMesh()
        .setGeometry(box(120, 0.2, 120))
        .setMaterial(new PbrMaterial({ color: [0.62, 0.56, 0.44], roughness: 1 }))
        .position.set(0, -0.1, 0);
      const grass = GrassScatter.attach(engine, {
        count: 260,
        area: [7, 7],
        lod: [30, 60, 90],
        lodFade: 0,
        seed: 5,
        grass: { height: 0.5, width: 0.012, blades: 18, radius: 0.18, lean: 0.5 },
        material: new PbrMaterial({ color: [0.36, 0.31, 0.16], roughness: 0.9, doubleSided: true }),
      });
      const effect =
        effectName === 'ssao'
          ? SSAO.attach(engine, { radius: 0.5, samples: 32 })
          : GTAO.attach(engine, { radius: 0.5, slices: 3, steps: 8 });
      await waitForPipelines(async () => {
        engine.render({ delta: 0 });
        await engine.gpu.queue.onSubmittedWorkDone();
      });
      window.check = {
        async frame(enabled) {
          effect.enabled = enabled;
          await waitForPipelines(async () => {
            engine.render({ delta: 0 });
            await engine.gpu.queue.onSubmittedWorkDone();
          });
          return errors.splice(0);
        },
        // A view of bare floor far from the grass.
        away() {
          engine.camera.position = [45, 1.4, 3.2];
          engine.camera.target = [45, 0.15, 0];
        },
        removeGrass() {
          grass.dispose();
        },
      };
    }, effectName);
    const luma = (d, p) => 0.2126 * d[p * 4] + 0.7152 * d[p * 4 + 1] + 0.0722 * d[p * 4 + 2];
    // Pixels over 8 codes of luma above the median of their 5 x 5 neighbourhood.
    const pale = (image) => {
      const { width, height, data } = image,
        out = new Uint8Array(width * height),
        window = [];
      for (let y = 2; y < height - 2; y++)
        for (let x = 2; x < width - 2; x++) {
          window.length = 0;
          for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) window.push(luma(data, (y + j) * width + x + i));
          window.sort((a, b) => a - b);
          out[y * width + x] = luma(data, y * width + x) - window[12] > 8 ? 1 : 0;
        }
      return out;
    };
    assert.deepEqual(await page.evaluate(() => window.check.frame(false)), []);
    const open = await shot();
    assert.deepEqual(await page.evaluate(() => window.check.frame(true)), []);
    const shut = await shot();
    const paleOpen = pale(open),
      paleShut = pale(shut),
      pixels = open.width * open.height;
    let fringe = 0,
      darker = 0;
    for (let p = 0; p < pixels; p++) {
      if (paleShut[p] && !paleOpen[p]) fringe++;
      if (luma(open.data, p) - luma(shut.data, p) > 8) darker++;
    }
    console.log(
      `${effectName}${compat ? ' compat' : ''}: pale pixels along blades ${fringe}, occluded pixels ${darker} of ${pixels}`,
    );
    assert.ok(darker > pixels * 0.03, `the grass must still occlude the floor: ${darker} pixels`);
    // Before the fix (RTX A6000): GTAO 4,226 (WebGL2 layer 4,240), SSAO 2,038 (2,465); after: 1,096 (1,036) and 155
    // (448). What is left is no more frequent on the pixels a blade's depth covers than elsewhere: the pixel-scale
    // variation of the occlusion the hashed blade depth casts, which the blur only averages.
    const bound = pixels * (effectName === 'gtao' ? 0.02 : 0.012);
    assert.ok(fringe <= bound, `${fringe} pale pixels along the blades (at most ${Math.floor(bound)})`);
    // No blade in view: the frame is the one without any grass, byte for byte.
    await page.evaluate(() => window.check.away());
    assert.deepEqual(await page.evaluate(() => window.check.frame(true)), []);
    const withGrass = await shot();
    await page.evaluate(() => window.check.removeGrass());
    assert.deepEqual(await page.evaluate(() => window.check.frame(true)), []);
    const without = await shot();
    let hash = 2166136261;
    for (const v of without.data) hash = Math.imul(hash ^ v, 16777619) >>> 0;
    console.log(`bare-floor frame hash ${hash.toString(16)}`);
    assert.ok(Buffer.from(withGrass.data).equals(Buffer.from(without.data)), 'a view with no blade draws as with none');
    console.log(`ok ${effectName} leaves no pale outline along covered blades and still occludes`);
  },
  { seconds: 240 },
);
