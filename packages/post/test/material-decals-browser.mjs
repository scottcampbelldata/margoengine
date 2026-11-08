// Real-GPU check of MaterialDecals, built packages. A rough grey floor under the default sun, seen from where the sun's
// mirror reflection lands at the origin, with a SceneTargets capture of its surface. One decal at a time: a normal map
// tilted toward the sun brightens what it covers and one tilted away darkens it; a smooth decal (roughness 0.05) shows
// the sun's highlight; a metal decal loses the diffuse light and darkens; a flat decal that changes nothing, no capture,
// and disabled all equal the frame without decals exactly.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';

await postBrowser(
  'post-material-decals',
  5363,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { PostStack } = await import('/packages/post/dist/stack.js'),
        { SceneTargets } = await import('/packages/post/dist/mrt.js'),
        { MaterialDecals } = await import('/packages/post/dist/material-decals.js');
      const canvas = document.querySelector('canvas'),
        // The default sun points along [3, 5, 4]: its mirror direction off the floor is [-3, 5, -4].
        engine = await Engine.create(canvas, {
          backend: 'webgpu',
          camera: { position: [-1.2, 2, -1.6], target: [0, 0, 0] },
        });
      engine.stop();
      engine
        .createMesh()
        .setGeometry(box(8, 0.2, 8))
        .setPosition([0, -0.1, 0])
        .setMaterial(new PbrMaterial({ color: '#808080', roughness: 1 }));
      const targets = SceneTargets.attach(engine, {
          outputs: { albedo: 'albedo', normal: 'normal', material: 'material' },
        }),
        atlas = engine.gpu.createTexture({
          size: [4, 1],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
      // Texels 0 and 1: a normal tilted 45 degrees along the decal's right axis; 2 and 3: against it. Alpha full.
      const toward = [218, 128, 218, 255],
        away = [38, 128, 218, 255];
      engine.gpu.queue.writeTexture(
        { texture: atlas },
        new Uint8Array([...toward, ...toward, ...away, ...away]),
        { bytesPerRow: 16 },
        [4, 1],
      );
      const options = {
          targets: () => ({
            albedo: targets.texture('albedo'),
            normal: targets.texture('normal'),
            material: targets.texture('material'),
          }),
          atlas,
        },
        decals = new MaterialDecals(options);
      PostStack.attach(engine, [decals]);
      window.t = {
        engine,
        decals,
        options,
        frame: () => (engine.render({ delta: 1 / 60 }), engine.gpu.queue.onSubmittedWorkDone()),
      };
    });
    // The sun's right-hand side on the floor: right = up x direction = +x for a decal pointing down with up [0, 0, 1].
    const frame = async (set) => {
      await page.evaluate(`(${set})(window.t.decals, window.t.options); window.t.frame()`);
      await page.evaluate(() => window.t.engine.gpu.queue.onSubmittedWorkDone());
      return shot();
    };
    const box = '{position: [0, 0, 0], direction: [0, -1, 0], up: [0, 0, 1], width: 1, height: 1, depth: 0.4';
    const off = await frame('(d) => d.setDecals([])');
    const toward = await frame(`(d) => d.setDecals([${box}, rect: [0, 0, 0.25, 1]}])`);
    const away = await frame(`(d) => d.setDecals([${box}, rect: [0.75, 0, 1, 1]}])`);
    const smooth = await frame(`(d) => d.setDecals([${box}, rect: [0, 0, 0.01, 1], bump: 0, roughness: 0.05}])`);
    const metal = await frame(`(d) => d.setDecals([${box}, rect: [0, 0, 0.01, 1], bump: 0, metalness: 1}])`);
    const flat = await frame(`(d) => d.setDecals([${box}, rect: [0, 0, 0.01, 1], bump: 0}])`);
    const bare = await frame('(d, o) => { const t = o.targets; o.targets = () => undefined; window.t.keep = t; }');
    const disabled = await frame('(d, o) => { o.targets = window.t.keep; o.enabled = false; }');
    await page.evaluate(() => window.t.engine.dispose());
    /** Pixels brighter and darker than `off` by more than 2/255 in luminance, and the largest difference. */
    const compare = (img) => {
      let brighter = 0,
        darker = 0,
        most = 0;
      for (let i = 0; i < img.data.length; i += 4) {
        const luma = (d) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2],
          change = luma(img.data) - luma(off.data);
        for (let c = 0; c < 3; c++) most = Math.max(most, Math.abs(img.data[i + c] - off.data[i + c]));
        if (change > 2) brighter++;
        if (change < -2) darker++;
      }
      return { brighter, darker, most };
    };
    const result = Object.fromEntries(
      Object.entries({ toward, away, smooth, metal, flat, bare, disabled }).map(([k, v]) => [k, compare(v)]),
    );
    console.log(JSON.stringify(result));
    assert.ok(result.toward.brighter > 2000 && result.toward.darker === 0, 'a normal toward the sun brightens');
    assert.ok(result.away.darker > 2000 && result.away.brighter === 0, 'a normal away from the sun darkens');
    assert.ok(result.smooth.brighter > 200, 'a smooth decal shows the sun highlight');
    assert.ok(result.metal.darker > 2000 && result.metal.brighter === 0, 'a metal decal loses its diffuse light');
    for (const name of ['flat', 'bare', 'disabled']) assert.equal(result[name].most, 0, `${name} equals no decals`);
  },
);
