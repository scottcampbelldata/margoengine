import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';
await postBrowser(
  'post-curvature',
  5386,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js');
      const { Curvature } = await import('/packages/post/dist/curvature.js');
      const engine = await Engine.create(document.querySelector('canvas'), {
        backend: 'webgpu',
        camera: { position: [0, 0, 5], target: [0, 0, 0] },
      });
      engine.stop();
      engine
        .createMesh()
        .setGeometry(box(8, 8, 0.1))
        .setMaterial(new PbrMaterial({ color: '#707070' }));
      const textures = [];
      for (const sign of [0, 1, -1]) {
        const data = new Float16Array(320 * 240 * 4);
        for (let y = 0; y < 240; y++)
          for (let x = 0; x < 320; x++) {
            const nx = sign * 0.8 * ((x + 0.5) / 320 - 0.5),
              ny = -sign * 0.8 * ((y + 0.5) / 240 - 0.5),
              length = Math.hypot(nx, ny, 1);
            data.set([nx / length, ny / length, 1 / length, 1], 4 * (y * 320 + x));
          }
        const texture = engine.gpu.createTexture({ size: [320, 240], format: 'rgba16float', usage: 6 });
        engine.gpu.queue.writeTexture({ texture }, data, { bytesPerRow: 2560 }, [320, 240]);
        textures.push(texture);
      }
      let active = textures[0];
      const effect = Curvature.attach(engine, { normal: () => active, ridge: 2, valley: 2, normalSpace: 'view' });
      window.t = {
        engine,
        effect,
        textures,
        set: (index) => {
          active = textures[index];
        },
      };
    });
    const frame = async (index, enabled = true) => {
      await page.evaluate(
        async ([index, enabled]) => {
          const t = window.t;
          t.set(index);
          t.effect.options.enabled = enabled;
          t.engine.render({ delta: 1 / 60 });
          await t.engine.gpu.queue.onSubmittedWorkDone();
        },
        [index, enabled],
      );
      return shot();
    };
    const flat = await frame(0),
      off = await frame(1, false),
      ridge = await frame(1),
      valley = await frame(2);
    assert.deepEqual(flat.data, off.data, 'flat normals leave shading unchanged');
    let brighter = 0,
      darker = 0,
      wrongRidge = 0,
      wrongValley = 0;
    for (let i = 0; i < flat.data.length; i += 4) {
      if (ridge.data[i] > flat.data[i]) brighter++;
      if (valley.data[i] < flat.data[i]) darker++;
      if (ridge.data[i] < flat.data[i]) wrongRidge++;
      if (valley.data[i] > flat.data[i]) wrongValley++;
    }
    console.log({ brighter, darker, wrongRidge, wrongValley });
    assert.ok(brighter > 50000);
    assert.ok(darker > 50000);
    assert.equal(wrongRidge, 0);
    assert.equal(wrongValley, 0);
    // A camera on +X has view right -Z and view up +Y. Supply the same fields in world coordinates.
    await page.evaluate(async () => {
      const t = window.t,
        { box, PbrMaterial } = await import('/packages/core/dist/index.js');
      t.engine.camera.position = [30, 0, 0];
      t.engine
        .createMesh()
        .setGeometry(box(20, 20, 20))
        .setMaterial(new PbrMaterial({ color: '#707070' }));
      for (const sign of [1, -1]) {
        const data = new Float16Array(320 * 240 * 4);
        for (let y = 0; y < 240; y++)
          for (let x = 0; x < 320; x++) {
            const nx = sign * 0.8 * ((x + 0.5) / 320 - 0.5),
              ny = -sign * 0.8 * ((y + 0.5) / 240 - 0.5),
              length = Math.hypot(nx, ny, 1);
            data.set([1 / length, ny / length, -nx / length, 1], 4 * (y * 320 + x));
          }
        const texture = t.engine.gpu.createTexture({ size: [320, 240], format: 'rgba16float', usage: 6 });
        t.engine.gpu.queue.writeTexture({ texture }, data, { bytesPerRow: 2560 }, [320, 240]);
        t.textures.push(texture);
      }
      t.effect.options.normalSpace = 'world';
    });
    const worldOff = await frame(3, false),
      worldRidge = await frame(3),
      worldValley = await frame(4);
    let worldBrighter = 0,
      worldDarker = 0;
    for (let i = 0; i < worldOff.data.length; i += 4) {
      assert.ok(worldRidge.data[i] >= worldOff.data[i]);
      assert.ok(worldValley.data[i] <= worldOff.data[i]);
      if (worldRidge.data[i] > worldOff.data[i]) worldBrighter++;
      if (worldValley.data[i] < worldOff.data[i]) worldDarker++;
    }
    assert.ok(worldBrighter > 10000);
    assert.ok(worldDarker > 10000);
    console.log({ worldBrighter, worldDarker });
    await page.evaluate(() => {
      for (const texture of window.t.textures) texture.destroy();
      window.t.engine.dispose();
    });
  },
);
