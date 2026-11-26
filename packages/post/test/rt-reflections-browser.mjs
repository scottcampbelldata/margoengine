// Real-GPU check of @margoengine/post/rt-reflections, built packages; with MARGO_COMPAT=1 (or --compat) the same page
// runs on the WebGL2 compatibility layer. A white mirror floor under a red box that hangs above the top of the view, so
// SSR alone has nothing on screen to reflect. The box is also the only mesh of a GPUSceneBVH, with a plate far under the
// floor that only the sun's shadow rays can meet.
// - Mirror, default sun (from above): the floor shows the box's underside, which the sun does not reach, so each pixel
//   is display(weight x (albedo x ambient + emissive)) exactly; the median is within 2% of that closed form.
// - Sun from below with the plate between it and the box: the shadow ray finds the plate, the pixels stay as before.
//   With the plate moved away the underside is lit and brighter; with the plate back and `shadows: false` the frame
//   equals the unshadowed one exactly.
// - Rough floor (0.8) with `stochastic`: the traced rough rays bring the box into the floor.
// - A disposed scene runs as SSR: no red in the rough floor, and the mirror pixels are the plain SSR frame (dark).
// --mode= runs the page on another device (traced-device.js): 'half-float' (the layer's half-float tier) and
// 'compatibility' (native WebGPU at the compatibility level) trace as above. The level's default is 4 storage buffers in
// a fragment shader, what the traced passes bind, so no browser device is short of them; traced-fallback.test.js covers
// a device that is (rt-gi-browser.mjs runs the short case on a real device: RTGI binds 5).
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { pbrNeutral } from '../../shared/display.js';
import { postBrowser } from './post-browser.mjs';

const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.slice(7);
const albedo = [1, 0, 0],
  emissive = [0.5, 0, 0],
  ambientStrength = 0.15,
  // The floor's split-sum weight: white metal (F0 = F90 = 1) at core's least roughness 0.045 under SSR's analytic fit
  // (Karis 2014), 1 - 0.55 x roughness whatever the view angle.
  weight = 1 - 0.55 * 0.045;
// display(): Khronos PBR Neutral then the sRGB encoding, as the composite's toDisplay.
const display = (c) =>
  pbrNeutral(c.map((x) => Math.max(0, x))).map(
    (x) => 255 * (x >= 0.0031308 ? 1.055 * Math.pow(x, 1 / 2.4) - 0.055 : x * 12.92),
  );
const expected = display(albedo.map((a, i) => weight * (a * ambientStrength + emissive[i])))[0];

