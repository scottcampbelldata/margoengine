// Real-GPU check that SSAO puts no occlusion on the silhouette of a lone flat face (KB-SSAO-SILHOUETTE1), built
// packages, on WebGPU and (MARGO_COMPAT=1) the WebGL2 layer:
//   node scripts/run-with-timeout.mjs -- node packages/post/test/ssao-silhouette-browser.mjs
// A box turned about the view axis in 12 steps faces the camera with nothing near it, so every pixel's occlusion
// (`occlusionView`) is 1. Before the fix the normal of a silhouette pixel was built from a background neighbour
// (depth 0, at infinity), so a one-pixel tip of the silhouette took a sideways normal and its own face occluded it:
// 4 pixels down to 0.78 at 2 of the 12 turns on WebGPU, 1 to 3 pixels down to 0.72 at 10 of them on the WebGL2 layer.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';

await postBrowser(
  'post-ssao-silhouette',
  5394,
  () => launchBrowser({ headless: true }),
  async (page) => {
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
  },
  { seconds: 180 },
);
