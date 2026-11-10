import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const context = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' });
const errors = [];
context.page.on('pageerror', (e) => errors.push(e.message));
try {
  for (const filename of ['Seed-san', 'VRM1_Constraint_Twist_Sample']) {
    const result = await context.page.evaluate(async (filename) => {
      const { EngineKernel } = await import('/packages/core/dist/index.js');

      const { SceneTarget } = await import('/packages/shared/msaa.js');
      const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
      const { readVRMA, playVRMA } = await import('/packages/rigging/dist/vrma.js');
      const { readVRM, addVRM } = await import('/packages/rigging/dist/vrm.js');
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
      const { MToon } = await import('/packages/rigging/dist/mtoon.js');
      const sourceBytes = new Uint8Array(await (await fetch('/examples/assets/vrm/Seed-san.vrm')).arrayBuffer()),
        sourceDoc = JSON.parse(new TextDecoder().decode(glbChunks(sourceBytes).find((c) => c.type === GLB_JSON).data)),
        targetBytes = new Uint8Array(await (await fetch('/examples/assets/vrm/' + filename + '.vrm')).arrayBuffer()),
        doc = JSON.parse(new TextDecoder().decode(glbChunks(targetBytes).find((c) => c.type === GLB_JSON).data));
      const model = await parseGLTFAsync(engine, targetBytes, { signal: AbortSignal.timeout(90000) });
      model.root.setPosition([0, -0.8, 0]);
      const material = MToon.attach(model),
        animation = Animation.attach(model),
        avatar = readVRM(doc),
        vrm = addVRM(animation, avatar, { springs: false });
      const bones = structuredClone(sourceDoc.extensions.VRMC_vrm.humanoid.humanBones);
      delete bones.leftEye;
      delete bones.rightEye;
      const motionDoc = {
        asset: { version: '2.0' },
        nodes: sourceDoc.nodes.map((n) => ({
          translation: n.translation,
          rotation: n.rotation,
          scale: n.scale,
          children: n.children,
        })),
        extensions: {
          VRMC_vrm_animation: {
            specVersion: '1.0',
            humanoid: { humanBones: bones },
            expressions: { preset: {} },
            lookAt: {},
          },
        },
        buffers: [],
        bufferViews: [],
        accessors: [],
        animations: [{ channels: [], samplers: [] }],
      };
      const parts = [];
      let offset = 0;
      const add = (array, type) => {
        const data = new Float32Array(array),
          i = motionDoc.accessors.length;
        motionDoc.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.byteLength });
        motionDoc.accessors.push({
          bufferView: i,
          componentType: 5126,
          count: data.length / (type === 'SCALAR' ? 1 : type === 'VEC3' ? 3 : 4),
          type,
        });
        parts.push(new Uint8Array(data.buffer));
        offset += data.byteLength;
        return i;
      };
      const time = add([0, 1], 'SCALAR');
      const track = (node, path, first, last) => {
        const sampler = motionDoc.animations[0].samplers.length;
        motionDoc.animations[0].samplers.push({
          input: time,
          output: add([...first, ...last], path === 'rotation' ? 'VEC4' : 'VEC3'),
        });
        motionDoc.animations[0].channels.push({ sampler, target: { node, path } });
      };
      for (const bone of ['head', 'leftUpperArm', 'rightUpperArm']) {
        const node = bones[bone].node,
          rest = motionDoc.nodes[node].rotation ?? [0, 0, 0, 1];
        track(node, 'rotation', rest, multiplyQuaternions(rest, [0, 0, 0.5, Math.sqrt(0.75)]));
      }
      const expressionNode = motionDoc.nodes.length;
      motionDoc.nodes.push({});
      motionDoc.extensions.VRMC_vrm_animation.expressions.preset.aa = { node: expressionNode };
      track(expressionNode, 'translation', [0, 0, 0], [1, 0, 0]);
      const lookNode = motionDoc.nodes.length;
      motionDoc.nodes.push({});
      motionDoc.extensions.VRMC_vrm_animation.lookAt.node = lookNode;
      track(lookNode, 'rotation', [0, 0, 0, 1], [0, 0.5, 0, Math.sqrt(0.75)]);
      motionDoc.buffers.push({ byteLength: offset });
      const buffer = new Uint8Array(offset);
      let cursor = 0;
      for (const part of parts) {
        buffer.set(part, cursor);
        cursor += part.length;
      }
      const data = await readVRMA(motionDoc, { buffers: [buffer] });
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
        handle = await playVRMA(data, animation, avatar, { vrm });
      handle.seek(0.75);
      const controlled = await render();
      let drawn = 0;
      for (let k = 3; k < controlled.length; k += 4) if (controlled[k] > 0.01) drawn++;
      const gaze = vrm.gaze,
        expression = vrm.expressions.get('aa');
      handle.dispose();
      const restored = await render();
      const result = {
        filename,
        width,
        height,
        drawn,
        changed: changed(uncontrolled, controlled),
        restored: changed(uncontrolled, restored),
        gaze,
        expression,
      };
      const validation = await d.popErrorScope();
      window.vrmaCleanup = () => {
        handle.dispose();
        material.dispose();
        vrm.dispose();
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
    assert.ok(result.gaze.yaw > 40 && result.gaze.yaw < 50);
    assert.ok(Math.abs(result.expression - 0.75) < 1e-6);
    assert.ok(result.drawn > 2000, JSON.stringify(result));
    assert.ok(result.changed > 10, JSON.stringify(result));
    assert.equal(result.restored, 0);
    await context.page.screenshot({
      path: `test-results/vrma/${result.filename}${process.argv.includes('--compat') ? '-compat' : ''}.png`,
    });
    await context.page.evaluate(() => window.vrmaCleanup());
    console.log(JSON.stringify(result));
    await writeFile(
      `test-results/vrma/${result.filename}${process.argv.includes('--compat') ? '-compat' : ''}.json`,
      JSON.stringify(result, null, 2),
    );
  }
} finally {
  await context.close();
}
