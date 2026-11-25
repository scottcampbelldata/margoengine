// Real-GPU check of GTAO's sky occlusion (KB-LOOK-POST-SKYOCC1), built packages, on WebGPU and (MARGO_COMPAT=1) the
// WebGL2 layer. The visibility GTAO hands the composite (`occlusionView`) is read back at the middle of the frame:
// - an open floor and an open tilted slope read 1 with the sky search on (only the sky arc counts, so a tilt that also
//   sees the ground below the horizon is not darkened);
// - the floor of a long slot 2 m wide and 2 m deep, seen from above, reads its view factor to the opening,
//   sin(atan(w / 2h)) = 0.4472 (Hottel's crossed strings), as a share of the plain GTAO there;
// - with skyRadius 0 the visibility is the plain GTAO's, bit for bit, before and after a frame with the sky on;
// - the plain GTAO term reads 1 on the open floor (seen 53 degrees off its normal) and slope, and about 0.5 in the 90
//   degree crease where the floor meets a wall (KB-GTAO-OPENFLOOR1: samples rounded off the slice read 0.980 there).
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';

await postBrowser(
  'post-gtao-sky',
  5373,
  () => launchBrowser({ headless: true }),
  async (page) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { GTAO } = await import('/packages/post/dist/gtao.js');
      const canvas = document.querySelector('canvas'),
        device = { current: null },
        errors = [];
      const scenes = {
        // A floor 400 m across.
        floor: {
          camera: { position: [0, 6, 8], target: [0, 0, 0] },
          boxes: [
            [
              [400, 0.2, 400],
              [0, -0.1, 0],
            ],
          ],
        },
        // A slope tilted 30 degrees about x, seen square on.
        slope: {
          camera: { position: [0, 7, 9], target: [0, 0, 0] },
          boxes: [
            [
              [400, 0.2, 400],
              [0, -0.1, 0],
              [Math.PI / 6, 0, 0],
            ],
          ],
        },
        // The floor meeting a wall 40 m high whose face is the plane z = 0, the crease at the middle of the frame.
        crease: {
          camera: { position: [0, 6, 8], target: [0, 0, 0] },
          boxes: [
            [
              [400, 0.2, 400],
              [0, -0.1, 0],
            ],
            [
              [400, 40, 2],
              [0, 20, -1],
            ],
          ],
        },
        // A slot along z, 2 m wide between walls 2 m high, seen from straight above its middle.
        slot: {
          camera: { position: [0, 9, 0.01], target: [0, 0, 0] },
          boxes: [
            [
              [60, 0.2, 400],
              [0, -0.1, 0],
            ],
            [
              [20, 2, 400],
              [-11, 1, 0],
            ],
            [
              [20, 2, 400],
              [11, 1, 0],
            ],
          ],
        },
      };
      const read = async (gtao) => {
        const gpu = device.current,
          view = gtao.occlusionView,
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
                code: `@group(0) @binding(0) var ao:texture_2d<f32>;@group(0) @binding(1) var<storage,read_write> out:array<f32,81>;
@compute @workgroup_size(9,9) fn main(@builtin(local_invocation_id) id:vec3u){let c=vec2i(textureDimensions(ao)/2u);out[id.y*9u+id.x]=textureLoad(ao,c+vec2i(id.xy)-4,0).r;}`,
              }),
              entryPoint: 'main',
            },
          }),
          storage = gpu.createBuffer({ size: 324, usage: 128 | 4 }),
          readback = gpu.createBuffer({ size: 324, usage: 1 | 8 }),
          encoder = gpu.createCommandEncoder(),
          pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(
          0,
          gpu.createBindGroup({
            layout,
            entries: [
              { binding: 0, resource: view },
              { binding: 1, resource: { buffer: storage } },
            ],
          }),
        );
        pass.dispatchWorkgroups(1);
        pass.end();
        encoder.copyBufferToBuffer(storage, 0, readback, 0, 324);
        gpu.queue.submit([encoder.finish()]);
        await readback.mapAsync(1);
        const values = Array.from(new Float32Array(readback.getMappedRange().slice(0)));
        readback.unmap();
        return values;
      };
      // Visibility (81 values around the middle) of a scene with sky occlusion at `skyRadius`, after a few frames.
      window.measure = async (name, skyRadius) => {
        const scene = scenes[name],
          engine = await Engine.create(canvas, { backend: 'webgpu', camera: scene.camera });
        engine.stop();
        device.current = engine.gpu;
        engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
        const grey = new PbrMaterial({ color: '#c0c0c0', roughness: 1 });
        for (const [size, position, rotation] of scene.boxes) {
          const mesh = engine
            .createMesh()
            .setGeometry(box(...size))
            .setPosition(position)
            .setMaterial(grey);
          if (rotation) mesh.setRotation(rotation);
        }
        const gtao = GTAO.attach(engine, { slices: 4, steps: 16, skySteps: 32 }),
          frames = async (n) => {
            for (let i = 0; i < n; i++) engine.render({ delta: 1 / 60 });
            await engine.gpu.queue.onSubmittedWorkDone();
          };
        const result = {};
        await frames(2);
        result.off = await read(gtao);
        gtao.options.skyRadius = skyRadius;
        await frames(2);
        result.on = await read(gtao);
        gtao.options.skyRadius = 0;
        await frames(2);
        result.back = await read(gtao);
        engine.dispose();
        if (errors.length) throw new Error(errors.join('\n'));
        return result;
      };
    });
    const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
    const centre = (values) => mean([30, 31, 32, 39, 40, 41, 48, 49, 50].map((i) => values[i]));
    const floor = await page.evaluate(() => window.measure('floor', 8)),
      slope = await page.evaluate(() => window.measure('slope', 8)),
      slot = await page.evaluate(() => window.measure('slot', 12)),
      crease = await page.evaluate(() => window.measure('crease', 0));
    // The sky term alone: the visibility with the sky search over the plain GTAO's at the same pixel.
    const share = (r) => r.on.map((on, i) => on / r.off[i]);
    const analytic = Math.sin(Math.atan(1 / 2)),
      result = {
        floor: {
          off: mean(floor.off),
          on: mean(floor.on),
          min: Math.min(...share(floor)),
          max: Math.max(...share(floor)),
        },
        slope: {
          off: mean(slope.off),
          on: mean(slope.on),
          min: Math.min(...share(slope)),
          max: Math.max(...share(slope)),
        },
        slot: { off: centre(slot.off), on: centre(slot.on), share: centre(slot.on) / centre(slot.off), analytic },
        plain: {
          floor: [Math.min(...floor.off), Math.max(...floor.off)],
          slope: [Math.min(...slope.off), Math.max(...slope.off)],
          crease: [Math.min(...crease.off), Math.max(...crease.off)],
        },
      };
    console.log(JSON.stringify(result));
    for (const [name, r] of [
      ['floor', floor],
      ['slope', slope],
      ['slot', slot],
      ['crease', crease],
    ])
      assert.deepEqual(r.back, r.off, `${name}: skyRadius 0 gives the plain GTAO back bit for bit`);
    // The plain GTAO term (KB-GTAO-OPENFLOOR1). An open plane reads exactly 1 in the shader's maths (the CPU replica in
    // float64 gives 1.00000); the bound leaves only float32 rounding of the rebuilt positions. Before the fix the floor
    // read 0.980: samples 1 to 3 pixels out, rounded off the slice, rose above the floor's tangent in the slice.
    for (const name of ['floor', 'slope'])
      assert.ok(result.plain[name][0] >= 0.999, `the plain GTAO reads 1 on an open ${name} (${result.plain[name]})`);
    // The 90 degree crease keeps its occlusion: 0.5 at the crease itself (half the cosine-weighted hemisphere is the wall),
    // the unblurred pixels nearest it 0.51 to 0.62 in the CPU replica, the open floor and wall around it near 1. The view
    // read here is after the bilateral blur: measured on an RTX A6000, 0.674 (WebGPU) and 0.612 (WebGL2) at its darkest,
    // 0.690 before the fix (WebGPU), up to 0.992 and 0.983 in the 9 x 9 pixels around it.
    assert.ok(
      result.plain.crease[0] >= 0.45 && result.plain.crease[0] <= 0.72 && result.plain.crease[1] >= 0.98,
      `the crease reads about 0.5 and the open surfaces around it 1 (${result.plain.crease})`,
    );
    // Measured on an RTX A6000 (before KB-GTAO-OPENFLOOR1, with the sky search starting 4 pixels out): 0.9983 to 0.9987
    // on the floor, 0.9997 on the slope.
    for (const name of ['floor', 'slope'])
      assert.ok(
        result[name].min >= 0.995 && result[name].max <= 1,
        `an open ${name} reads 1 (${result[name].min} to ${result[name].max})`,
      );
    // Measured 0.4711 against 0.4472: the nearest sample past the rim lies about half a step (0.1 m here) beyond it, so
    // the horizon reads low by about 2 degrees; the bound is that step.
    assert.ok(
      Math.abs(result.slot.share - analytic) <= 0.03,
      `the slot floor reads its view factor ${analytic.toFixed(4)} (${result.slot.share.toFixed(4)})`,
    );
  },
);
