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
    const { sphereGeometry } = await import('/packages/geometry/dist/primitives.js');
    const sphere = sphereGeometry(0.5, 64, 32),
      vertices = new Float32Array((sphere.positions.length / 3) * 20);
    for (let i = 0; i < sphere.positions.length / 3; i++)
      vertices.set(
        [
          ...sphere.positions.slice(i * 3, i * 3 + 3),
          1,
          ...sphere.normals.slice(i * 3, i * 3 + 3),
          0,
          1,
          0,
          0,
          1,
          ...sphere.uvs.slice(i * 2, i * 2 + 2),
          0,
          0,
          0,
          0,
          0,
          0,
        ],
        i * 20,
      );
    const extension = {
      specVersion: '1.0',
      shadeColorFactor: [1, 0, 0],
      outlineColorFactor: [0, 0, 1],
      outlineLightingMixFactor: 0,
    };
    const doc = {
      asset: { version: '2.0' },
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: {}, material: 0 }] }],
      materials: [
        {
          pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1], metallicFactor: 0, roughnessFactor: 1 },
          extensions: { VRMC_materials_mtoon: extension },
        },
      ],
    };
    const model = parsePreparedPBR(engine, doc, [[{ vertices, indices: sphere.indices }]]);
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
    const rows = [];
    engine.lighting.radiance.set([1, 1, 1, 0]);
    engine.lighting.direction.set([0, 0, 1, 1]);
    for (const mode of ['worldCoordinates', 'screenCoordinates'])
      for (const distance of [2, 4]) {
        engine.camera.position[2] = distance;
        extension.outlineWidthMode = mode;
        extension.outlineWidthFactor = mode === 'screenCoordinates' ? 0.04 : 0.1;
        const effect = MToon.attach(model);
        await waitForPipelines(async () => {
          engine.render({ delta: 0 });
          await d.queue.onSubmittedWorkDone();
        });
        const image = await read(),
          red = [],
          blue = [];
        for (let x = 0; x < width; x++) {
          const at = (Math.floor(height / 2) * width + x) * 4;
          if (image[at] > 0.5 && image[at + 2] < 0.1) red.push(x);
          if (image[at + 2] > 0.5 && image[at] < 0.1) blue.push(x);
        }
        rows.push({ mode, distance, width, height, red, blue });
        effect.dispose();
      }
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
    assert.ok(row.red.length > 4 && row.blue.length > 0, JSON.stringify(row));
    const outer = Math.max(...row.blue),
      body = Math.max(...row.red),
      measured = outer - body;
    const focal = row.width / (2 * Math.tan((25 * Math.PI) / 180));
    const projected = (r) => (focal * r) / Math.sqrt(row.distance ** 2 - r * r);
    const expected = row.mode === 'screenCoordinates' ? 0.04 * row.height : projected(0.6) - projected(0.5);
    assert.ok(Math.abs(measured - expected) <= 1.5, JSON.stringify({ row, measured, expected }));
  }
  console.log(JSON.stringify(result));
  await writeFile(
    `test-results/mtoon/oracle-outline${process.argv.includes('--compat') ? '-compat' : ''}.json`,
    JSON.stringify(result, null, 2),
  );
} finally {
  await context.close();
}
