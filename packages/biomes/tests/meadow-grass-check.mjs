// Real-GPU proof of KB-BIOMES-SPARSEGRASS1 (run from the repository root after building packages):
//   node packages/biomes/tests/meadow-grass-check.mjs
// A BiomeView meadow seen from eye height must read as a sward, not tufts on bare ground. Before the fix its grass was
// a three-blade clump mesh at the 400,000 candidate cap over the 240 m detail square, about 7 clumps a square metre:
// from 0.9 m up, grass covered 11.3 percent of the ground below the horizon and the soil showed between the tufts (RTX
// A6000). Now the grass detail draws GrassScatter tussocks, a dense layer of 120 clumps a square metre within 20 m and
// the field beyond it, and covers 98.6 percent (at least 95 asserted); the field fades in where the near layer shrinks
// out, so no ring shows.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

const W = 640,
  H = 360;
const context = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
await page.setViewportSize({ width: W, height: H });
await runSuite(
  async () => {
    const info = await page.evaluate(
      async ([W, H]) => {
        const { Engine } = await import('/packages/core/dist/index.js');
        const { BiomeWorld } = await import('/packages/biomes/dist/index.js');
        const { presets } = await import('/packages/biomes/dist/presets.js');
        const { BiomeView } = await import('/packages/biomes/dist/view.js');
        const { GrassScatter } = await import('/packages/scatter/dist/grass.js');
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        canvas.style.cssText = `width:${W}px;height:${H}px;display:block`;
        document.body.style.margin = '0';
        document.body.replaceChildren(canvas);
        const engine = await Engine.create(canvas, {
          backend: 'webgpu',
          exactSize: true,
          camera: { position: [0, 40.9, 0], target: [10, 40.5, -10], near: 0.05, far: 3000, fov: 45 },
        });
        engine.stop();
        const errors = [];
        engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
        engine.lighting.direction.set([0.4, 0.7, 0.3]);
        // Open grassland: the temperate preset without trees or shrubs, on flat ground at 40 m.
        const world = await BiomeWorld.create({
          size: [512, 512],
          biomes: [{ ...presets.temperate, plants: [] }],
          height: { field: () => 40 },
          climate: { latitude: 47, rainfall: 1000 },
        });
        const view = await BiomeView.attach(engine, world, { radius: 600 });
        await view.ready;
        await view.whenIdle();
        const grass = view.objects.swaying.filter((s) => s instanceof GrassScatter);
        window.meadow = { engine, grass, errors };
        engine.render({ delta: 1 / 60 });
        await engine.gpu.queue.onSubmittedWorkDone();
        return grass.map((s) => ({ count: s.options.count, area: s.options.area, inner: s.options.inner ?? 0 }));
      },
      [W, H],
    );
    // Two GrassScatter layers for the one grass detail: the dense near square and the field across detailRadius.
    assert.equal(info.length, 2, `grass layers: ${JSON.stringify(info)}`);
    const [field, near] = info;
    assert.equal(near.area[0], 40, 'the near layer covers 20 m around the camera');
    assert.ok(near.count / near.area[0] ** 2 >= 100, `near clumps a square metre: ${near.count / near.area[0] ** 2}`);
    assert.equal(field.inner, 16, 'the field starts where the near layer shrinks out');
    const withGrass = await page.locator('canvas').screenshot();
    await page.evaluate(async () => {
      const { engine, grass } = window.meadow;
      for (const s of grass) s.dispose();
      engine.render({ delta: 1 / 60 });
      await engine.gpu.queue.onSubmittedWorkDone();
    });
    const bare = await page.locator('canvas').screenshot();
    // Share of the pixels below the horizon (the lower 45 percent of the frame) that the grass changes.
    const covered = await page.evaluate(
      async ([a, b]) => {
        const pixels = async (base64) => {
          const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob()),
            c = new OffscreenCanvas(bitmap.width, bitmap.height),
            g = c.getContext('2d');
          g.drawImage(bitmap, 0, 0);
          return g.getImageData(0, 0, bitmap.width, bitmap.height);
        };
        const [p, q] = [await pixels(a), await pixels(b)],
          { width, height } = p,
          top = Math.ceil(height * 0.55);
        let changed = 0;
        for (let y = top; y < height; y++)
          for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4,
              d = Math.abs(p.data[i] - q.data[i]) + Math.abs(p.data[i + 1] - q.data[i + 1]) + Math.abs(p.data[i + 2] - q.data[i + 2]);
            if (d > 24) changed++;
          }
        return changed / (width * (height - top));
      },
      [withGrass.toString('base64'), bare.toString('base64')],
    );
    const errors = await page.evaluate(() => window.meadow.errors);
    assert.deepEqual(errors, []);
    assert.deepEqual(pageErrors, []);
    assert.ok(covered >= 0.95, `grass covers ${(covered * 100).toFixed(1)} percent of the ground below the horizon`);
    console.log(
      `ok meadow grass: ${(covered * 100).toFixed(1)} percent of the ground covered; near layer`,
      near.count / near.area[0] ** 2,
      'clumps a square metre',
    );
  },
  () => context.close(),
);
watchExit();
