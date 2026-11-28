// Real-GPU check that GTAO's bilateral blur smooths a far ground seen at a grazing angle (KB-POST-GTAOFAR1), built
// packages, on WebGPU and (MARGO_COMPAT=1) the WebGL2 layer. Low ridges run straight away from a camera 20 m up that
// looks 400 m out with a narrow lens, so every pixel row is metres deeper than the one above it while the ground and
// its occlusion do not change along the ridges: any change from row to row in the visibility GTAO hands the composite
// (`occlusionView`) is the 4 x 4 sample pattern the blur left in. Before the fix the blur weighed a tap by its depth
// against the centre's and rejected every vertical tap there, so the pattern stayed as one-pixel rows and a checker.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';

await postBrowser(
  'post-gtao-far',
  5374,
  () => launchBrowser({ headless: true }),
  async (page) => {
    const result = await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { GTAO } = await import('/packages/post/dist/gtao.js');
      const canvas = document.querySelector('canvas'),
        errors = [],
        engine = await Engine.create(canvas, {
          backend: 'webgpu',
          camera: { position: [0, 20, 0], target: [0, 0, -400], fov: 12, far: 5000 },
        });
      engine.stop();
      engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
      const grey = new PbrMaterial({ color: '#c0c0c0', roughness: 1 });
      engine
        .createMesh()
        .setGeometry(box(400, 0.2, 2000))
        .setPosition([0, -0.1, -600])
        .setMaterial(grey);
      // Ridges 1 m wide and 0.5 m high every 4 m, along the view.
      for (let x = -60; x <= 60; x += 4)
        engine
          .createMesh()
          .setGeometry(box(1, 0.5, 1600))
          .setPosition([x, 0.25, -800])
          .setMaterial(grey);
      const gtao = GTAO.attach(engine, { radius: 1.5, slices: 2, steps: 6 });
      for (let i = 0; i < 3; i++) engine.render({ delta: 1 / 60 });
      await engine.gpu.queue.onSubmittedWorkDone();
      const gpu = engine.gpu,
        width = canvas.width,
        height = canvas.height,
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
        bytes = width * height * 4,
        storage = gpu.createBuffer({ size: bytes, usage: 128 | 4 }),
        readback = gpu.createBuffer({ size: bytes, usage: 1 | 8 }),
        encoder = gpu.createCommandEncoder(),
        pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        gpu.createBindGroup({
          layout,
          entries: [
            { binding: 0, resource: gtao.occlusionView },
            { binding: 1, resource: { buffer: storage } },
          ],
        }),
      );
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      pass.end();
      encoder.copyBufferToBuffer(storage, 0, readback, 0, bytes);
      gpu.queue.submit([encoder.finish()]);
      await readback.mapAsync(1);
      const ao = Array.from(new Float32Array(readback.getMappedRange().slice(0)));
      readback.unmap();
      engine.dispose();
      if (errors.length) throw new Error(errors.join('\n'));
      return { width, height, ao };
    });
    const { width, height, ao } = result,
      at = (x, y) => ao[y * width + x];
    // The ground from just under the middle of the frame (about 400 m out) to a quarter of the frame lower.
    const x0 = Math.round(width * 0.1),
      x1 = Math.round(width * 0.9),
      y0 = Math.round(height * 0.55),
      y1 = Math.round(height * 0.75);
    let rows = 0,
      columns = 0,
      dark = 0,
      n = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++, n++) {
        rows += Math.abs(at(x, y - 1) - 2 * at(x, y) + at(x, y + 1));
        columns += Math.abs(at(x - 1, y) - 2 * at(x, y) + at(x + 1, y));
        dark += 1 - at(x, y);
      }
    const measured = { rows: rows / n, columns: columns / n, occlusion: dark / n };
    console.log(JSON.stringify(measured));
    assert.ok(measured.occlusion > 0.01, `the ridges occlude the ground around them (${measured.occlusion})`);
    // Measured on an RTX A6000: 0.0311 (WebGPU) and 0.0276 (WebGL2 layer) with the fix, 0.0709 and 0.0619 before it,
    // the same to every digit run to run.
    assert.ok(measured.rows <= 0.045, `rows change smoothly along the ridges (${measured.rows})`);
  },
);
