// Real-GPU check of @margoengine/post/rt-gi, built packages; with MARGO_COMPAT=1 (or --compat) the same page runs on
// the WebGL2 compatibility layer. A white matte floor under a wide emissive ceiling that is never on screen (the camera
// looks down, so every view ray is below the horizon), with the sun and core's ambient off. SSGI alone has nothing on
// screen for its rays to meet, so the floor is black. Through the scene tree every upward ray meets the ceiling: a
// Lambert floor under a uniform hemisphere of radiance E reflects albedo x E, faded only where a grazing ray passes
// maxDistance, so the floor is display(E x mean fade) within 2%.
// - multiBounce: the ceiling is black, so no second bounce adds light; the floor stays within 1/255 of one bounce.
// - The ceiling moved out of reach (setMatrix + update): the floor goes black again.
// - A disposed scene runs as SSGI: black.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { pbrNeutral } from '../../shared/display.js';
import { postBrowser } from './post-browser.mjs';

const E = 0.5,
  height = 3,
  maxDistance = 100;
// Mean of SSGI's fade 1 - smoothstep(0.8 D, D, distance) over a cosine-weighted hemisphere, the ceiling at `height`:
// distance h / cos, cos = sqrt(u) for a uniform u (Malley).
let fade = 0;
const N = 200000;
for (let i = 0; i < N; i++) {
  const cos = Math.sqrt((i + 0.5) / N),
    d = height / cos,
    t = Math.min(1, Math.max(0, (d - 0.8 * maxDistance) / (0.2 * maxDistance)));
  fade += 1 - t * t * (3 - 2 * t);
}
fade /= N;
const display = (c) =>
  pbrNeutral(c.map((x) => Math.max(0, x))).map(
    (x) => 255 * (x >= 0.0031308 ? 1.055 * Math.pow(x, 1 / 2.4) - 0.055 : x * 12.92),
  );
const expected = display([E * fade, E * fade, E * fade])[0];

await postBrowser(
  'post-rt-gi',
  5406,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(
      async ({ E, height, maxDistance }) => {
        const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
          { MeshBVH } = await import('/packages/bvh/dist/index.js'),
          { GPUSceneBVH } = await import('/packages/bvh/dist/gpu-scene.js'),
          { PostStack } = await import('/packages/post/dist/stack.js'),
          { RTGI } = await import('/packages/post/dist/rt-gi.js');
        const canvas = document.querySelector('canvas'),
          engine = await Engine.create(canvas, {
            backend: 'webgpu',
            camera: { position: [0, 2, 3], target: [0, 0, 0] },
          });
        engine.stop();
        engine.lighting.direction.set([3, 5, 4, 0]);
        engine.lighting.radiance.set([1, 1, 1, 0]);
        engine
          .createMesh()
          .setGeometry(box(40, 0.2, 40))
          .setPosition([0, -0.1, 0])
          .setMaterial(new PbrMaterial({ color: '#ffffff', roughness: 1, metalness: 0 }));
        const at = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
        const scene = GPUSceneBVH.forShader(engine.gpu, [
          {
            bvh: MeshBVH.fromGeometry(box(1000, 0.1, 1000)),
            matrix: at(0, height + 0.05, 0),
            material: { color: [0, 0, 0], emissive: [E, E, E] },
          },
        ]);
        const gi = new RTGI({ scene, maxDistance });
        PostStack.attach(engine, [gi]);
        window.t = {
          engine,
          gi,
          scene,
          at,
          frames: async (n) => {
            for (let i = 0; i < n; i++) engine.render({ delta: 1 / 60 });
            await engine.gpu.queue.onSubmittedWorkDone();
          },
        };
      },
      { E, height, maxDistance },
    );
    const frames = async (n, code = '') => {
      await page.evaluate(`${code}; window.t.frames(${n})`);
      return shot();
    };
    const one = await frames(2),
      multi = await frames(8, 'window.t.gi.options.multiBounce = true'),
      away = await frames(
        2,
        'window.t.gi.options.multiBounce = false; window.t.scene.setMatrix(0, window.t.at(0, 500, 0)); window.t.scene.update()',
      ),
      back = await frames(2, 'window.t.scene.setMatrix(0, window.t.at(0, 3.05, 0)); window.t.scene.update()'),
      plain = await frames(2, 'window.t.scene.dispose()');
    const layer = await page.evaluate(() => {
      window.t.engine.dispose();
      return !!globalThis.__margoCompat;
    });
    // The floor: the lower half of the view, away from the edges.
    const floor = [];
    for (let y = 150; y < 230; y++) for (let x = 40; x < 280; x++) floor.push((y * 320 + x) * 4);
    const median = (image) => {
      const values = floor.map((i) => image.data[i + 1]).sort((a, b) => a - b);
      return values[values.length >> 1];
    };
    const result = {
      device: layer ? 'webgl2-layer' : 'webgpu',
      expected: +expected.toFixed(2),
      fade: +fade.toFixed(5),
      one: median(one),
      multi: median(multi),
      away: median(away),
      back: median(back),
      plain: median(plain),
    };
    console.log(JSON.stringify(result));
    assert.ok(Math.abs(result.one - expected) <= 0.02 * expected, 'one traced bounce matches albedo x E within 2%');
    assert.ok(Math.abs(result.multi - result.one) <= 1, 'a black ceiling adds no second bounce');
    assert.ok(result.away <= 2, 'with the ceiling out of reach the floor is dark');
    assert.equal(result.back, result.one, 'moving the ceiling back gives the first frame back');
    assert.ok(result.plain <= 2, 'a disposed scene runs as SSGI: nothing on screen to bounce');
  },
);
