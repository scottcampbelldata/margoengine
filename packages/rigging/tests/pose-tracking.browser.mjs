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
      const { addPoseTracking } = await import('/packages/rigging/dist/pose-tracking.js');
      const { bodyPoints, handPoints } = await import('/packages/rigging/tests/pose-tracking-fixture.js');
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
      const { glbChunks, GLB_JSON } = await import('/packages/shared/glb.js');
      const { Animation } = await import('/packages/animation/dist/index.js');
      const { MToon } = await import('/packages/rigging/dist/mtoon.js');
      const targetBytes = new Uint8Array(
          await (await fetch('/examples/assets/vrm/' + filename + '.vrm')).arrayBuffer(),
        ),
        doc = JSON.parse(new TextDecoder().decode(glbChunks(targetBytes).find((c) => c.type === GLB_JSON).data));
      const model = await parseGLTFAsync(engine, targetBytes, { signal: AbortSignal.timeout(90000) });
      model.root.setPosition([0, -0.8, 0]);
      const material = MToon.attach(model),
        animation = Animation.attach(model),
        avatar = readVRM(doc),
        vrm = addVRM(animation, avatar, { springs: false });
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
        handle = await addPoseTracking(animation, avatar, { vrm, coordinateSpace: 'margo', smoothing: 0 });
      const frame = {
        poseWorldLandmarks: bodyPoints(),
        leftHandLandmarks: handPoints('left'),
        rightHandLandmarks: handPoints('right'),
      };
      handle.push(frame);
      handle.tracker.calibrate();
      handle.update(0);
      const neutral = await render();
      frame.poseWorldLandmarks[13] = { x: 0.3, y: 1.85, z: 0.15 };
      frame.poseWorldLandmarks[15] = { x: 0.4, y: 2.05, z: 0.2 };
      frame.poseWorldLandmarks[25].z = 0.2;
      for (const hand of [frame.leftHandLandmarks, frame.rightHandLandmarks])
        for (const start of [1, 5, 9, 13, 17]) {
          hand[start + 2].y -= 0.025;
          hand[start + 3].y -= 0.05;
        }
      handle.push(frame);
      const controlled = await render(),
        pose = handle.tracker.update(0);
      let drawn = 0;
      for (let k = 3; k < controlled.length; k += 4) if (controlled[k] > 0.01) drawn++;
      const finger = pose.rotations.leftIndexIntermediate;
      frame.poseWorldLandmarks[13] = { x: 0.2, y: 1.9, z: 0 };
      frame.poseWorldLandmarks[15] = { x: 0.2, y: 2.2, z: 0 };
      frame.poseWorldLandmarks[25] = { x: 0.55, y: 1, z: 0 };
      frame.poseWorldLandmarks[27] = { x: 0.9, y: 1, z: 0 };
      for (const hand of [frame.leftHandLandmarks, frame.rightHandLandmarks])
        for (const start of [1, 5, 9, 13, 17])
          for (const j of [2, 3])
            hand[start + j] = { x: hand[start + j - 1].x, y: hand[start + j - 1].y - 0.025, z: hand[start + j - 1].z };
      handle.push(frame);
      const extreme = await render(),
        extremePose = handle.tracker.update(0);
      const extremeFinger = extremePose.rotations.leftIndexIntermediate;
      handle.dispose();
      const restored = await render();
      const result = {
        filename,
        extremeChanged: changed(uncontrolled, extreme),
        extremeFinger,
        extremeBones: Object.keys(extremePose.rotations).length,
        width,
        height,
        drawn,
        changed: changed(uncontrolled, controlled),
        neutral: changed(uncontrolled, neutral),
        restored: changed(uncontrolled, restored),
        finger,
        bones: Object.keys(pose.rotations).length,
      };
      const validation = await d.popErrorScope();
      window.poseCleanup = () => {
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
    assert.ok(Math.abs(result.finger[2]) > 0.3);
    assert.equal(result.bones, 50);
    assert.equal(result.extremeBones, 50);
    assert.ok(result.extremeChanged > 10);
    assert.ok(Math.abs(result.extremeFinger[2]) > 0.7);
    assert.equal(result.neutral, 0);
    assert.ok(result.drawn > 2000, JSON.stringify(result));
    assert.ok(result.changed > 10, JSON.stringify(result));
    assert.equal(result.restored, 0);
    await context.page.screenshot({
      path: `test-results/pose-tracking/${result.filename}${process.argv.includes('--compat') ? '-compat' : ''}.png`,
    });
    await context.page.evaluate(() => window.poseCleanup());
    console.log(JSON.stringify(result));
    await writeFile(
      `test-results/pose-tracking/${result.filename}${process.argv.includes('--compat') ? '-compat' : ''}.json`,
      JSON.stringify(result, null, 2),
    );
  }
} finally {
  await context.close();
}
