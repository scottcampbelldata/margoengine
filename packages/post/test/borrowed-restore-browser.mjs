// Real-GPU proof of the borrowed-object rule for the post effects that take a caller's texture, across a device restore
// (KB-RESTORE-BORROWED1): Lens `dirt`, LensFlare element `texture`, Decals `atlas`, MaterialDecals `atlas`. Run from the
// repository root after building packages, under the lock:
// node scripts/run-with-timeout.mjs --max=10 -- node packages/post/test/borrowed-restore-browser.mjs
// (MARGO_COMPAT=1 for the WebGL2 compatibility layer). Per effect: with the image, `engine.rebootDevice()`, then a plain
// image is dropped (the frame equals the one without the image, no validation error, one 'state' report linking
// #borrowed-lost), a new image brings the first picture back, and a `(device) => texture` image is made once per device
// and draws it again after a second restore with no report.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';

const differ = (a, b) => {
  let n = 0;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) n++;
  return n;
};

await postBrowser(
  'post-borrowed-restore',
  5365,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    const setup = async (build) => {
      await page.reload();
      await page.evaluate(async (code) => {
        const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js');
        const canvas = document.querySelector('canvas'),
          engine = await Engine.create(canvas, {
            backend: 'webgpu',
            camera: { position: [0, 3, 4], target: [0, 0, 0] },
          }),
          reported = [],
          uncaptured = [];
        engine.stop();
        engine.onError = (e) => reported.push(`${e?.code ?? ''} ${e?.message ?? e}`);
        const watch = (device) => device.addEventListener('uncapturederror', (e) => uncaptured.push(e.error.message));
        watch(engine.gpu);
        const texture = (device, rgba, size = 4) => {
          const t = device.createTexture({
            size: [size, size],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
          });
          device.queue.writeTexture(
            { texture: t },
            Uint8Array.from({ length: size * size * 4 }, (_, i) => rgba[i & 3]),
            { bytesPerRow: size * 4 },
            [size, size],
          );
          return t;
        };
        const frame = async () => {
          engine.render({ delta: 1 / 60 });
          await engine.gpu.queue.onSubmittedWorkDone();
        };
        const restore = async () => {
          const previous = engine.gpu;
          previous.destroy();
          await previous.lost;
          await engine.rebootDevice();
          watch(engine.gpu);
          for (let i = 0; i < 3; i++) await frame();
        };
        window.u = { engine, reported, uncaptured, texture, frame, restore, made: 0, PbrMaterial, box };
        await new Function('u', `return (async () => {${code}})()`)(window.u);
      }, build);
    };
    const run = (code) => page.evaluate(`(async () => {const u = window.u; ${code}; await u.frame();})()`);
    const reported = () => page.evaluate(() => window.u.reported);
    const uncaptured = () => page.evaluate(() => window.u.uncaptured);
    const made = () => page.evaluate(() => window.u.made);
    const finish = async (name, shots, expectedReport) => {
      const { plain, lost, none, again, fn, fnAfter } = shots;
      const rep = await reported();
      assert.deepEqual(await uncaptured(), [], `${name}: no validation error`);
      assert.ok(differ(plain, none) > 200, `${name}: the image shows (${differ(plain, none)} values differ)`);
      assert.equal(differ(lost, none), 0, `${name}: a lost plain image leaves the frame without it`);
      assert.equal(rep.length, 1, `${name}: one report ${JSON.stringify(rep)}`);
      assert.match(rep[0], expectedReport);
      assert.match(rep[0], /^state .*#borrowed-lost/);
      assert.equal(differ(again, plain), 0, `${name}: a new image brings the picture back`);
      assert.equal(differ(fn, plain), 0, `${name}: the function image draws it`);
      assert.equal(differ(fnAfter, plain), 0, `${name}: the function image is back after the restore`);
      assert.equal(await made(), 2, `${name}: made once per device`);
      console.log(`${name} ok`);
    };
    const sequence = async ({ name, report, withImage, without, fresh, asFunction, floor = true }) => {
      const shots = {};
      shots.none = (await run(without), await shot());
      await run(withImage);
      shots.plain = await shot();
      await run('await u.restore()');
      await run('');
      shots.lost = await shot();
      await run(fresh);
      shots.again = await shot();
      await run(`u.made = 0; ${asFunction}`);
      shots.fn = await shot();
      await run('await u.restore()');
      await run('');
      shots.fnAfter = await shot();
      await finish(name, shots, report);
    };
    const floorScene = `u.engine.createMesh().setGeometry(u.box(8, 0.2, 8)).setPosition([0, -0.1, 0]).setMaterial(new u.PbrMaterial({ color: '#808080', roughness: 1 }));`;

    // Lens: white dirt lit by two bright bars.
    await setup(`
      const { PostStack } = await import('/packages/post/dist/stack.js'), { Lens } = await import('/packages/post/dist/lens.js');
      for (const x of [-1, 1]) u.engine.createMesh().setGeometry(u.box(0.08, 3, 0.08)).setPosition([x, 0, 0]).setMaterial(new u.PbrMaterial({ color: '#ffffff' }));
      u.lens = new Lens({ dirtIntensity: 4, threshold: 0.4 });
      PostStack.attach(u.engine, [u.lens]);
      u.dirt = (device) => (u.made++, u.texture(device, [255, 255, 255, 255]));
      u.white = u.texture(u.engine.gpu, [255, 255, 255, 255]);
      u.lens.options.dirt = u.white;
    `);
    // The built-in smudges are what an omitted dirt draws, so "none" is the frame with the dirt removed.
    await sequence({
      name: 'Lens dirt',
      report: /Lens dirt lost with the device/,
      withImage: 'u.lens.options.dirt = u.white',
      without: 'u.lens.options.dirt = undefined',
      fresh: 'u.lens.options.dirt = u.texture(u.engine.gpu, [255, 255, 255, 255])',
      asFunction: 'u.lens.options.dirt = u.dirt',
    });

    // LensFlare: a white image at the light's position (the origin, in view).
    await setup(`
      const { LensFlare } = await import('/packages/post/dist/lens-flare.js');
      u.flare = LensFlare.attach(u.engine, { position: () => [0, 0, 0] });
      u.img = u.texture(u.engine.gpu, [255, 255, 255, 255]);
      u.fn = (device) => (u.made++, u.texture(device, [255, 255, 255, 255]));
    `);
    await sequence({
      name: 'LensFlare element texture',
      report: /LensFlare element texture lost with the device/,
      withImage: 'u.flare.options.elements = [{ texture: u.img, size: 150 }]',
      without: 'u.flare.options.elements = [{ size: 150, color: [0, 0, 0] }]',
      fresh: 'u.flare.options.elements = [{ texture: u.texture(u.engine.gpu, [255, 255, 255, 255]), size: 150 }]',
      asFunction: 'u.flare.options.elements = [{ texture: u.fn, size: 150 }]',
    });

    // Decals: a red atlas on a grey floor, under Bloom (the scene-depth capture).
    await setup(`
      ${floorScene}
      const { Bloom } = await import('/packages/post/dist/bloom.js'), { Decals } = await import('/packages/post/dist/decals.js');
      Bloom.attach(u.engine);
      u.decals = Decals.attach(u.engine);
      u.decal = { position: [0, 0, 0], direction: [0, -1, 0], up: [0, 0, -1], width: 2, height: 2 };
      u.img = u.texture(u.engine.gpu, [255, 40, 40, 255]);
      u.fn = (device) => (u.made++, u.texture(device, [255, 40, 40, 255]));
    `);
    await sequence({
      name: 'Decals atlas',
      report: /Decals atlas lost with the device/,
      withImage: 'u.decals.setDecals([u.decal]); u.decals.setAtlas(u.img)',
      without: 'u.decals.setDecals([])',
      fresh: 'u.decals.setAtlas(u.texture(u.engine.gpu, [255, 40, 40, 255]))',
      asFunction: 'u.decals.setAtlas(u.fn)',
    });

    // MaterialDecals: a normal atlas tilted toward the sun on a grey floor.
    await setup(`
      ${floorScene}
      const { PostStack } = await import('/packages/post/dist/stack.js'), { SceneTargets } = await import('/packages/post/dist/mrt.js'),
        { MaterialDecals } = await import('/packages/post/dist/material-decals.js');
      const targets = SceneTargets.attach(u.engine, { outputs: { albedo: 'albedo', normal: 'normal', material: 'material' } });
      u.md = new MaterialDecals({ targets: () => ({ albedo: targets.texture('albedo'), normal: targets.texture('normal'), material: targets.texture('material') }) });
      PostStack.attach(u.engine, [u.md]);
      u.decal = { position: [0, 0, 0], direction: [0, -1, 0], up: [0, 0, 1], width: 3, height: 3, depth: 0.4 };
      u.img = u.texture(u.engine.gpu, [218, 128, 218, 255]);
      u.fn = (device) => (u.made++, u.texture(device, [218, 128, 218, 255]));
    `);
    await sequence({
      name: 'MaterialDecals atlas',
      report: /MaterialDecals atlas lost with the device/,
      withImage: 'u.md.setDecals([u.decal]); u.md.options.atlas = u.img',
      without: 'u.md.setDecals([])',
      fresh: 'u.md.options.atlas = u.texture(u.engine.gpu, [218, 128, 218, 255])',
      asFunction: 'u.md.options.atlas = u.fn',
    });
  },
  { seconds: 540 },
);
