import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser({ startPath: '/tests/modern-game.html' });
const { page } = browser;
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

try {
  await page.evaluate(async () => {
    const { EngineKernel, box, PbrMaterial } = await import('/packages/core/dist/index.js');
    const { PostStack } = await import('/packages/post/dist/stack.js');
    const { Bloom } = await import('/packages/post/dist/bloom.js');
    const { Water } = await import('/packages/water/dist/index.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:512px;height:320px';
    document.body.append(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 8,
      camera: { position: [0, 3.5, 10], target: [0, -0.9, 0], near: 0.1, far: 140 },
    });
    const stack = PostStack.attach(engine, [new Bloom({ strength: 0, exposure: 0 })]);
    const water = Water.attach(engine, {
      size: [105, 105],
      segments: 32,
      depth: () => stack.depthTexture,
      color: [0.004, 0.013, 0.019],
      foamDistance: 0.12,
      waves: [{ direction: [1, 0], amplitude: 0, wavelength: 8 }],
    });
    const block = engine
      .createMesh()
      .setGeometry(box(4, 0.1, 4))
      .setMaterial(new PbrMaterial({ color: '#051216', roughness: 1 }));
    engine.gpu.pushErrorScope('validation');
    const device = engine.gpu;
    const count = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    const readback = device.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({
          code: `
            @group(0) @binding(0) var foam: texture_2d<f32>;
            @group(0) @binding(1) var<storage, read_write> count: atomic<u32>;
            @compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
              if (textureLoad(foam, vec2i(id.xy), 0).r > 0.01) {
                atomicAdd(&count, 1u);
              }
            }
          `,
        }),
        entryPoint: 'main',
      },
    });
    window.contactTest = { engine, block, water, count, readback, pipeline };
  });
  const foamPixels = (height) =>
    page.evaluate(async (height) => {
      const { engine, block, water, count, readback, pipeline } = window.contactTest;
      block.visible = height !== null;
      if (height !== null) block.setPosition([0.07, height, 0.12]);
      const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
      await waitForPipelines(async () => {
        engine.render({ delta: 0 });
        await engine.gpu.queue.onSubmittedWorkDone();
      });
      const device = engine.gpu;
      // Read the actual foam target. Beauty pixels also change due to reduced water absorption over the block.
      const { foam, current } = water.view;
      const mask = foam[current];
      const bind = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: mask.createView() },
          { binding: 1, resource: { buffer: count } },
        ],
      });
      const encoder = device.createCommandEncoder();
      encoder.clearBuffer(count);
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(Math.ceil(mask.width / 8), Math.ceil(mask.height / 8));
      pass.end();
      encoder.copyBufferToBuffer(count, 0, readback, 0, 4);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const pixels = new Uint32Array(readback.getMappedRange())[0];
      readback.unmap();
      return pixels;
    }, height);
  assert.equal(await foamPixels(null), 0, 'flat water has no contact foam without geometry');
  const deep = await foamPixels(-2.1);
  const shallow = await foamPixels(-0.075);
  console.log(`contact foam: ${deep} deep silhouette pixels and ${shallow} contact pixels`);
  assert.equal(deep, 0, `false foam traces a submerged silhouette in ${deep} pixels`);
  assert.ok(shallow > 200, `the near-surface band has only ${shallow} foam pixels`);
  const validation = await page.evaluate(async () => (await window.contactTest.engine.gpu.popErrorScope())?.message);
  assert.equal(validation, undefined);
  assert.deepEqual(errors, []);
} finally {
  await page.evaluate(() => {
    if (!window.contactTest) return;
    const { count, readback, engine } = window.contactTest;
    count.destroy();
    readback.destroy();
    engine.dispose();
  });
  await closeAll({ browser });
}
