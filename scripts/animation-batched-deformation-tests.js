// Real-GPU check of Animation's batched deformation (packages/animation/src/batch.ts): every skinned or morphed
// primitive of a device deforms in one dispatch per buffer page and pipeline, from shared buffers. For random morph
// weights and poses, each primitive's deformed vertices must be bit-for-bit those of the per-primitive path it replaced
// (the original shaders, one dispatch per primitive into its own buffers, run here as the reference), while models with
// different vertex and morph target counts, skinned, morphed, skinned and morphed, and four or eight influences are
// added, cloned and disposed between checks; one dispatch per buffer page and pipeline must deform all of them.
// Runs as `npm run test:gpu -w @margoengine/animation` (check:gpu-packages); alone, after build:packages:
// node scripts/gpu-lock.mjs run --owner=<id> -- node scripts/animation-batched-deformation-tests.js
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { animatedTriangle } from '../tests/support/gltf-pro-fixture.js';

await mkdir('test-results', { recursive: true });
const triangle = animatedTriangle(),
  browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 5198 }),
  { page, hardware } = browser,
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
        { loadGLTF, parseGLTF } = await import('/packages/gltf-pro/dist/index.js'),
        { Animation } = await import('/packages/animation/dist/index.js'),
        { cloneModel } = await import('/packages/animation/dist/skeleton-utils.js'),
        { deformationShader, deformationShader8 } = await import('/packages/animation/src/shader.ts');
      const fail = (message) => {
        throw new Error(message);
      };
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:256px;height:256px';
      document.body.append(canvas);
      const engine = await Engine.create(canvas, {
          backend: 'webgpu',
          capacity: 8192,
          camera: { position: [0, 2, 12], target: [0, 0, 0], near: 0.01, far: 200 },
        }),
        device = engine.gpu;
      device.pushErrorScope('validation');
      // A seeded generator, so a failure repeats.
      let seed = 0x9e3779b9;
      const random = () => {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        return (seed >>> 0) / 2 ** 32;
      };
      const read = async (buffer, offset, size) => {
        const out = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
          encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(buffer, offset, out, 0, size);
        device.queue.submit([encoder.finish()]);
        await out.mapAsync(GPUMapMode.READ);
        const bytes = new Uint32Array(out.getMappedRange()).slice();
        out.unmap();
        out.destroy();
        return bytes;
      };
      const pipelines = {};
      const pipeline = (extra) =>
        (pipelines[extra] ??= device.createComputePipeline({
          layout: 'auto',
          compute: {
            module: device.createShaderModule({ code: extra ? deformationShader8 : deformationShader }),
            entryPoint: 'main',
          },
        }));
      const storage = (data, usage = GPUBufferUsage.STORAGE) => {
        const buffer = device.createBuffer({
          size: Math.max(16, data.byteLength),
          usage: usage | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });
        if (data.byteLength) device.queue.writeBuffer(buffer, 0, data);
        return buffer;
      };
      // The per-primitive path as it was: own source, output, deltas, weights, bones, influences and counts, one
      // dispatch. Deltas are rebuilt here from the accessors; influences and the bone palette are the CPU-validated
      // inputs Animation prepared for this frame.
      const reference = async (model, record) => {
        const p = record.primitive,
          count = p.vertices.length / 20,
          targets = p.definition.targets ?? [],
          deltas = new Float32Array(Math.max(12, count * targets.length * 12));
        targets.forEach((target, t) => {
          for (const [name, at] of [
            ['POSITION', 0],
            ['NORMAL', 4],
            ['TANGENT', 8],
          ])
            if (target[name] !== undefined) {
              const data = model.asset.accessor(target[name], 'VEC3');
              for (let i = 0; i < count; i++) deltas.set(data.subarray(i * 3, i * 3 + 3), (t * count + i) * 12 + at);
            }
        });
        const slot = record.slot,
          influences = slot.influences
            ? await read(
                slot.page.influences.buffer,
                slot.influences.range.offset * 16,
                slot.influences.range.size * 16,
              )
            : new Uint32Array(8),
          buffers = [
            storage(p.vertices),
            storage(p.vertices, GPUBufferUsage.STORAGE),
            storage(deltas),
            storage(new Float32Array(p.weights)),
            storage(record.joints.length ? record.palette : new Float32Array(16)),
            storage(influences),
            storage(new Uint32Array([count, targets.length, record.joints.length, 0]), GPUBufferUsage.UNIFORM),
          ],
          compute = pipeline(slot.extra),
          encoder = device.createCommandEncoder(),
          pass = encoder.beginComputePass();
        pass.setPipeline(compute);
        pass.setBindGroup(
          0,
          device.createBindGroup({
            layout: compute.getBindGroupLayout(0),
            entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
          }),
        );
        pass.dispatchWorkgroups(Math.ceil(count / 64));
        pass.end();
        device.queue.submit([encoder.finish()]);
        const out = await read(buffers[1], 0, p.vertices.byteLength);
        for (const buffer of buffers) buffer.destroy();
        return out;
      };
      // Count the compute dispatches of each frame.
      let dispatches = 0;
      const begin = GPUCommandEncoder.prototype.beginComputePass;
      GPUCommandEncoder.prototype.beginComputePass = function (...args) {
        const pass = begin.apply(this, args),
          dispatch = pass.dispatchWorkgroups;
        pass.dispatchWorkgroups = function (...n) {
          dispatches++;
          return dispatch.apply(this, n);
        };
        return pass;
      };
      const live = [];
      const attach = (model, label) => {
        const animation = Animation.attach(model);
        animation.playing = false;
        live.push({ model, animation, label });
        return animation;
      };
      const morph = await loadGLTF(engine, '/examples/assets/khronos/MorphStressTest/MorphStressTest.glb'),
        fox = await loadGLTF(engine, '/examples/assets/khronos/Fox/Fox.glb'),
        rig = await loadGLTF(engine, '/packages/animation/tests/fixtures/tentacle-rig.glb'),
        both = parseGLTF(
          engine,
          doc,
          buffers.map((b) => new Uint8Array(b)),
        );
      attach(morph, 'MorphStressTest');
      for (let i = 0; i < 3; i++) attach(await cloneModel(morph), 'MorphStressTest copy');
      attach(fox, 'Fox (skinned)');
      attach(rig, 'tentacle rig (skinned)');
      attach(both, 'triangle (skinned and morphed)');
      const checks = [];
      const pose = (entry) => {
        const { model, animation } = entry;
        for (const p of model.primitives)
          for (let k = 0; k < p.weights.length; k++) animation.setMorph(p.nodeIndex, k, random() * 2 - 0.5);
        if (animation.clips.length) animation.seek(random() * animation.clips[0].duration);
      };
      const verify = async (round) => {
        for (const entry of live) pose(entry);
        dispatches = 0;
        engine.render({ culling: false });
        const frameDispatches = dispatches;
        await device.queue.onSubmittedWorkDone();
        let primitives = 0;
        const pages = new Set();
        for (const { model, animation, label } of live)
          for (const record of animation.resources) {
            const p = record.primitive;
            if (!p.deformed || p.deformedOffset % 256) fail(label + ': deformed vertices are not on a 256-byte offset');
            pages.add(record.slot.page);
            const actual = await read(p.deformed, p.deformedOffset, p.vertices.byteLength),
              expected = await reference(model, record);
            for (let i = 0; i < expected.length; i++)
              if (actual[i] !== expected[i])
                fail(
                  `${label} round ${round}: batched vertex ${Math.floor(i / 20)} float ${i % 20} is ${new Float32Array(actual.buffer)[i]}, the per-primitive path ${new Float32Array(expected.buffer)[i]}`,
                );
            primitives++;
          }
        // Readback readers (picking snapshots) see the same bits at the primitive's offset.
        const snapshot = await morph.readPickingGeometry();
        if (!morph.disposed && snapshot.length !== morph.primitives.length) fail('readPickingGeometry lost primitives');
        const kinds = new Set(live.flatMap(({ animation }) => animation.resources.map((r) => r.slot.extra)));
        if (frameDispatches !== pages.size * kinds.size)
          fail(`round ${round}: ${frameDispatches} dispatches for ${pages.size} page(s) and ${kinds.size} pipeline(s)`);
        checks.push({ round, primitives, dispatches: frameDispatches, models: live.length });
      };
      await verify(0);
      // Remove a model from the middle (a hole), add copies (growth and compaction), then remove the source.
      const removed = live.splice(1, 1)[0];
      removed.model.dispose();
      await verify(1);
      for (let i = 0; i < 6; i++) attach(await cloneModel(morph), 'MorphStressTest late copy');
      await verify(2);
      const source = live.findIndex((entry) => entry.model === morph);
      live.splice(source, 1)[0].model.dispose();
      for (let round = 3; round < 8; round++) await verify(round);
      GPUCommandEncoder.prototype.beginComputePass = begin;
      const validation = await device.popErrorScope();
      if (validation) fail('Validation: ' + validation.message);
      for (const { model } of live) model.dispose();
      const empty = live.every(({ model }) => model.primitives.every((p) => p.deformed === undefined));
      engine.dispose();
      return { checks, empty };
    },
    {
      doc: triangle.doc,
      buffers: triangle.buffers.map((b) => [...new Uint8Array(b.buffer, b.byteOffset, b.byteLength)]),
    },
  );
  assert.equal(result.empty, true);
  assert.ok(result.checks.length === 8);
  assert.deepEqual(errors, []);
  await writeFile(
    'test-results/animation-batched-deformation.json',
    JSON.stringify({ hardware, ...result }, null, 2) + '\n',
  );
  console.log(JSON.stringify({ hardware, ...result }));
} finally {
  await browser.close();
}
