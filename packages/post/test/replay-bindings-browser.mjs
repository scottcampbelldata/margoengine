// Real-GPU check that every post pass which replays the scene's lit shader binds every pass binding the shader reads
// (KB-POST-GTAO-TERRAINLOOK1), built packages, on WebGPU and (MARGO_COMPAT=1) the WebGL2 layer. A material plugin may
// read its own binding anywhere in the lit shader; TerrainColors reads its look uniform above `let direct=`, where the
// material colour is made. SSAO's ambient replay (shared by GTAO) kept that code but bound only bindings 18, 8 and 144,
// so its bind group missed the binding its auto layout held: "Number of entries (1) did not match the expected number
// of entries (2)" and an invalid command buffer every frame.
// - a test plugin in the shape of TerrainColors (a uniform read above `let direct=`, a second one read below it) with
//   each replaying pass alone: SSAO, GTAO, SSGI, SSR and SceneTargets, and all of them in one PostStack;
// - TerrainColors itself on a heightfield with GTAO.
// Each draws frames with no GPU error and draws the lit meshes (the frame is not left black or the clear colour).
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';

await postBrowser(
  'post-replay-bindings',
  5372,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { PostStack } = await import('/packages/post/dist/stack.js'),
        { SSAO } = await import('/packages/post/dist/ssao.js'),
        { GTAO } = await import('/packages/post/dist/gtao.js'),
        { SSGI } = await import('/packages/post/dist/ssgi.js'),
        { SSR } = await import('/packages/post/dist/ssr.js'),
        { SceneTargets } = await import('/packages/post/dist/mrt.js'),
        { TerrainColors, heightfield } = await import('/packages/terrain/dist/index.js');
      const canvas = document.querySelector('canvas');
      // A material plugin as TerrainColors is one: it patches the lit shader and pushes its bindings each frame. The
      // tint (binding 41) is read where the material colour is made, above `let direct=`; the gain (binding 42) in the
      // light sum below it.
      const tintPlugin = () => {
        let tint, gain;
        return {
          name: 'test:material-binding',
          setup(engine) {
            tint = engine.gpu.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
            gain = engine.gpu.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
            engine.gpu.queue.writeBuffer(tint, 0, new Float32Array([0.9, 0.8, 0.7, 1]));
            engine.gpu.queue.writeBuffer(gain, 0, new Float32Array([1, 1, 1, 1]));
          },
          registerPasses(graph) {
            graph.add({
              name: 'test:material-binding',
              order: -1,
              execute(c) {
                if (c.backend !== 'webgpu') return;
                const patched = c.shader
                  .replace(
                    '@group(0) @binding(0) var<uniform> frame:Frame;',
                    (line) =>
                      `${line}\n@group(0) @binding(41) var<uniform> testTint:vec4f;\n@group(0) @binding(42) var<uniform> testGain:vec4f;`,
                  )
                  .replace('let direct=', 'if(testTint.a<0.0){discard;}let direct=')
                  .replace('let linear=direct*', 'let linear=testGain.rgb*direct*');
                if (patched === c.shader || !patched.includes('testGain.rgb*direct')) throw new Error('test plugin did not patch');
                c.shader = patched;
                c.bindings.push({ binding: 41, resource: { buffer: tint } }, { binding: 42, resource: { buffer: gain } });
              },
            });
          },
        };
      };
      // A lit floor and box under the given passes; the frames' GPU errors and the share of lit pixels.
      window.measure = async (attach, { terrain = false } = {}) => {
        const engine = await Engine.create(canvas, {
            backend: 'webgpu',
            camera: { position: [0, 4, 7], target: [0, 0.5, 0] },
          }),
          errors = [];
        engine.stop();
        engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
        const grey = new PbrMaterial({ color: '#c0c0c0', roughness: 0.6 });
        if (terrain) {
          const ground = engine.createMesh();
          ground.setGeometry(
            heightfield((x, z) => 0.6 * Math.sin(x / 2) * Math.cos(z / 3), {
              size: [40, 40],
              origin: [-20, -30],
              resolution: 2,
            }),
          );
          TerrainColors.attach(engine, ground);
        } else {
          engine.use(tintPlugin());
          engine.createMesh().setGeometry(box(20, 0.2, 20)).setPosition([0, -0.1, 0]).setMaterial(grey);
        }
        engine.createMesh().setGeometry(box(1.5, 1.5, 1.5)).setPosition([0, 0.75, 0]).setMaterial(grey);
        attach(engine);
        for (let i = 0; i < 6; i++) engine.render({ delta: 1 / 60 });
        await engine.gpu.queue.onSubmittedWorkDone();
        window.dispose = () => engine.dispose();
        return errors;
      };
      window.cases = {
        ssao: (engine) => SSAO.attach(engine),
        gtao: (engine) => GTAO.attach(engine),
        ssgi: (engine) => SSGI.attach(engine, { rays: 2 }),
        ssr: (engine) => SSR.attach(engine),
        sceneTargets: (engine) => SceneTargets.attach(engine, { outputs: { albedo: 'albedo', normal: 'normal' } }),
        stack: (engine) => PostStack.attach(engine, [new GTAO(), new SSGI({ rays: 2 }), new SSR()]),
      };
    });
    // The errors of a case and the share of its frame's pixels that are lit (summed RGB above 30 codes).
    const run = async (name, terrain) => {
      const errors = await page.evaluate(([n, t]) => window.measure(window.cases[n], { terrain: t }), [name, terrain]),
        { data } = await shot();
      await page.evaluate(() => window.dispose());
      let lit = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 30) lit++;
      return { errors, lit: lit / (data.length / 4) };
    };
    const rows = {};
    for (const name of ['ssao', 'gtao', 'ssgi', 'ssr', 'sceneTargets', 'stack']) rows[name] = await run(name, false);
    rows.terrainGtao = await run('gtao', true);
    console.log(JSON.stringify(Object.fromEntries(Object.entries(rows).map(([k, r]) => [k, { errors: r.errors.length, lit: +r.lit.toFixed(3) }]))));
    for (const [name, r] of Object.entries(rows)) {
      assert.deepEqual(r.errors, [], `${name}: no GPU error with a material plugin's bindings`);
      assert.ok(r.lit > 0.2, `${name}: the lit scene is drawn (${(100 * r.lit).toFixed(1)} % of pixels lit)`);
    }
  },
);
