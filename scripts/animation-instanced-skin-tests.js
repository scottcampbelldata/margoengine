// Real-GPU check of SkinnedCrowd (packages/animation/src/instanced-skin.ts). The vertex stage's own `skinned` function,
// run from a compute shader over every vertex of every member, must match poseBones (its CPU twin) for 70 members with
// their own clips, offsets, speeds and blends. Then the crowd is drawn: one member posed as a plain Animation must cover
// the same pixels as that Animation drawn alone.
// Runs as `npm run test:gpu:instanced-skin -w @margoengine/animation` (check:gpu-packages).
import assert from 'node:assert/strict';
import { openBrowser } from './browser.js';
import { skinnedStrip } from '../packages/animation/test/fixture.js';

const strip = skinnedStrip({ columns: 33, extraClip: true }),
  browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 5195 }),
  { page } = browser,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' || /Error while parsing|Invalid .*Pipeline|ValidationError/.test(message.text()))
    errors.push(message.text());
});
try {
  const result = await page.evaluate(
    async ({ doc, buffers }) => {
      const { Engine } = await import('/packages/core/dist/index.js'),
        { parseGLTF } = await import('/packages/gltf-pro/dist/index.js'),
        { Animation } = await import('/packages/animation/dist/index.js'),
        { SkinnedCrowd, bakeBones, poseBones, skinnedCrowdVertex, SKINNED_CROWD_STRIDE } = await import(
          '/packages/animation/dist/instanced-skin.js'
        );
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      canvas.style.cssText = 'width:256px;height:256px';
      document.body.append(canvas);
      const engine = await Engine.create(canvas, {
          backend: 'webgpu',
          capacity: 1024,
          camera: { position: [1, 0.5, 5], target: [1, 0.5, 0], near: 0.01, far: 50 },
        }),
        device = engine.gpu;
      device.pushErrorScope('validation');
      const data = buffers.map((b) => Uint8Array.from(b)),
        model = parseGLTF(engine, doc, data);
      if (engine.plugins.get(model.name) !== model) engine.use(model);
      const animation = Animation.attach(model);
      animation.playing = false;
      const bake = bakeBones(animation, { fps: 30 }),
        crowd = SkinnedCrowd.attach(engine, bake);
      const members = [];
      for (let i = 0; i < 70; i++) {
        const member = {
          clip: i % 2,
          offset: (i % 7) * 0.13,
          speed: 0.5 + (i % 3) * 0.25,
          blendClip: (i + 1) % 2,
          blendOffset: (i % 5) * 0.21,
          blendSpeed: 1 + (i % 4) * 0.5,
          blend: (i % 6) / 5,
        };
        members.push(member);
        crowd.add(member);
      }
      crowd.time = 0.37;
      engine.render({ culling: false, delta: 0 });
      const time = crowd['frame'][32];

      // The compute twin of the vertex stage: the same module text, the same bindings.
      const code = `${skinnedCrowdVertex}
struct In {position:vec4f,normal:vec4f,j0:vec4u,j1:vec4u,w0:vec4f,w1:vec4f}
@group(1) @binding(0) var<storage,read> vertices:array<In>;
@group(1) @binding(1) var<storage,read_write> result:array<vec4f>;
@compute @workgroup_size(64) fn readback(@builtin(global_invocation_id) id:vec3u) {
  let n=arrayLength(&vertices);if(id.x>=n*${members.length}u){return;}
  let v=vertices[id.x%n];let s=instances[id.x/n];
  result[id.x]=vec4f(skinned(s,v.position.xyz,v.normal.xyz,v.j0,v.j1,v.w0,v.w1).position,1.0);
}`;
      const pipeline = device.createComputePipeline({
          layout: 'auto',
          compute: { module: device.createShaderModule({ code }), entryPoint: 'readback' },
        }),
        count = bake.vertexCount,
        input = new ArrayBuffer(count * 96),
        floats = new Float32Array(input),
        words = new Uint32Array(input);
      for (let v = 0; v < count; v++) {
        floats.set(bake.vertices.subarray(v * 6, v * 6 + 3), v * 24);
        floats.set(bake.vertices.subarray(v * 6 + 3, v * 6 + 6), v * 24 + 4);
        words.set(bake.joints.subarray(v * 8, v * 8 + 8), v * 24 + 8);
        floats.set(bake.weights.subarray(v * 8, v * 8 + 8), v * 24 + 16);
      }
      const vertices = device.createBuffer({ size: input.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
        size = count * members.length * 16,
        output = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
        staging = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
        g = crowd['gpu'];
      device.queue.writeBuffer(vertices, 0, input);
      const encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: g.frame } },
            { binding: 1, resource: { buffer: g.instances } },
            { binding: 2, resource: { buffer: g.clips } },
            { binding: 3, resource: g.vat.createView() },
          ],
        }),
      );
      pass.setBindGroup(
        1,
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(1),
          entries: [
            { binding: 0, resource: { buffer: vertices } },
            { binding: 1, resource: { buffer: output } },
          ],
        }),
      );
      pass.dispatchWorkgroups(Math.ceil((count * members.length) / 64));
      pass.end();
      encoder.copyBufferToBuffer(output, 0, staging, 0, size);
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const actual = new Float32Array(staging.getMappedRange()).slice();
      staging.unmap();
      let worst = 0,
        checks = 0,
        failure = null;
      members.forEach((member, m) => {
        const expected = poseBones(bake, member, time);
        for (let v = 0; v < count; v++)
          for (let c = 0; c < 3; c++) {
            const d = Math.abs(actual[(m * count + v) * 4 + c] - expected[v * 3 + c]);
            if (d > 1e-5 && !failure) failure = { m, v, c, actual: actual[(m * count + v) * 4 + c], expected: expected[v * 3 + c] };
            worst = Math.max(worst, d);
            checks++;
          }
      });

      // Pixels: the crowd's one member against the model it was baked from, at the same pose.
      // In the task that rendered: the canvas's texture is gone once the frame is presented.
      const pixels = async () => {
        engine.render({ culling: false, delta: 0 });
        const copy = document.createElement('canvas');
        copy.width = copy.height = 256;
        const context = copy.getContext('2d', { willReadFrequently: true });
        context.drawImage(canvas, 0, 0);
        return context.getImageData(0, 0, 256, 256).data;
      };
      const covered = (image, background) => {
        const out = new Uint8Array(256 * 256);
        for (let i = 0; i < out.length; i++)
          out[i] = +(Math.abs(image[i * 4] - background[i * 4]) + Math.abs(image[i * 4 + 1] - background[i * 4 + 1]) + Math.abs(image[i * 4 + 2] - background[i * 4 + 2]) > 12);
        return out;
      };
      // Half way through 'bend', on a frame row: the crowd's pose there is the model's.
      animation.play(0);
      animation.seek(0.5);
      crowd.truncate(0);
      model.root.visible = false;
      const background = await pixels();
      model.root.visible = true;
      const reference = covered(await pixels(), background);
      model.root.visible = false;
      crowd.add({ clip: 0, speed: 0, offset: 0.5 });
      const drawn = covered(await pixels(), background);
      let same = 0,
        total = 0,
        differ = 0;
      for (let i = 0; i < reference.length; i++) {
        if (reference[i] || drawn[i]) total++;
        if (reference[i] && drawn[i]) same++;
        if (reference[i] !== drawn[i]) differ++;
      }
      const error = await device.popErrorScope();
      return {
        worst,
        checks,
        failure,
        drawn: total,
        same,
        differ,
        draws: engine.stats.drawCalls,
        validation: error?.message ?? null,
      };
    },
    { doc: strip.doc, buffers: strip.buffers.map((b) => [...new Uint8Array(b.buffer, b.byteOffset, b.byteLength)]) },
  );
  console.log(JSON.stringify(result));
  assert.deepEqual(errors, []);
  assert.equal(result.validation, null);
  assert.equal(result.failure, null);
  assert.ok(result.checks >= 70 * 66 * 3, 'every vertex of every member checked');
  assert.ok(result.worst < 1e-5, `the GPU pose differs from poseBones by ${result.worst}`);
  assert.ok(result.drawn > 500, `the strip should cover pixels, drew ${result.drawn}`);
  assert.ok(result.differ / result.drawn < 0.01, `crowd and model differ on ${result.differ} of ${result.drawn} pixels`);
} finally {
  await browser.close();
}
