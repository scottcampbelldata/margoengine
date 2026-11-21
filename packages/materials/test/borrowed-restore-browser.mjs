// Real-GPU proof of the borrowed-object rule for the materials options that take a caller's GPU object, across a device
// restore (KB-RESTORE-BORROWED1): `Material.envMap` (a plain cube target) and `Texture.source` (a plain GPUTexture).
// Run from the repository root after building packages:
// node scripts/run-with-timeout.mjs --max=10 -- node packages/materials/test/borrowed-restore-browser.mjs
// (MARGO_COMPAT=1 for the WebGL2 compatibility layer). Per option: with the object, `engine.rebootDevice()`, then a plain
// object is dropped (no validation error, one 'state' report linking #borrowed-lost, the frame keeps drawing: the
// envMap reflects black, the map reads what an omitted map reads), a new object brings the first picture back, and a
// `(device) => object` is made once per device and draws it again after a second restore with no report.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from '../../post/test/post-browser.mjs';

const differ = (a, b) => {
  let n = 0;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) n++;
  return n;
};

await postBrowser(
  'materials-borrowed-restore',
  5394,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    const setup = async () => {
      await page.reload();
      await page.evaluate(async () => {
        const { Engine } = await import('/packages/core/dist/index.js');
        const { UnlitMaterial, Texture, createMesh } = await import('/packages/materials/dist/index.js');
        const { boxGeometry } = await import('/packages/geometry/dist/index.js');
        const canvas = document.querySelector('canvas'),
          engine = await Engine.create(canvas, {
            backend: 'webgpu',
            camera: { position: [0, 0, 4], target: [0, 0, 0] },
          }),
          reported = [],
          uncaptured = [];
        engine.stop();
        engine.onError = (e) => reported.push(`${e?.code ?? ''} ${e?.message ?? e}`);
        const watch = (device) => device.addEventListener('uncapturederror', (e) => uncaptured.push(e.error.message));
        watch(engine.gpu);
        const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
        const fill = (device, texture, rgba, layers) => {
          const size = 4;
          for (let layer = 0; layer < layers; layer++)
            device.queue.writeTexture(
              { texture, origin: [0, 0, layer] },
              Uint8Array.from({ length: size * size * 4 }, (_, i) => rgba[i & 3]),
              { bytesPerRow: size * 4 },
              [size, size],
            );
        };
        // A flat texture and a cube target {texture, view} of one colour.
        const flat = (device, rgba) => {
          const t = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage });
          fill(device, t, rgba, 1);
          return t;
        };
        const cube = (device, rgba) => {
          const t = device.createTexture({ size: [4, 4, 6], format: 'rgba8unorm', usage });
          fill(device, t, rgba, 6);
          return { texture: t, view: t.createView({ dimension: 'cube' }) };
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
        window.u = {
          engine,
          reported,
          uncaptured,
          flat,
          cube,
          frame,
          restore,
          made: 0,
          UnlitMaterial,
          Texture,
          createMesh,
          boxGeometry,
        };
        u.material = new UnlitMaterial({ color: '#ffffff' });
        u.mesh = createMesh(engine, boxGeometry(3, 3, 3), u.material);
      });
    };
    const run = (code) => page.evaluate(`(async () => {const u = window.u; ${code}; await u.frame();})()`);
    const reported = () => page.evaluate(() => window.u.reported);
    const uncaptured = () => page.evaluate(() => window.u.uncaptured);
    const made = () => page.evaluate(() => window.u.made);
    const clear = () => page.evaluate(() => (window.u.reported.length = 0));

    const sequence = async ({ name, report, withObject, without, fresh, asFunction, reference }) => {
      const shots = {};
      await clear();
      await run(without);
      shots.none = await shot();
      await run(reference ?? without);
      shots.reference = await shot();
      await run(withObject);
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
      const rep = await reported();
      assert.deepEqual(await uncaptured(), [], `${name}: no validation error`);
      assert.ok(
        differ(shots.plain, shots.none) > 200,
        `${name}: the object shows (${differ(shots.plain, shots.none)})`,
      );
      assert.equal(differ(shots.lost, shots.reference), 0, `${name}: a lost plain object leaves the frame without it`);
      assert.equal(rep.length, 1, `${name}: one report ${JSON.stringify(rep)}`);
      assert.match(rep[0], report);
      assert.match(rep[0], /^state .*#borrowed-lost/);
      assert.equal(differ(shots.again, shots.plain), 0, `${name}: a new object brings the picture back`);
      assert.equal(differ(shots.fn, shots.plain), 0, `${name}: the function object draws it`);
      assert.equal(differ(shots.fnAfter, shots.plain), 0, `${name}: the function object is back after the restore`);
      assert.equal(await made(), 2, `${name}: made once per device`);
      console.log(`${name} ok`);
    };
    await setup();
    await run("u.material.combine = 'mix'; u.material.reflectivity = 1");

    await sequence({
      name: 'Material envMap',
      report: /Material envMap lost with the device/,
      withObject: 'u.material.envMap = u.cube(u.engine.gpu, [0, 255, 0, 255])',
      without: 'u.material.envMap = null',
      // The reference of a lost cube is a black cube of the new device (made before the first restore it is lost too,
      // so the frame is taken from a second material's black cube after the restore below).
      fresh: 'u.material.envMap = u.cube(u.engine.gpu, [0, 255, 0, 255])',
      asFunction: 'u.material.envMap = (device) => (u.made++, u.cube(device, [0, 255, 0, 255]))',
      reference: 'u.material.envMap = () => u.cube(u.engine.gpu, [0, 0, 0, 255]);',
    });

    // Texture source: a red GPUTexture as the map of a white unlit material. A lost one reads as no map (white).
    await setup();
    await run(`u.map = null;
      u.map = new u.Texture(u.flat(u.engine.gpu, [255, 0, 0, 255]));`);
    await sequence({
      name: 'Texture source',
      report: /Texture source lost with the device/,
      withObject: 'u.material.map = u.map',
      without: 'u.material.map = null',
      fresh: 'u.map.setSource(u.flat(u.engine.gpu, [255, 0, 0, 255])); u.material.map = u.map',
      asFunction: 'u.material.map = new u.Texture((device) => (u.made++, u.flat(device, [255, 0, 0, 255])))',
    });
  },
  { seconds: 300 },
);
