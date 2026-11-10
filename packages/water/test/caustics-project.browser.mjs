import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
import { writeFile, mkdir } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

// Exact pixel-centre planes isolate the projector from mesh rasterization/MSAA.
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' });
try {
  const result = await browser.page.evaluate(async () => {
    const { EngineKernel } = await import('/packages/core/dist/index.js');
    const { causticProject } = await import('/packages/water/src/caustics-shader.ts');
    const { fullscreen } = await import('/packages/shared/gpu.js');
    const canvas = document.createElement('canvas');
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, { backend: 'webgpu', capacity: 1 });
    const d = engine.gpu;
    d.pushErrorScope('validation');
    const resources = [],
      texture = (format, layers = 1) => {
        const t = d.createTexture({ size: [64, 64, layers], format, usage: 20 });
        resources.push(t);
        return t;
      };
    const color = texture('rgba16float'),
      field = texture('rgba32float'),
      depth = texture('depth32float');
    const maps = Array.from({ length: 3 }, () => texture('rgba16float', 2)),
      output = texture('rgba32float');
    const uniform = d.createBuffer({ size: 384, usage: 72 }),
      range = d.createBuffer({ size: 4, usage: 136 }),
      shadowBuffer = d.createBuffer({ size: 16, usage: 72 });
    resources.push(uniform, range, shadowBuffer);
    d.queue.writeBuffer(range, 0, new Float32Array([1]));
    const u = new Float32Array(96);
    // inverse maps NDC x/y to x/z and reversed depth to height, viewed from above.
    u.set([4, 0, 0, 0, 0, 0, -4, 0, 0, 20, 0, 0, 0, -10, 0, 1], 16);
    u.set([0, 8, 0, 0], 32);
    u.set([0, 1, 0, 4], 48);
    u.set([1, 1, 1, 1], 52);
    u.set([0, 0, 64, 64], 56);
    u.set([-10, 0, 2, 1], 80);
    u.set([1, 1, 1, 0], 92);
    d.queue.writeBuffer(uniform, 0, u);
    const sampler = d.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    const fill = (encoder, tex, code, layer = 0) => {
      const isDepth = tex.format.startsWith('depth');
      const module = d.createShaderModule({ code: fullscreen + code });
      const p = d.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fill', targets: isDepth ? [] : [{ format: tex.format }] },
        ...(isDepth
          ? { depthStencil: { format: 'depth32float', depthCompare: 'always', depthWriteEnabled: true } }
          : {}),
      });
      const pass = encoder.beginRenderPass(
        isDepth
          ? {
              colorAttachments: [],
              depthStencilAttachment: {
                view: tex.createView(),
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
                depthClearValue: 0,
              },
            }
          : {
              colorAttachments: [
                {
                  view: tex.createView({ dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1 }),
                  loadOp: 'clear',
                  storeOp: 'store',
                },
              ],
            },
      );
      pass.setPipeline(p);
      pass.draw(3);
      pass.end();
    };
    const shadow = `@group(1) @binding(0) var<uniform> mask:vec4f;fn shadowLit(color:vec3f,p:vec3f,n:vec3f)->f32{return select(1.0,0.0,p.x>mask.x);}`;
    const pipelines = ['', shadow].map((s) => {
      const module = d.createShaderModule({ code: causticProject(s) });
      return d.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rgba32float' }] },
      });
    });
    const reader = d.createShaderModule({
      code: `@group(0) @binding(0) var t:texture_2d<f32>;@group(0) @binding(1) var<storage,read_write> out:array<vec4f>;@compute @workgroup_size(8,8) fn read(@builtin(global_invocation_id) id:vec3u){out[id.y*64u+id.x]=textureLoad(t,vec2i(id.xy),0);}`,
    });
    const rp = d.createComputePipeline({ layout: 'auto', compute: { module: reader, entryPoint: 'read' } }),
      buffer = d.createBuffer({ size: 64 * 64 * 16, usage: 132 }),
      staging = d.createBuffer({ size: 64 * 64 * 16, usage: 9 });
    resources.push(buffer, staging);
    const rows = [];
    for (const [name, height, a, b, dry, occlude] of [
      ['flat', -5, 0, 0, false, false],
      ['tilted', -5, 0.4, 0.2, false, false],
      ['raised', -1, 0, 0, false, false],
      ['dry', -5, 0, 0, true, false],
      ['above', 1, 0, 0, false, false],
      ['receiver-shadow', -5, 0, 0, false, true],
      ['outside-height', -9, 0, 0, false, false],
    ]) {
      const bottom = name === 'outside-height' ? -8 : -10;
      u[80] = bottom;
      d.queue.writeBuffer(uniform, 0, u);
      const encoder = d.createCommandEncoder();
      fill(encoder, color, '@fragment fn fill()->@location(0) vec4f{return vec4f(0.25,0.5,0.75,1);}');
      fill(
        encoder,
        field,
        `@fragment fn fill(@builtin(position)p:vec4f)->@location(0) vec4f{return select(vec4f(0,1,0,0),vec4f(0),${dry ? 'p.x>32.0' : 'false'});}`,
      );
      fill(
        encoder,
        depth,
        `@fragment fn fill(@builtin(position)p:vec4f)->@builtin(frag_depth) f32{let x=(p.x/64.0*2.0-1.0)*4.0;let z=(p.y/64.0*2.0-1.0)*4.0;return (${height}.0+${a}*x+${b}*z+10.0)/20.0;}`.replace(
          /(-?\d+)\.0\.0/g,
          '$1.0',
        ),
      );
      for (let c = 0; c < 3; c++)
        for (let l = 0; l < 2; l++)
          fill(
            encoder,
            maps[c],
            `@fragment fn fill()->@location(0)vec4f{return vec4f(${0.125 * (c + 1)},${0.5 + l * 0.25},${0.0625 * (c + 1)},0);}`,
            l,
          );
      const pipeline = pipelines[+occlude],
        pass = encoder.beginRenderPass({
          colorAttachments: [{ view: output.createView(), loadOp: 'clear', storeOp: 'store' }],
        });
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        d.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { buffer: uniform },
            color.createView(),
            depth.createView(),
            ...maps.map((t) => t.createView({ dimension: '2d-array' })),
            field.createView(),
            sampler,
            { buffer: range },
          ].map((resource, binding) => ({ binding, resource })),
        }),
      );
      if (occlude)
        pass.setBindGroup(
          1,
          d.createBindGroup({
            layout: pipeline.getBindGroupLayout(1),
            entries: [{ binding: 0, resource: { buffer: shadowBuffer } }],
          }),
        );
      pass.draw(3);
      pass.end();
      const read = encoder.beginComputePass();
      read.setPipeline(rp);
      read.setBindGroup(
        0,
        d.createBindGroup({
          layout: rp.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: output.createView() },
            { binding: 1, resource: { buffer } },
          ],
        }),
      );
      read.dispatchWorkgroups(8, 8);
      read.end();
      encoder.copyBufferToBuffer(buffer, 0, staging, 0, 64 * 64 * 16);
      d.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const pixels = new Float32Array(staging.getMappedRange().slice(0));
      staging.unmap();
      let worst = 0,
        probes = 0;
      const n = [-a, 1, -b].map((v) => v / Math.hypot(a, 1, b));
      for (let y = 2; y < 62; y++)
        for (let x = 2; x < 62; x++) {
          const wx = (((x + 0.5) / 64) * 2 - 1) * 4,
            wz = (((y + 0.5) / 64) * 2 - 1) * 4,
            h = height + a * wx + b * wz;
          const masked = (dry && x >= 32) || (occlude && x >= 32) || h >= 0 || h < bottom;
          for (let c = 0; c < 3; c++) {
            const flux = [0.125 * (c + 1), 0.5 + ((h - bottom) / -bottom) * 0.25, 0.0625 * (c + 1)];
            const expected = masked
              ? 0
              : [0.25, 0.5, 0.75][c] *
                Math.max(
                  0,
                  n.reduce((sum, v, i) => sum + v * flux[i], 0),
                );
            worst = Math.max(worst, Math.abs(pixels[(y * 64 + x) * 4 + c] - expected));
          }
          probes++;
        }
      rows.push({ name, worst, probes, finite: Array.from(pixels).every(Number.isFinite) });
    }
    const validation = await d.popErrorScope();
    for (const r of resources) r.destroy();
    engine.dispose();
    return { rows, validation: validation?.message };
  });
  console.log(JSON.stringify(result));
  await mkdir('test-results', { recursive: true });
  await writeFile(
    `test-results/water-caustics-project-${process.argv.includes('--compat') ? 'compat' : 'webgpu'}.json`,
    JSON.stringify({ ...result, hardware: browser.hardware }, null, 2),
  );
  assert.equal(result.validation, undefined);
  for (const row of result.rows) {
    assert.equal(row.finite, true);
    assert.ok(row.worst < 0.001, `${row.name}: ${row.worst}`);
    assert.equal(row.probes, 3600);
  }
} finally {
  await browser.close();
}
