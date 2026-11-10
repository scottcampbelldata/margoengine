import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
await mkdir('test-results/vrm-constraints', { recursive: true });
const context = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' });
const errors = [];
context.page.on('pageerror', (e) => errors.push(e.message));
try {
  for (const filename of ['Seed-san', 'VRM1_Constraint_Twist_Sample']) {
    const result = await context.page.evaluate(async (filename) => {
      const { EngineKernel } = await import('/packages/core/dist/index.js');

      const { SceneTarget } = await import('/packages/shared/msaa.js');
      const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
      const { addVRMConstraints } = await import('/packages/rigging/dist/vrm-constraints.js');
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:256px;height:256px';
      document.body.replaceChildren(canvas);
      const engine = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 16,
        camera: { position: [0, 0, 3], target: [0, 0, 0], near: 0.1, far: 10 },
      });
      engine.camera.fov = 50;
      const d = engine.gpu;
      d.pushErrorScope('validation');
      engine.render({ delta: 0 });
      await d.queue.onSubmittedWorkDone();
      const width = canvas.width,
        height = canvas.height;
      const color = d.createTexture({ size: [width, height], format: 'rgba16float', usage: 20 });
      const depth = d.createTexture({ size: [width, height], format: 'depth32float', usage: 20 });
      const target = new SceneTarget(d, color, depth, 1);
      engine.use({
        name: 'mtoon:oracle-capture',
        setup() {},
        registerPasses(graph) {
          graph.add({
            name: 'mtoon:oracle-begin',
            order: 0.9,
            execute(c) {
              target.begin(c);
              const p = c.encoder.beginRenderPass({
                colorAttachments: [{ view: target.color, loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' }],
                depthStencilAttachment: {
                  view: target.depth,
                  depthLoadOp: 'clear',
                  depthClearValue: 0,
                  depthStoreOp: 'store',
                },
              });
              p.end();
            },
          });
          graph.add({
            name: 'mtoon:oracle-end',
            order: 5,
            execute(c) {
              target.present(c);
            },
          });
        },
      });
      const { parseGLTFAsync } = await import('/packages/gltf-pro/dist/index.js');
      const { glbChunks, GLB_JSON, GLB_BIN } = await import('/packages/shared/glb.js');
      const { multiplyQuaternions } = await import('/packages/math/dist/quat.js');
      const { Animation } = await import('/packages/animation/dist/index.js');
      const { Animator } = await import('/packages/animator/dist/index.js');
      const { MToon } = await import('/packages/rigging/dist/mtoon.js');
      const response = await fetch('/examples/assets/vrm/' + filename + '.vrm');
      const chunks = glbChunks(new Uint8Array(await response.arrayBuffer())),
        doc = JSON.parse(new TextDecoder().decode(chunks.find((c) => c.type === GLB_JSON).data)),
        bin = chunks.find((c) => c.type === GLB_BIN).data,
        authored = doc.nodes
          .map((node, index) => ({ index, extension: node.extensions?.VRMC_node_constraint }))
          .filter((v) => v.extension);
      const sources = [...new Set(authored.map(({ extension }) => Object.values(extension.constraint)[0].source))],
        delta = [0.2, 0.3, 0.1, Math.sqrt(0.86)],
        parts = [bin],
        channels = [],
        samplers = [];
      let offset = bin.byteLength;
      const add = (data, type) => {
        const view = doc.bufferViews.length,
          accessor = doc.accessors.length;
        doc.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.byteLength });
        doc.accessors.push({
          bufferView: view,
          componentType: 5126,
          count: data.length / (type === 'VEC4' ? 4 : 1),
          type,
          ...(type === 'SCALAR' ? { min: [0], max: [1] } : {}),
        });
        parts.push(new Uint8Array(data.buffer));
        offset += data.byteLength;
        return accessor;
      };
      const time = add(new Float32Array([0, 1]), 'SCALAR');
      for (const source of sources) {
        const node = doc.nodes[source],
          rest = node.rotation ?? [0, 0, 0, 1];
        if (node.matrix) throw new Error('This standard constraint fixture must use TRS animation nodes');
        const output = add(new Float32Array([...rest, ...multiplyQuaternions(rest, delta)]), 'VEC4');
        channels.push({ sampler: samplers.length, target: { node: source, path: 'rotation' } });
        samplers.push({ input: time, output, interpolation: 'LINEAR' });
      }
      doc.animations = [{ name: 'Constraint proof', channels, samplers }];
      doc.buffers[0].byteLength = offset;
      const json = new TextEncoder().encode(JSON.stringify(doc)),
        jsonLength = (json.length + 3) & ~3,
        bytes = new Uint8Array(28 + jsonLength + offset),
        header = new DataView(bytes.buffer);
      [0x46546c67, 2, bytes.length, jsonLength, GLB_JSON].forEach((v, i) => header.setUint32(i * 4, v, true));
      bytes.fill(32, 20, 20 + jsonLength);
      bytes.set(json, 20);
      header.setUint32(20 + jsonLength, offset, true);
      header.setUint32(24 + jsonLength, GLB_BIN, true);
      let at = 28 + jsonLength;
      for (const part of parts) {
        bytes.set(part, at);
        at += part.length;
      }
      const model = await parseGLTFAsync(engine, bytes, { signal: AbortSignal.timeout(90000) });
      model.root.setPosition([0, -0.8, 0]);
      const material = MToon.attach(model);
      const animation = Animation.attach(model),
        animator = Animator.attach(animation, { states: { pose: 'Constraint proof' }, initial: 'pose' });
      animator.onPreUpdate(0.5);
      animator.playing = false;
      const module = d.createShaderModule({
        code: `@group(0) @binding(0) var image:texture_2d<f32>;@group(0) @binding(1) var<storage,read_write> out:array<vec4f>;
   @compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){let size=textureDimensions(image);if(id.x<size.x&&id.y<size.y){out[id.y*size.x+id.x]=textureLoad(image,vec2i(id.xy),0);}}`,
      });
      const pipeline = d.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
      const output = d.createBuffer({ size: width * height * 16, usage: 132 }),
        staging = d.createBuffer({ size: width * height * 16, usage: 9 });
      const group = d.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: color.createView() },
          { binding: 1, resource: { buffer: output } },
        ],
      });
      async function read() {
        const e = d.createCommandEncoder(),
          p = e.beginComputePass();
        p.setPipeline(pipeline);
        p.setBindGroup(0, group);
        p.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
        p.end();
        e.copyBufferToBuffer(output, 0, staging, 0, width * height * 16);
        d.queue.submit([e.finish()]);
        await staging.mapAsync(1);
        const rgba = Array.from(new Float32Array(staging.getMappedRange()));
        staging.unmap();
        return rgba;
      }
      engine.lighting.radiance.set([1, 1, 1, 0.4]);
      engine.lighting.direction.set([1, 1, 1, 1]);
      const render = async () => {
        await waitForPipelines(async () => {
          engine.render({ delta: 0 });
          await d.queue.onSubmittedWorkDone();
        });
        return read();
      };
      const changed = (a, b) => {
        let count = 0;
        for (let k = 0; k < a.length; k += 4)
          if (
            Math.abs(a[k] - b[k]) +
              Math.abs(a[k + 1] - b[k + 1]) +
              Math.abs(a[k + 2] - b[k + 2]) +
              Math.abs(a[k + 3] - b[k + 3]) >
            0.01
          )
            count++;
        return count;
      };
      const uncontrolled = await render(),
        handle = addVRMConstraints(model, { animator }),
        controlled = await render();
      let drawn = 0;
      for (let k = 3; k < controlled.length; k += 4) if (controlled[k] > 0.01) drawn++;
      const t = engine.store.transforms,
        rotations = handle.constraints.map((c) => {
          const i = model.nodes[c.target].id;
          return [t.qx[i], t.qy[i], t.qz[i], t.qw[i]];
        });
      handle.dispose();
      const restored = await render();
      const result = {
        filename,
        width,
        height,
        constraints: authored.length,
        drawn,
        changed: changed(uncontrolled, controlled),
        restored: changed(uncontrolled, restored),
        rotations,
      };
      const validation = await d.popErrorScope();
      window.constraintCleanup = () => {
        handle.dispose();
        material.dispose();
        animator.dispose();
        animation.dispose();
        model.dispose();
        engine.dispose();
        target.dispose();
        color.destroy();
        depth.destroy();
        output.destroy();
        staging.destroy();
      };
      return { ...result, validation: validation?.message };
    }, filename);
    assert.equal(result.validation, undefined);
    assert.deepEqual(errors, []);
    assert.equal(result.constraints, filename === 'Seed-san' ? 23 : 14);
    assert.ok(result.drawn > 2000, JSON.stringify(result));
    assert.ok(result.changed > 10, JSON.stringify(result));
    assert.equal(result.restored, 0);
    await context.page.screenshot({
      path: `test-results/vrm-constraints/${result.filename}${process.argv.includes('--compat') ? '-compat' : ''}.png`,
    });
    await context.page.evaluate(() => window.constraintCleanup());
    console.log(JSON.stringify(result));
    await writeFile(
      `test-results/vrm-constraints/${result.filename}${process.argv.includes('--compat') ? '-compat' : ''}.json`,
      JSON.stringify(result, null, 2),
    );
  }
} finally {
  await context.close();
}
