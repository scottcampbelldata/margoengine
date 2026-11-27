// Real-GPU check that ambient occlusion never takes more light out of a pixel than the pixel holds where grass is
// blended over the ground (KB-SCENES-GRASSBLACK1), built packages, on WebGPU and with --compat the WebGL2 layer:
//   node scripts/run-with-timeout.mjs --max=10 -- node packages/scatter/test/grass-ao.browser.mjs
// A field of thin covered blades over a pale floor, lit by the ambient light alone, drawn with GTAO off and on. The
// composite takes ambient * (1 - visibility) out of the scene, and the ambient light of a pixel is at most its colour,
// so in linear light no pixel may fall under its colour without GTAO times its visibility (`occlusionView`). Before the
// fix the replay held the whole floor's light under blades that covered part of a pixel, and thousands of pixels fell
// under that bound, many to black. The grass must still occlude the floor.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from '../../post/test/post-browser.mjs';

if (process.argv.includes('--compat')) process.env.MARGO_COMPAT = '1';
await postBrowser(
  'scatter-grass-ao',
  5389,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { GTAO } = await import('/packages/post/dist/index.js'),
        { GrassScatter } = await import('/packages/scatter/dist/grass.js'),
        { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
      const canvas = document.querySelector('canvas'),
        engine = await Engine.create(canvas, {
          backend: 'webgpu',
          camera: { position: [0, 1.6, 3.4], target: [0, 0.2, 0], fov: 45, near: 0.1, far: 50 },
        });
      engine.stop();
      const errors = [];
      engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
      engine.scene.background = '#b0b0b0';
      engine.lighting.radiance.set([0, 0, 0]);
      engine.lighting.ambient.set([1, 1, 1]);
      engine.lighting.radiance[3] = 1;
      engine
        .createMesh()
        .setGeometry(box(30, 0.2, 30))
        .setMaterial(new PbrMaterial({ color: [0.5, 0.45, 0.35], roughness: 1 }))
        .position.set(0, -0.1, 0);
      GrassScatter.attach(engine, {
        count: 400,
        area: [8, 8],
        lod: [30, 60, 90],
        lodFade: 0,
        seed: 3,
        grass: { height: 0.6, width: 0.016, blades: 20, radius: 0.2, lean: 0.6 },
        material: new PbrMaterial({ color: [0.3, 0.28, 0.14], roughness: 0.9, doubleSided: true }),
      });
      const effect = GTAO.attach(engine, { radius: 1, slices: 3, steps: 8 });
      await waitForPipelines(async () => {
        engine.render({ delta: 0 });
        await engine.gpu.queue.onSubmittedWorkDone();
      });
      const gpu = engine.gpu,
        bytes = canvas.width * canvas.height * 4,
        pipeline = gpu.createComputePipeline({
          layout: 'auto',
          compute: {
            module: gpu.createShaderModule({
              code: `@group(0) @binding(0) var ao:texture_2d<f32>;@group(0) @binding(1) var<storage,read_write> out:array<f32>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){let s=textureDimensions(ao);if(any(id.xy>=s)){return;}out[id.y*s.x+id.x]=textureLoad(ao,vec2i(id.xy),0).r;}`,
            }),
            entryPoint: 'main',
          },
        });
      window.check = {
        async frame(enabled) {
          effect.enabled = enabled;
          for (let i = 0; i < 3; i++) engine.render({ delta: 0 });
          await gpu.queue.onSubmittedWorkDone();
          return errors.splice(0);
        },
        async visibility() {
          const storage = gpu.createBuffer({ size: bytes, usage: 128 | 4 }),
            readback = gpu.createBuffer({ size: bytes, usage: 1 | 8 });
          engine.render({ delta: 0 });
          const encoder = gpu.createCommandEncoder(),
            pass = encoder.beginComputePass();
          pass.setPipeline(pipeline);
          pass.setBindGroup(
            0,
            gpu.createBindGroup({
              layout: pipeline.getBindGroupLayout(0),
              entries: [
                { binding: 0, resource: effect.occlusionView },
                { binding: 1, resource: { buffer: storage } },
              ],
            }),
          );
          pass.dispatchWorkgroups(Math.ceil(canvas.width / 8), Math.ceil(canvas.height / 8));
          pass.end();
          encoder.copyBufferToBuffer(storage, 0, readback, 0, bytes);
          gpu.queue.submit([encoder.finish()]);
          await readback.mapAsync(1);
          const values = Array.from(new Float32Array(readback.getMappedRange()));
          storage.destroy();
          readback.destroy();
          return values;
        },
      };
    });
    assert.deepEqual(await page.evaluate(() => window.check.frame(false)), []);
    const open = await shot();
    assert.deepEqual(await page.evaluate(() => window.check.frame(true)), []);
    const shut = await shot(),
      visibility = await page.evaluate(() => window.check.visibility());
    assert.equal(visibility.length, shut.width * shut.height, 'one visibility per screenshot pixel');
    // sRGB decode; Khronos PBR Neutral takes the same small toe from both frames, inside the tolerance.
    const linear = (v) => (v <= 10.31 ? v / 3294.6 : ((v / 255 + 0.055) / 1.055) ** 2.4);
    let under = 0,
      darker = 0,
      worst = 0;
    for (let p = 0; p < visibility.length; p++) {
      let deficit = 0;
      for (let c = 0; c < 3; c++)
        deficit = Math.max(deficit, linear(open.data[p * 4 + c]) * visibility[p] - linear(shut.data[p * 4 + c]));
      worst = Math.max(worst, deficit);
      if (deficit > 0.04) under++;
      if (open.data[p * 4] - shut.data[p * 4] > 8) darker++;
    }
    console.log(
      `pixels under their colour times visibility: ${under} (worst ${worst.toFixed(3)}); occluded pixels ${darker}`,
    );
    assert.ok(under <= visibility.length * 0.0002, `${under} pixels lost more light than their visibility allows`);
    assert.ok(darker > visibility.length * 0.03, `the grass and floor are occluded: ${darker} pixels`);
    console.log('ok GTAO over covered grass takes no more light than a pixel holds');
  },
  { seconds: 180 },
);
