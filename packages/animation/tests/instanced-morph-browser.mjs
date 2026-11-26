// Real-GPU check of MorphedCrowd (packages/animation/src/instanced-morph.ts). The vertex stage's own `morphed` and
// `skinned` functions, run from a compute shader over every vertex of every member, must match poseMorphedBones (their
// CPU twin) for 48 members with their own weights, clips and blends. Then the crowd is drawn: one member at given
// weights must cover the pixels of the model itself at those weights, and two members at different weights must cover
// two shapes, not one.
// Runs as `npm run test:gpu:instanced-morph -w @margoengine/animation`; add `-- --compat` for the WebGL2 layer.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { morphedStrip } from '../test/fixture.js';

const strip = morphedStrip({ columns: 33, extraClip: true }),
  browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 5243 }),
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
        { parseGLTF } = await import('/packages/gltf/dist/pbr.js'),
        { Animation } = await import('/packages/animation/dist/index.js'),
        { MorphedCrowd, bakeMorphBones, poseMorphedBones, morphedCrowdVertex } = await import(
          '/packages/animation/dist/instanced-morph.js'
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
      const bake = bakeMorphBones(animation, { fps: 30 }),
        crowd = MorphedCrowd.attach(engine, bake);
      const members = [];
      for (let i = 0; i < 48; i++) {
        const member = {
          clip: i % 2,
          offset: (i % 7) * 0.13,
          speed: 0.5 + (i % 3) * 0.25,
          blendClip: (i + 1) % 2,
          blendOffset: (i % 5) * 0.21,
          blendSpeed: 1 + (i % 4) * 0.5,
          blend: (i % 6) / 5,
          // Zero, one, between, negative and past one; the first member keeps the bake weights.
          morphs: i ? [[0, 1, 0.5, -0.25, 1.5][i % 5], [0, 0, 1, 0.75, -0.5, 2][i % 6]] : undefined,
        };
        members.push(member);
        crowd.add(member);
      }
      // Weights set after the add reach the GPU too.
      crowd.setMorph(7, 'lift', 0.6).set(9, { morphs: { stretch: 0.3 } });
      members[7] = { ...members[7], morphs: [0.6, members[7].morphs[1]] };
      members[9] = { ...members[9], morphs: [members[9].morphs[0], 0.3] };
      crowd.time = 0.37;
      engine.render({ culling: false, delta: 0 });
      const time = crowd['frame'][32];

      // The compute twin of the vertex stage: the same module text, the same bindings.
      const code = `${morphedCrowdVertex(1)}
struct In {position:vec4f,normal:vec4f,j0:vec4u,j1:vec4u,w0:vec4f,w1:vec4f,morph:vec4u}
@group(1) @binding(0) var<storage,read> vertices:array<In>;
@group(1) @binding(1) var<storage,read_write> result:array<vec4f>;
@compute @workgroup_size(64) fn readback(@builtin(global_invocation_id) id:vec3u) {
  let n=arrayLength(&vertices);if(id.x>=n*${members.length}u){return;}
  let v=vertices[id.x%n];let s=instances[id.x/n];let b=morphed(s,v.position.xyz,v.normal.xyz,v.morph);
  result[id.x]=vec4f(skinned(s,b.position,b.normal,v.j0,v.j1,v.w0,v.w1).position,1.0);
}`;
      const pipeline = device.createComputePipeline({
          layout: 'auto',
          compute: { module: device.createShaderModule({ code }), entryPoint: 'readback' },
        }),
        count = bake.vertexCount,
        input = new ArrayBuffer(count * 112),
        floats = new Float32Array(input),
        words = new Uint32Array(input);
      for (let v = 0; v < count; v++) {
        floats.set(bake.vertices.subarray(v * 6, v * 6 + 3), v * 28);
        floats.set(bake.vertices.subarray(v * 6 + 3, v * 6 + 6), v * 28 + 4);
        words.set(bake.joints.subarray(v * 8, v * 8 + 8), v * 28 + 8);
        floats.set(bake.weights.subarray(v * 8, v * 8 + 8), v * 28 + 16);
        words.set(bake.morphs.vertices.subarray(v * 4, v * 4 + 4), v * 28 + 24);
      }
      const vertices = device.createBuffer({
          size: input.byteLength,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        }),
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
        failure = null,
        moved = 0;
      members.forEach((member, m) => {
        const expected = poseMorphedBones(bake, member, time),
          unmorphed = poseMorphedBones(bake, { ...member, morphs: [0, 0] }, time);
        for (let v = 0; v < count; v++)
          for (let c = 0; c < 3; c++) {
            const d = Math.abs(actual[(m * count + v) * 4 + c] - expected[v * 3 + c]);
            if (d > 1e-5 && !failure)
              failure = { m, v, c, actual: actual[(m * count + v) * 4 + c], expected: expected[v * 3 + c] };
            worst = Math.max(worst, d);
            moved = Math.max(moved, Math.abs(expected[v * 3 + c] - unmorphed[v * 3 + c]));
            checks++;
          }
      });

      // Pixels. In the task that rendered: the canvas's texture is gone once the frame is presented.
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
          out[i] = +(
            Math.abs(image[i * 4] - background[i * 4]) +
              Math.abs(image[i * 4 + 1] - background[i * 4 + 1]) +
              Math.abs(image[i * 4 + 2] - background[i * 4 + 2]) >
            12
          );
        return out;
      };
      const compare = (a, b) => {
        let total = 0,
          differ = 0;
        for (let i = 0; i < a.length; i++) {
          if (a[i] || b[i]) total++;
          if (a[i] !== b[i]) differ++;
        }
        return { total, differ };
      };
      // Half way through 'bend', on a frame row: the crowd's pose there is the model's.
      animation.play(0);
      animation.seek(0.5);
      crowd.truncate(0);
      model.root.visible = false;
      const background = await pixels(),
        weights = model.primitives[0].weights,
        shapes = [];
      for (const w of [
        [0, 0],
        [1, 0.5],
        [-0.5, 1],
      ]) {
        weights.set(w);
        model.root.visible = true;
        const reference = covered(await pixels(), background);
        model.root.visible = false;
        crowd.add({ clip: 0, speed: 0, offset: 0.5, morphs: w });
        shapes.push({ w, ...compare(reference, covered(await pixels(), background)) });
        crowd.truncate(0);
      }
      // Two members in one draw, one lifted clear of the other: twice the pixels of one.
      crowd.add({ clip: 0, speed: 0, offset: 0, morphs: [0, 0] });
      const one = covered(await pixels(), background).reduce((n, x) => n + x, 0);
      const second = crowd.add({ clip: 0, speed: 0, offset: 0, morphs: [0, 0] });
      const same = covered(await pixels(), background).reduce((n, x) => n + x, 0);
      crowd.setMorph(second, 'lift', 1);
      const two = covered(await pixels(), background).reduce((n, x) => n + x, 0),
        draws = engine.stats.drawCalls,
        error = await device.popErrorScope();
      return {
        compat: !!globalThis.__margoCompat,
        worst,
        checks,
        failure,
        moved,
        shapes,
        one,
        same,
        two,
        draws,
        vertexCount: count,
        validation: error?.message ?? null,
      };
    },
    { doc: strip.doc, buffers: strip.buffers.map((b) => [...new Uint8Array(b.buffer, b.byteOffset, b.byteLength)]) },
  );
  console.log(JSON.stringify(result));
  assert.deepEqual(errors, []);
  assert.equal(result.validation, null);
  assert.equal(result.failure, null);
  assert.equal(result.checks, 48 * 66 * 3, 'every vertex of every member checked');
  assert.ok(result.worst < 1e-5, `the GPU pose differs from poseMorphedBones by ${result.worst}`);
  assert.ok(result.moved > 1, `the weights must move the vertices, moved ${result.moved}`);
  for (const shape of result.shapes) {
    assert.ok(shape.total > 500, `the strip should cover pixels at weights ${shape.w}, drew ${shape.total}`);
    assert.ok(
      shape.differ / shape.total < 0.01,
      `crowd and model differ on ${shape.differ} of ${shape.total} pixels at weights ${shape.w}`,
    );
  }
  assert.equal(result.same, result.one, 'two members at the same weights cover one shape');
  assert.ok(
    result.two > result.one * 1.8 && result.two <= result.one * 2.1,
    `two members at different weights: ${result.two} of ${result.one}`,
  );
  assert.equal(result.draws, 1, 'one draw call');
  console.log(`per-member morph weights ok on ${result.compat ? 'the WebGL2 compatibility layer' : 'WebGPU'}`);
} finally {
  await browser.close();
}
