import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const context = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' });
const errors = [];
context.page.on('pageerror', (e) => errors.push(e.message));
try {
  const result = await context.page.evaluate(async () => {
    const { EngineKernel } = await import('/packages/core/dist/index.js');
    const { CameraProjection } = await import('/packages/cameras/dist/index.js');
    const { parsePreparedPBR } = await import('/packages/gltf-pro/dist/index.js');
    const { SceneTarget } = await import('/packages/shared/msaa.js');
    const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    const { MToon } = await import('/packages/rigging/dist/mtoon.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:96px;height:96px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 16,
      camera: { position: [0, 0, 3], target: [0, 0, 0], near: 0.1, far: 10 },
    });
    CameraProjection.attach(engine, { mode: 'orthographic', height: 2 });
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
    const vertices = new Float32Array(80);
    for (const [i, [x, y]] of [
      [-0.8, -0.8],
      [0.8, -0.8],
      [0.8, 0.8],
      [-0.8, 0.8],
    ].entries()) {
      vertices.set([x, y, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, (x + 0.8) / 1.6, (y + 0.8) / 1.6, 0, 0, 0, 0, 0, 0], i * 20);
    }
    const extension = { specVersion: '1.0', shadeColorFactor: [0.2, 0.3, 0.4], shadingToonyFactor: 0.9 };
    const doc = {
      asset: { version: '2.0' },
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: {}, material: 0 }] }],
      materials: [
        {
          pbrMetallicRoughness: { baseColorFactor: [0.8, 0.6, 0.4, 1], metallicFactor: 0, roughnessFactor: 1 },
          extensions: { VRMC_materials_mtoon: extension },
        },
      ],
    };
    const model = parsePreparedPBR(engine, doc, [[{ vertices, indices: new Uint32Array([0, 1, 2, 0, 2, 3]) }]]);
    const module = d.createShaderModule({
      code: `@group(0) @binding(0) var image:texture_2d<f32>;@group(0) @binding(1) var<storage,read_write> out:vec4f;
   @compute @workgroup_size(1) fn main(){out=textureLoad(image,vec2i(textureDimensions(image)/2u),0);}`,
    });
    const pipeline = d.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const output = d.createBuffer({ size: 16, usage: 132 }),
      staging = d.createBuffer({ size: 16, usage: 9 });
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
      p.dispatchWorkgroups(1);
      p.end();
      e.copyBufferToBuffer(output, 0, staging, 0, 16);
      d.queue.submit([e.finish()]);
      await staging.mapAsync(1);
      const rgba = Array.from(new Float32Array(staging.getMappedRange()));
      staging.unmap();
      return rgba;
    }
    const rows = [];
    const effect = MToon.attach(model);
    engine.use({
      name: 'mtoon:gbuffer-oracle',
      setup() {},
      registerPasses(graph) {
        graph.add({
          name: 'mtoon:gbuffer-oracle',
          order: 2,
          execute(c) {
            const p = c.encoder.beginRenderPass({
              colorAttachments: [{ view: target.color, loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' }],
              depthStencilAttachment: { view: target.depth, depthLoadOp: 'load', depthStoreOp: 'store' },
            });
            p.end();
            model.draw(c, 'gbuffer', target.color, target.depth);
          },
        });
      },
    });
    await waitForPipelines(async () => {
      engine.render({ delta: 0 });
      await d.queue.onSubmittedWorkDone();
    });
    rows.push({ rgba: await read() });
    effect.dispose();
    const validation = await d.popErrorScope();
    model.dispose();
    engine.dispose();
    target.dispose();
    color.destroy();
    depth.destroy();
    output.destroy();
    staging.destroy();
    return { rows, validation: validation?.message };
  });
  assert.equal(result.validation, undefined);
  assert.deepEqual(errors, []);
  for (const row of result.rows) {
    const expected = [0, 0, 1, 3];
    for (let k = 0; k < 4; k++)
      assert.ok(Math.abs(row.rgba[k] - expected[k]) < 0.001, JSON.stringify({ row, expected, k }));
  }
  console.log(JSON.stringify(result));
  await writeFile(
    `test-results/mtoon/oracle-gbuffer${process.argv.includes('--compat') ? '-compat' : ''}.json`,
    JSON.stringify(result, null, 2),
  );
} finally {
  await context.close();
}
