// Real-GPU check that water draws into every capture effect (KB-WATER-TARGETS1), built packages, on WebGPU and
// (--compat or MARGO_COMPAT=1) the WebGL2 layer. Water declares a `Surface` of its own, so SceneTargets took it for a
// gltf surface, and its capture wrote SSR's three fields for every effect: `targets.add(water)` on four outputs and
// `meshBlend.tag(water)` built shaders that did not compile. Here one water is in SceneTargets (four outputs, not
// ground) with MeshBlend, then with SSR, over a core floor 1 m below it: no GPU error, the water marks its own
// pixels in the targets at its own height, and the floor keeps its pixels around it.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { compatRun } from '../../../scripts/support/compat-shim.js';
import { postBrowser } from './post-browser.mjs';

await postBrowser(
  'post-scene-targets-water',
  5384,
  () => launchBrowser({ headless: true }),
  async (page) => {
    const result = await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { SceneTargets } = await import('/packages/post/dist/mrt.js'),
        { SSR } = await import('/packages/post/dist/ssr.js'),
        { MeshBlend } = await import('/packages/post/dist/mesh-blend.js'),
        { Water } = await import('/packages/water/dist/index.js');
      const canvas = document.querySelector('canvas'),
        engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 7, 9], target: [0, 0, 0] } }),
        device = engine.gpu,
        errors = [];
      engine.stop();
      device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
      engine.lighting.direction.set([0.25, 1, 0.35]);
      engine
        .createMesh()
        .setGeometry(box(30, 0.2, 30))
        .setPosition([0, -1.1, 0])
        .setMaterial(new PbrMaterial({ color: '#b0b0a8', roughness: 1 }));
      const water = Water.attach(engine, {
        size: [6, 6],
        segments: 16,
        height: 0,
        waves: [{ direction: [1, 0], amplitude: 0, wavelength: 10 }],
      });
      const targets = SceneTargets.attach(engine, {
        outputs: {
          lit: 'litGround',
          normal: 'normal',
          water: { wgsl: 'vec4f(1.0-t.ground,0,0,1)', format: 'r8unorm' },
          height: { wgsl: 'vec4f(t.position.y,0,0,1)', format: 'r16float' },
        },
      });
      targets.add(water, { ground: false });
      // MeshBlend and SceneTargets, then SSR and SceneTargets (one post stack each): the water in two effects a frame.
      const blend = MeshBlend.attach(engine);
      blend.tag(water, 0.2);
      await (await import('/scripts/support/gpu-ready.js')).waitForPipelines(async () => {
        engine.render({ delta: 0 });
        await device.queue.onSubmittedWorkDone();
      });
      blend.dispose();
      const ssr = SSR.attach(engine);
      ssr.add(water);
      await (await import('/scripts/support/gpu-ready.js')).waitForPipelines(async () => {
        engine.render({ delta: 0 });
        await device.queue.onSubmittedWorkDone();
      });
      const read = async (name) => {
        const texture = targets.texture(name),
          { width, height, format } = texture,
          size = format === 'r16float' ? 2 : 1,
          row = Math.ceil((width * size) / 256) * 256,
          buffer = device.createBuffer({ size: row * height, usage: 1 | 8 }),
          encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: row }, [width, height]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(1);
        const bytes = new Uint8Array(buffer.getMappedRange().slice(0)),
          out = [],
          half = (h) => {
            const e = (h >> 10) & 31,
              m = h & 1023;
            return e === 0 ? m * 2 ** -24 : (1 + m / 1024) * 2 ** (e - 15) * (h >> 15 ? -1 : 1);
          };
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++)
            out.push(
              size === 2 ? half(bytes[y * row + x * 2] | (bytes[y * row + x * 2 + 1] << 8)) : bytes[y * row + x] / 255,
            );
        buffer.unmap();
        buffer.destroy();
        return out;
      };
      const marks = await read('water'),
        heights = await read('height'),
        lit = await read('lit');
      const on = [];
      for (let i = 0; i < marks.length; i++) if (marks[i] > 0.5) on.push(i);
      const result = {
        errors: errors.slice(),
        water: on.length,
        meanHeight: on.reduce((s, i) => s + heights[i], 0) / Math.max(1, on.length),
        litOnWater: on.filter((i) => lit[i] > 0.5).length,
        litFloor: lit.filter((v) => v > 0.5).length,
        pixels: marks.length,
      };
      ssr.dispose();
      targets.dispose();
      water.dispose();
      engine.dispose();
      return result;
    });
    console.log(JSON.stringify({ ...result, compat: compatRun() }));
    assert.deepEqual(result.errors, [], 'water compiles and draws in SceneTargets, MeshBlend and SSR in one frame');
    assert.ok(result.water > 0.1 * result.pixels, `the water marks its pixels (${result.water} of ${result.pixels})`);
    assert.ok(Math.abs(result.meanHeight) < 0.05, `at its own height, not the floor's (${result.meanHeight} m)`);
    assert.equal(result.litOnWater, 0, 'added as not ground, water is no lit ground');
    assert.ok(result.litFloor > 0.1 * result.pixels, `the floor around it stays lit ground (${result.litFloor} px)`);
  },
);
