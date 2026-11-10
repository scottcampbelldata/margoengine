import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const context = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' });
const errors = [];
context.page.on('pageerror', (e) => errors.push(e.message));
try {
  const result = await context.page.evaluate(async (vrm1) => {
    const { EngineKernel } = await import('/packages/core/dist/index.js');
    const { CameraProjection } = await import('/packages/cameras/dist/index.js');
    const { parsePreparedPBR } = await import('/packages/gltf-pro/dist/index.js');
    const { SceneTarget } = await import('/packages/shared/msaa.js');
    const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    const { MToon } = await import('/packages/rigging/dist/mtoon.js');
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
    const { loadVRM0 } = await import('/packages/rigging/dist/vrm0.js');
    const { Animation } = await import('/packages/animation/dist/index.js');
    const { addVRM, readVRM } = await import('/packages/rigging/dist/vrm.js');
    const model = vrm1
      ? await (await import('/packages/gltf-pro/dist/index.js')).loadGLTF(engine, '/examples/assets/vrm/Seed-san.vrm', {
          signal: AbortSignal.timeout(90000),
        })
      : await loadVRM0(engine, '/examples/assets/vrm/AliciaSolid_vrm-0.51.vrm', { signal: AbortSignal.timeout(90000) });
    model.root.setPosition([0, -0.8, 0]);
    const animation = new Animation(model);
    engine.use(animation);
    const vrm = addVRM(animation, readVRM(model.asset.doc), { springs: false });
    vrm.update(0);
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
    const fallback = await render(),
      effect = MToon.attach(model, { expressions: vrm.expressions }),
      neutral = await render();
    vrm.expressions.set('happy', 1).set('aa', 1);
    vrm.update(0);
    const smile = await render();
    vrm.expressions.set('happy', 0).set('aa', 0);
    vrm.update(0);
    const restored = await render();
    const styles = Array.from(effect.materials.values());
    effect.dispose();
    const props = vrm1
      ? model.asset.doc.materials.map((m) => m.extensions?.VRMC_materials_mtoon).filter(Boolean)
      : model.asset.doc.extensions.VRMC_vrm.extras.vrm0.materialProperties;
    const modes = props.map((m) => (vrm1 ? m.outlineWidthMode : m.floatProperties._OutlineWidthMode));
    props.forEach((m) => {
      if (vrm1) m.outlineWidthMode = 'none';
      else m.floatProperties._OutlineWidthMode = 0;
    });
    const plain = MToon.attach(model, { expressions: vrm.expressions }),
      withoutOutline = await render();
    plain.dispose();
    props.forEach((m, i) => {
      if (vrm1) m.outlineWidthMode = modes[i];
      else m.floatProperties._OutlineWidthMode = modes[i];
    });
    const final = MToon.attach(model, { expressions: vrm.expressions });
    await render();
    let drawn = 0;
    for (let k = 3; k < neutral.length; k += 4) if (neutral[k] > 0.01) drawn++;
    const result = {
      vrm1,
      width,
      height,
      drawn,
      materials: styles.length,
      changed: changed(fallback, neutral),
      face: changed(neutral, smile),
      restored: changed(neutral, restored),
      outline: changed(neutral, withoutOutline),
    };
    const validation = await d.popErrorScope();
    window.mtoonRealCleanup = () => {
      final.dispose();
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
  }, process.argv.includes('--vrm1'));
  assert.equal(result.validation, undefined);
  assert.deepEqual(errors, []);
  assert.equal(result.materials, result.vrm1 ? 10 : 12);
  assert.ok(result.drawn > 2000, JSON.stringify(result));
  assert.ok(result.changed > 500, JSON.stringify(result));
  assert.ok(result.face > 20, JSON.stringify(result));
  assert.equal(result.restored, 0);
  assert.ok(result.outline > 0, JSON.stringify(result));
  await context.page.screenshot({
    path: `test-results/mtoon/avatar${result.vrm1 ? '-vrm1' : ''}${process.argv.includes('--compat') ? '-compat' : ''}.png`,
  });
  await context.page.evaluate(() => window.mtoonRealCleanup());
  console.log(JSON.stringify(result));
  await writeFile(
    `test-results/mtoon/oracle-avatar${result.vrm1 ? '-vrm1' : ''}${process.argv.includes('--compat') ? '-compat' : ''}.json`,
    JSON.stringify(result, null, 2),
  );
} finally {
  await context.close();
}
