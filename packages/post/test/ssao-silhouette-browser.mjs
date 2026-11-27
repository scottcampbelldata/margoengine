// Real-GPU check that SSAO puts no occlusion on the silhouette of a lone flat face (KB-SSAO-SILHOUETTE1), built
// packages, on WebGPU and (MARGO_COMPAT=1) the WebGL2 layer:
//   node scripts/run-with-timeout.mjs -- node packages/post/test/ssao-silhouette-browser.mjs
// A box turned about the view axis in 12 steps faces the camera with nothing near it, so every pixel's occlusion
// (`occlusionView`) is 1. Before the fix the normal of a silhouette pixel was built from a background neighbour
// (depth 0, at infinity), so a one-pixel tip of the silhouette took a sideways normal and its own face occluded it:
// 4 pixels down to 0.78 at 2 of the 12 turns on WebGPU, 1 to 3 pixels down to 0.72 at 10 of them on the WebGL2 layer.
// The second part (KB-SSAO-LONEPIXEL1) looks at a wall through slits one pixel wide between slats that stand 1.5 units in
// front of it, past the occlusion radius: both horizontal neighbours of a slit pixel are slats, and a normal taken from
// either faced sideways, which the pass read as shut in.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';

await postBrowser(
  'post-ssao-silhouette',
  5394,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    const turns = await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { SSAO, GTAO } = await import('/packages/post/dist/index.js');
      const results = [];
      for (const [name, Effect] of [
        ['SSAO', SSAO],
        ['GTAO', GTAO],
      ]) {
        const engine = await Engine.create(document.querySelector('canvas'), {
          backend: 'webgpu',
          camera: { position: [0, 0, 3.2], target: [0, 0, 0] },
        });
        engine.stop();
        const errors = [];
        engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
        const mesh = engine
            .createMesh()
            .setGeometry(box(1.2, 1.2, 1.2))
            .setMaterial(new PbrMaterial({ color: '#e0a050', roughness: 1 })),
          effect = Effect.attach(engine);
        const gpu = engine.gpu,
          { width, height } = document.querySelector('canvas'),
          bytes = width * height * 4,
          layout = gpu.createBindGroupLayout({
            entries: [
              { binding: 0, visibility: 4, texture: { sampleType: 'unfilterable-float' } },
              { binding: 1, visibility: 4, buffer: { type: 'storage' } },
            ],
          }),
          pipeline = gpu.createComputePipeline({
            layout: gpu.createPipelineLayout({ bindGroupLayouts: [layout] }),
            compute: {
              module: gpu.createShaderModule({
                code: `@group(0) @binding(0) var ao:texture_2d<f32>;@group(0) @binding(1) var<storage,read_write> out:array<f32>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){let s=textureDimensions(ao);if(any(id.xy>=s)){return;}out[id.y*s.x+id.x]=textureLoad(ao,vec2i(id.xy),0).r;}`,
              }),
              entryPoint: 'main',
            },
          }),
          storage = gpu.createBuffer({ size: bytes, usage: 128 | 4 }),
          readback = gpu.createBuffer({ size: bytes, usage: 1 | 8 });
        for (let k = 0; k < 12; k++) {
          const t = (k * Math.PI) / 23;
          mesh.setQuaternion([0, 0, Math.sin(t), Math.cos(t)]);
          engine.render({ delta: 1 / 60 });
          const encoder = gpu.createCommandEncoder(),
            pass = encoder.beginComputePass();
          pass.setPipeline(pipeline);
          pass.setBindGroup(
            0,
            gpu.createBindGroup({
              layout,
              entries: [
                { binding: 0, resource: effect.occlusionView },
                { binding: 1, resource: { buffer: storage } },
              ],
            }),
          );
          pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
          pass.end();
          encoder.copyBufferToBuffer(storage, 0, readback, 0, bytes);
          gpu.queue.submit([encoder.finish()]);
          await readback.mapAsync(1);
          const values = new Float32Array(readback.getMappedRange().slice(0));
          readback.unmap();
          let occluded = 0,
            least = 1;
          for (const v of values)
            if (v < 0.99) {
              occluded++;
              least = Math.min(least, v);
            }
          results.push({ effect: name, turn: k, occluded, least, errors: errors.length });
        }
        storage.destroy();
        readback.destroy();
        effect.dispose();
        engine.dispose();
      }
      return results;
    });
    for (const { effect, turn, occluded, least, errors } of turns) {
      assert.equal(errors, 0, `${effect} turn ${turn}: GPU errors`);
      assert.equal(occluded, 0, `${effect} turn ${turn}: ${occluded} pixels occluded, least ${least.toFixed(3)}`);
    }
    console.log(`ok SSAO and GTAO: no occlusion on a lone face's silhouette at ${turns.length / 2} turns`);
    const shut = [];
    for (const name of ['SSAO', 'GTAO']) {
      const columns = await page.evaluate(async (name) => {
        const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
          post = await import('/packages/post/dist/index.js');
        const canvas = document.querySelector('canvas'),
          engine = await Engine.create(canvas, {
            backend: 'webgpu',
            antialias: false,
            camera: { position: [0, 0, 5], target: [0, 0, 0], fov: 45 },
          });
        engine.stop();
        const errors = [];
        engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
        const part = (size, color, x, z) =>
          engine
            .createMesh()
            .setGeometry(box(...size))
            .setMaterial(new PbrMaterial({ color, roughness: 1 }))
            .position.set(x, 0, z);
        part([6, 4, 0.2], '#d02020', 0, -0.1);
        // Slats three pixels wide and one pixel apart, 1.5 units in front of the wall (3.5 from the eye).
        const pixel = (2 * 3.5 * Math.tan(Math.PI / 8)) / canvas.height;
        for (let k = -30; k <= 30; k++) part([3 * pixel, 1.6, 0.01], '#20d020', (4 * k + 0.5) * pixel, 1.5);
        const effect = post[name].attach(engine, { radius: 0.5 });
        engine.render({ delta: 1 / 60 });
        window.slits = { engine, effect, errors };
        return errors.length;
      }, name);
      assert.equal(columns, 0);
      await page.evaluate(() => window.slits.engine.render({ delta: 1 / 60 }));
      const picture = await shot(),
        { values, errors } = await page.evaluate(async () => {
          const { engine, effect, errors } = window.slits,
            gpu = engine.gpu,
            canvas = document.querySelector('canvas'),
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
            }),
            storage = gpu.createBuffer({ size: bytes, usage: 128 | 4 }),
            readback = gpu.createBuffer({ size: bytes, usage: 1 | 8 });
          engine.render({ delta: 1 / 60 });
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
          effect.dispose();
          engine.dispose();
          return { values, errors: errors.length };
        });
      assert.equal(errors, 0, `${name} slits: GPU errors`);
      const red = (p) => picture.data[p * 4] > picture.data[p * 4 + 1] + 30,
        green = (p) => picture.data[p * 4 + 1] > picture.data[p * 4] + 30;
      let slits = 0,
        least = 1,
        mean = 0;
      for (let y = 0; y < picture.height; y++)
        for (let x = 1; x < picture.width - 1; x++) {
          const p = y * picture.width + x;
          if (!(red(p) && green(p - 1) && green(p + 1))) continue;
          slits++;
          mean += values[p];
          least = Math.min(least, values[p]);
        }
      mean /= slits;
      console.log(`${name} slits: ${slits} pixels, visibility mean ${mean.toFixed(3)}, least ${least.toFixed(3)}`);
      assert.ok(slits > 1000, `${name}: the slits show the wall (${slits} pixels)`);
      // SSAO's kernel still finds the slats within its range check; GTAO's falloff has faded them out.
      if (!(least > (name === 'SSAO' ? 0.75 : 0.95))) shut.push(`${name} ${least.toFixed(3)}`);
    }
    assert.deepEqual(shut, [], 'a slit pixel reads as shut in');
    console.log('ok SSAO and GTAO: a wall seen through one-pixel slits stays open');
  },
  { seconds: 180 },
);