await postBrowser(
  'post-rt-reflections',
  5404,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(
      async ({ albedo, emissive, mode }) => {
        const { tracedDevice, legDevice } = await import('/packages/post/test/traced-device.js'),
          warnings = await tracedDevice(mode, 4);
        const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
          { MeshBVH } = await import('/packages/bvh/dist/index.js'),
          { GPUSceneBVH } = await import('/packages/bvh/dist/gpu-scene.js'),
          { PostStack } = await import('/packages/post/dist/stack.js'),
          { RTReflections } = await import('/packages/post/dist/rt-reflections.js');
        const canvas = document.querySelector('canvas'),
          engine = await Engine.create(canvas, {
            backend: 'webgpu',
            camera: { position: [0, 2, 3], target: [0, 0, 0] },
          });
        engine.stop();
        const floor = engine
          .createMesh()
          .setGeometry(box(8, 0.2, 8))
          .setPosition([0, -0.1, 0])
          .setMaterial(new PbrMaterial({ color: '#ffffff', roughness: 0, metalness: 1 }));
        const cube = box(2, 2, 2);
        engine
          .createMesh()
          .setGeometry(cube)
          .setPosition([0, 3.5, -4])
          .setMaterial(new PbrMaterial({ color: '#ff0000', roughness: 1 }));
        const at = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
        const scene = GPUSceneBVH.forShader(engine.gpu, [
          {
            bvh: MeshBVH.fromGeometry(cube),
            matrix: at(0, 3.5, -4),
            material: { color: albedo, emissive, roughness: 1 },
          },
          { bvh: MeshBVH.fromGeometry(box(4, 0.1, 4)), matrix: at(0, -5, -4), material: { color: [0.5, 0.5, 0.5] } },
        ]);
        const rt = new RTReflections({ scene, maxRoughness: 0.6 });
        PostStack.attach(engine, [rt]);
        window.t = {
          warnings,
          device: legDevice(engine),
          engine,
          rt,
          scene,
          floor,
          PbrMaterial,
          at,
          frames: async (n) => {
            for (let i = 0; i < n; i++) engine.render({ delta: 1 / 60 });
            await engine.gpu.queue.onSubmittedWorkDone();
          },
        };
      },
      { albedo, emissive, mode },
    );
    const frames = async (n, code = '') => {
      await page.evaluate(`${code}; window.t.frames(${n})`);
      return shot();
    };
    const mirror = await frames(2),
      shadowed = await frames(2, 'window.t.engine.lighting.direction.set([0, -1, 0, 3])'),
      lit = await frames(2, 'window.t.scene.setMatrix(1, window.t.at(50, -5, -4)); window.t.scene.update()'),
      unshadowed = await frames(
        2,
        'window.t.scene.setMatrix(1, window.t.at(0, -5, -4)); window.t.scene.update(); window.t.rt.options.shadows = false',
      ),
      rough = await frames(
        64,
        `window.t.rt.options.shadows = true; window.t.engine.lighting.direction.set([3, 5, 4, 3]);
        window.t.floor.setMaterial(new window.t.PbrMaterial({ color: '#ffffff', roughness: 0.8, metalness: 1 }));
        window.t.rt.options.stochastic = true`,
      ),
      roughPlain = await frames(64, 'window.t.scene.dispose()'),
      plain = await frames(
        2,
        `window.t.rt.options.stochastic = false;
        window.t.floor.setMaterial(new window.t.PbrMaterial({ color: '#ffffff', roughness: 0, metalness: 1 }))`,
      );
    const { device, warnings } = await page.evaluate(() => {
      window.t.engine.dispose();
      return {
        device: window.t.device,
        warnings: window.t.warnings.map((warning) => ({ code: warning?.code, message: String(warning?.message) })),
      };
    });

    // The box's reflection: clearly red pixels of the mirror frame.
    const mask = [];
    for (let i = 0; i < mirror.data.length; i += 4)
      if (mirror.data[i] > 100 && mirror.data[i + 1] < 40 && mirror.data[i + 2] < 40) mask.push(i);
    const median = (image) => {
      const values = mask.map((i) => image.data[i]).sort((a, b) => a - b);
      return values[values.length >> 1];
    };
    const most = (a, b) => {
      let out = 0;
      for (let i = 0; i < a.data.length; i += 4)
        for (let c = 0; c < 3; c++) out = Math.max(out, Math.abs(a.data[i + c] - b.data[i + c]));
      return out;
    };
    // Pixels where `image` is redder than `base`: red up by more than 6 while green and blue move by at most 2.
    const redder = (image, base) => {
      let n = 0;
      for (let i = 0; i < image.data.length; i += 4)
        if (
          image.data[i] - base.data[i] > 6 &&
          Math.abs(image.data[i + 1] - base.data[i + 1]) <= 2 &&
          Math.abs(image.data[i + 2] - base.data[i + 2]) <= 2
        )
          n++;
      return n;
    };
    const result = {
      device,
      warnings: warnings.length,
      expected: +expected.toFixed(2),
      pixels: mask.length,
      mirror: median(mirror),
      shadowed: median(shadowed),
      lit: median(lit),
      unshadowedVsLit: most(unshadowed, lit),
      roughRedder: redder(rough, roughPlain),
      roughPlainRedder: redder(roughPlain, rough),
      plainBrightest: Math.max(...mask.map((i) => plain.data[i])),
    };
    console.log(JSON.stringify(result));
    if (mode) assert.ok(device.includes(mode === 'half-float' ? '(half-float)' : 'compatibility level'), device);
    assert.equal(warnings.length, 0, 'no warning');
    assert.ok(result.pixels > 300, 'the off-screen box shows in the mirror floor');
    assert.ok(
      Math.abs(result.mirror - expected) <= 0.02 * expected,
      'the traced hit matches the closed form within 2%',
    );
    assert.ok(Math.abs(result.shadowed - result.mirror) <= 1, 'a sun behind the plate leaves the underside unlit');
    assert.ok(result.lit > result.mirror + 15, 'with the plate moved away the sun lights the underside');
    assert.equal(result.unshadowedVsLit, 0, 'shadows: false ignores the plate');
    assert.ok(result.roughRedder > 300, 'traced rough rays bring the box into the rough floor');
    assert.equal(result.roughPlainRedder, 0, 'a disposed scene runs as SSR: nothing off screen reflects');
    assert.ok(result.plainBrightest < 20, 'plain SSR has no hit on those pixels');
  },
);
