// Real-GPU check of Blur's zoom and spin kinds, built packages. A small light box sits right of the frame centre. A zoom
// about the centre streaks it outward along its ray and leaves the pixel just off that ray; a spin streaks it along the
// circle and leaves the pixel further out. Strength 0 equals disabled to the bit, as does a sharp radius over the whole
// frame; `region` keeps the rest of the frame; rays only add light, and none above the threshold.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';

await postBrowser(
  'post-radial-blur',
  5398,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { PostStack } = await import('/packages/post/dist/stack.js'),
        { Blur } = await import('/packages/post/dist/blur.js');
      const canvas = document.querySelector('canvas'),
        engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 0, 5], target: [0, 0, 0] } });
      engine.stop();
      engine
        .createMesh()
        .setGeometry(box(0.5, 0.5, 0.1))
        .setPosition([1.2, 0, 0])
        .setMaterial(new PbrMaterial({ color: '#ffffff', roughness: 1 }));
      const effect = new Blur({ kind: 'zoom' });
      PostStack.attach(engine, [effect]);
      window.t = {
        engine,
        effect,
        frame: () => (engine.render({ delta: 1 / 60 }), engine.gpu.queue.onSubmittedWorkDone()),
      };
    });
    const frame = async (options) => {
      await page.evaluate((next) => {
        const o = window.t.effect.options;
        for (const key of Object.keys(o)) delete o[key];
        Object.assign(o, next);
        return window.t.frame();
      }, options);
      await page.evaluate(() => window.t.engine.gpu.queue.onSubmittedWorkDone());
      return shot();
    };
    const wide = { strength: 0.6, samples: 64 };
    const off = await frame({ kind: 'zoom', enabled: false });
    const still = await frame({ kind: 'zoom', strength: 0 });
    const sharp = await frame({ kind: 'zoom', ...wide, innerRadius: 10 });
    const zoom = await frame({ kind: 'zoom', ...wide });
    const spin = await frame({ kind: 'spin', ...wide });
    const left = await frame({ kind: 'zoom', ...wide, region: [0, 0, 0.5, 1] });
    const rays = await frame({ kind: 'zoom', ...wide, rays: 2, threshold: 0 });
    const none = await frame({ kind: 'zoom', ...wide, rays: 2, threshold: 64 });
    const most = (a, b) => a.data.reduce((m, v, i) => Math.max(m, Math.abs(v - b.data[i])), 0);
    const delta = (img, x, y) => img.data[4 * (y * img.width + x)] - off.data[4 * (y * img.width + x)];
    const out = [250, 120],
      around = [206, 100];
    const seen = {
      still: most(still, off),
      sharp: most(sharp, off),
      zoom: [delta(zoom, ...out), delta(zoom, ...around)],
      spin: [delta(spin, ...out), delta(spin, ...around)],
      left: most(left, off),
      rays: [delta(rays, ...out), rays.data.reduce((m, v, i) => Math.min(m, v - off.data[i]), 0)],
      none: most(none, off),
    };
    console.log(JSON.stringify(seen));
    await page.evaluate(() => window.t.engine.dispose());
    assert.equal(seen.still, 0, 'strength 0 equals disabled');
    assert.ok(seen.sharp <= 1, `inside innerRadius the frame stays: ${seen.sharp}`);
    assert.ok(seen.zoom[0] > 20 && Math.abs(seen.zoom[1]) <= 2, `zoom streaks along the ray: ${seen.zoom}`);
    assert.ok(seen.spin[1] > 20 && Math.abs(seen.spin[0]) <= 2, `spin streaks along the circle: ${seen.spin}`);
    assert.ok(seen.left <= 1, `outside the region (the box's half) nothing changes: ${seen.left}`);
    assert.ok(seen.rays[0] > 20 && seen.rays[1] >= -1, `rays only add light: ${seen.rays}`);
    assert.ok(seen.none <= 1, `no light above the threshold, no rays: ${seen.none}`);
  },
);
