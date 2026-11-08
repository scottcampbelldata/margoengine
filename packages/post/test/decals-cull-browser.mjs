// Real-GPU check of Decals culling, built packages. A grey floor under Bloom (the scene-depth capture), the camera at [0, 3, 4] looking at the
// origin. One red multiply decal on the floor alone, then the same decal among 4,095 others: 2,000 far to the side of
// the view, 2,045 behind the camera and 50 in view but under a tenth of a pixel across. The frame with all 4,096 equals
// the frame with the one decal exactly and draws one decal; without the decal the frame differs.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';

await postBrowser(
  'post-decals-cull',
  5364,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { Bloom } = await import('/packages/post/dist/bloom.js'),
        { Decals } = await import('/packages/post/dist/decals.js');
      const canvas = document.querySelector('canvas'),
        engine = await Engine.create(canvas, {
          backend: 'webgpu',
          camera: { position: [0, 3, 4], target: [0, 0, 0] },
        });
      engine.stop();
      engine
        .createMesh()
        .setGeometry(box(8, 0.2, 8))
        .setPosition([0, -0.1, 0])
        .setMaterial(new PbrMaterial({ color: '#808080', roughness: 1 }));
      Bloom.attach(engine);
      const decals = Decals.attach(engine),
        floor = (position, size) => ({ position, direction: [0, -1, 0], up: [0, 0, -1], width: size, height: size }),
        one = { ...floor([0, 0, 0], 1), color: [1, 0.2, 0.2] },
        others = [
          ...Array.from({ length: 2000 }, (_, i) => floor([(i % 2 ? 1 : -1) * (30 + (i % 40)), 0, (i % 9) - 4], 1)),
          ...Array.from({ length: 2045 }, (_, i) => floor([(i % 21) - 10, 0, 20 + (i % 20)], 1)),
          ...Array.from({ length: 50 }, (_, i) =>
            floor([(i % 10) * 0.3 - 1.5, 0, 1 + Math.floor(i / 10) * 0.3], 0.0005),
          ),
        ];
      window.t = {
        engine,
        decals,
        set: (all) => decals.setDecals(all ? [...others.slice(0, 2000), one, ...others.slice(2000)] : [one]),
        clear: () => decals.setDecals([]),
        frame: () => (engine.render({ delta: 1 / 60 }), engine.gpu.queue.onSubmittedWorkDone()),
      };
    });
    const frame = async (code) => {
      const drawn = await page.evaluate(`${code}; window.t.frame().then(() => window.t.decals.drawn)`);
      return { drawn, image: await shot() };
    };
    const none = await frame('window.t.clear()'),
      alone = await frame('window.t.set(false)'),
      among = await frame('window.t.set(true)'),
      count = await page.evaluate(() => window.t.decals.count);
    await page.evaluate(() => window.t.engine.dispose());
    let changed = 0,
      most = 0;
    for (let i = 0; i < alone.image.data.length; i++) {
      if (alone.image.data[i] !== none.image.data[i]) changed++;
      most = Math.max(most, Math.abs(among.image.data[i] - alone.image.data[i]));
    }
    console.log(JSON.stringify({ count, drawn: [none.drawn, alone.drawn, among.drawn], changed, most }));
    assert.equal(count, 4096);
    assert.deepEqual([none.drawn, alone.drawn, among.drawn], [0, 1, 1], 'only the decal in view is drawn');
    assert.ok(changed > 1000, 'the decal shows');
    assert.equal(most, 0, '4,096 decals with one in view equal that decal alone');
  },
);
