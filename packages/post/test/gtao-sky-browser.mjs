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
import { compatRun } from '../../../scripts/support/compat-shim.js';

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
              {
                binding: 0,
                visibility: 4,
                texture: { sampleType: 'unfilterable-float' },
              },
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
      // A (2 * half + 1)^2 block of `channels` floats around the middle of `view`, row by row.
      const readBlock = async (view, half, channels) => {
        const gpu = device.current,
          n = 2 * half + 1,
          bytes = n * n * channels * 4,
          layout = gpu.createBindGroupLayout({
            entries: [
              {
                binding: 0,
                visibility: 4,
                texture: { sampleType: 'unfilterable-float' },
              },
              { binding: 1, visibility: 4, buffer: { type: 'storage' } },
            ],
          }),
          pipeline = gpu.createComputePipeline({
            layout: gpu.createPipelineLayout({ bindGroupLayouts: [layout] }),
            compute: {
              module: gpu.createShaderModule({
                code: `@group(0) @binding(0) var t:texture_2d<f32>;@group(0) @binding(1) var<storage,read_write> out:array<f32>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){if(any(id.xy>=vec2u(${n}u))){return;}let c=vec2i(textureDimensions(t)/2u);let v=textureLoad(t,c+vec2i(id.xy)-${half},0);let o=(id.y*${n}u+id.x)*${channels}u;for(var k=0u;k<${channels}u;k++){out[o+k]=v[k];}}`,
              }),
              entryPoint: 'main',
            },
          }),
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
              { binding: 0, resource: view },
              { binding: 1, resource: { buffer: storage } },
            ],
          }),
        );
        pass.dispatchWorkgroups(Math.ceil(n / 8), Math.ceil(n / 8));
        pass.end();
        encoder.copyBufferToBuffer(storage, 0, readback, 0, bytes);
        gpu.queue.submit([encoder.finish()]);
        await readback.mapAsync(1);
        const values = Array.from(new Float32Array(readback.getMappedRange().slice(0)));
        readback.unmap();
        return values;
      };
      // Visibility (81 values around the middle) of a scene with sky occlusion at `skyRadius`, after a few frames.
      window.measure = async (name, skyRadius) => {
        const scene = scenes[name],
          engine = await Engine.create(canvas, {
            backend: 'webgpu',
            camera: scene.camera,
          });
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
        const gtao = GTAO.attach(engine, {
            slices: 4,
            steps: 16,
            skySteps: 32,
          }),
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
        // The blur's inputs (the raw AO it smooths, view depth, G-buffer normals) and output around the middle, and its
        // two pass settings (axis, radius, orthographic flag), for the CPU replica.
        if (name === 'crease')
          result.blur = {
            raw: await readBlock(gtao.raw, 16, 1),
            depth: await readBlock(gtao.viewDepth, 16, 1),
            normal: await readBlock(gtao.gbuffer, 16, 4),
            ao: await readBlock(gtao.occlusionView, 16, 1),
            passes: gtao.directionValues.map((v) => Array.from(v)),
          };
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
        slot: {
          off: centre(slot.off),
          on: centre(slot.on),
          share: centre(slot.on) / centre(slot.off),
          analytic,
        },
        plain: {
          floor: [Math.min(...floor.off), Math.max(...floor.off)],
          slope: [Math.min(...slope.off), Math.max(...slope.off)],
          crease: [Math.min(...crease.off), Math.max(...crease.off)],
        },
      };
    // CPU replica of the separable 9-tap bilateral blur (packages/post/src/shaders.ts blurShader) over the 33 x 33 block
    // read around the crease: Gaussian exp(-i^2/8), the depth weight against the depth the centre's own plane has at the
    // tap (KB-POST-GTAOFAR1), the normal weight dot^8. Valid where both passes stay inside the block (4 px margins).
    const B = 33,
      { raw, depth, normal, ao, passes } = crease.blur,
      at = (x, y) => y * B + x,
      dot3 = (a, b) =>
        normal[a * 4] * normal[b * 4] + normal[a * 4 + 1] * normal[b * 4 + 1] + normal[a * 4 + 2] * normal[b * 4 + 2],
      pass = (input, [ax, ay, radius, ortho], x0, x1, y0, y1) => {
        const out = new Float64Array(B * B);
        for (let y = y0; y <= y1; y++)
          for (let x = x0; x <= x1; x++) {
            const p = at(x, y),
              centre = depth[p],
              ahead = depth[at(x + ax, y + ay)],
              behind = depth[at(x - ax, y - ay)],
              forward = Math.abs(ahead - centre) < Math.abs(centre - behind),
              near = forward ? ahead : behind,
              inv = (d) => (ortho > 0.5 ? d : 1 / Math.max(d, 1e-30)),
              key = inv(centre),
              slope = centre > 0 && near > 0 ? (forward ? 1 : -1) * (inv(near) - key) : 0;
            let sum = 0,
              total = 0;
            for (let i = -4; i <= 4; i++) {
              const q = at(x + ax * i, y + ay * i),
                along = key + slope * i,
                expected = slope !== 0 && i !== 0 ? (ortho > 0.5 ? along : along > 0 ? 1 / along : centre) : centre,
                depthWeight = Math.exp(-Math.abs(expected - depth[q]) / Math.max(radius * 0.1, 0.0001)),
                normalWeight = Math.max(dot3(p, q), 0) ** 8,
                w = Math.exp(-(i * i) / 8) * depthWeight * (centre === 0 ? 1 : normalWeight);
              sum += input[q] * w;
              total += w;
            }
            out[p] = sum / Math.max(total, 0.000001);
          }
        return out;
      };
    const blurred = pass(pass(raw, passes[0], 4, 28, 0, 32), passes[1], 4, 28, 4, 28);
    // Floor or wall: a pixel's normal against the block's bottom (floor) and top (wall) middle pixels.
    const floorAt = (x, y) => dot3(at(x, y), at(16, 32)) > dot3(at(x, y), at(16, 0));
    let creaseRow = 0;
    while (!floorAt(16, creaseRow)) creaseRow++;
    // Floor rows 0 to 4 px from the crease, over the 17 middle columns.
    let replicaError = 0;
    for (let y = creaseRow; y <= creaseRow + 4; y++)
      for (let x = 8; x <= 24; x++) replicaError = Math.max(replicaError, Math.abs(blurred[at(x, y)] - ao[at(x, y)]));
    // The total darkness (sum of 1 - AO) of the crease profile, blurred against raw, and the 17 x 17 read's outer rows.
    let darkRaw = 0,
      darkAo = 0;
    for (let y = 4; y <= 28; y++)
      for (let x = 8; x <= 24; x++) {
        darkRaw += 1 - raw[at(x, y)];
        darkAo += 1 - ao[at(x, y)];
      }
    const rows = (values) => Array.from({ length: 17 }, (_, j) => +values[at(16, 8 + j)].toFixed(3));
    let ringMin = 1;
    for (const y of [8, 24]) for (let x = 8; x <= 24; x++) ringMin = Math.min(ringMin, ao[at(x, y)]);
    result.blur = {
      ringMin,
      creaseRow: creaseRow - 16,
      replicaError,
      darkRaw,
      darkAo,
      rawRows: rows(raw),
      aoRows: rows(ao),
      cpuRows: rows(blurred),
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
    // read here is after the bilateral blur: measured on an RTX A6000, 0.692 (WebGPU) and 0.654 (WebGL2) at its darkest.
    assert.ok(
      result.plain.crease[0] >= 0.45 && result.plain.crease[0] <= 0.72,
      `the crease reads about 0.5 (${result.plain.crease})`,
    );
    // The open floor and wall past the blur's 4 px reach of the raw AO's dark band: the 17 x 17 read's top and bottom
    // rows (8 px from the middle). Until KB-POST-GTAOFAR1 this read the 9 x 9 maximum against 0.98, which held only
    // because the blur then hardly blurred across floor rows: floor rows from the crease read 0.711 .790 .892 .964 .992
    // before and 0.705 .862 .900 .935 .965 after (9 x 9 maximum 0.992 to 0.965 on WebGPU, 0.948 on WebGL2). Measured
    // 0.995 (WebGPU) and 0.997 (WebGL2).
    assert.ok(result.blur.ringMin >= 0.98, `the surfaces past the blur's reach read 1 (${result.blur.ringMin})`);
    // The blur is the shader's maths: a CPU 9-tap Gaussian (exp(-i^2/8)) of the raw AO with the same plane-predicted
    // depth and normal weights, both passes, on the floor rows 0 to 4 px from the crease. Measured 1.2e-6 and 1.1e-6.
    assert.ok(result.blur.replicaError <= 1e-3, `the blur matches its CPU replica (${result.blur.replicaError})`);
    // Total darkness (sum of 1 - AO over 17 columns and the 25 rows the replica covers), blurred against raw: an
    // accepted difference (docs/limits.md). An edge-stopped normalised blur loses darkness where the darkest pixels lie
    // against the edge and average only with the brighter side; the old blur lost 1.3 percent only because it hardly
    // blurred there. Measured -4.69 percent (WebGPU) and -5.35 (WebGL2); the bound pins that, so it may not get worse.
    const darkness = result.blur.darkAo / result.blur.darkRaw - 1;
    assert.ok(darkness >= (compatRun() ? -0.055 : -0.048), `the blur keeps the crease's darkness (${darkness})`);
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
