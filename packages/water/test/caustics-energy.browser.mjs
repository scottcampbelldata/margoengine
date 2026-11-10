import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

// A 2 x 2 m ideal refracting patch sends every corner to one focus. Integrate
// the production raster map, independently of any scene/projector or emitter CPU code.
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' });
try {
  const reports = [];
  for (const [resolution, beyondInterface] of [
    [64, false],
    [1024, false],
    [64, true],
  ]) {
    const report = await browser.page.evaluate(
      async ({ resolution, control, beyondInterface }) => {
        const { EngineKernel } = await import('/packages/core/dist/index.js');
        const { causticBeams, causticRange } = await import('/packages/water/src/caustics-shader.ts');
        const canvas = document.createElement('canvas');
        document.body.replaceChildren(canvas);
        const engine = await EngineKernel.create(canvas, { backend: 'webgpu', capacity: 1 });
        const d = engine.gpu;
        d.pushErrorScope('validation');
        const shader = `
struct Config {camera:mat4x4f,eye:vec4f,light:vec4f,radiance:vec4f,ambient:vec4f,water:vec4f,grid:vec4f,lengths:vec4f,color:vec4f}
@group(0) @binding(0) var<uniform> frame:Config;
struct SurfaceSample {displacement:vec3f,normal:vec3f}
fn oceanAt(base:vec2f)->SurfaceSample {
 let direction=normalize(vec3f(-base.x,-10,-base.y));
 let normal=normalize(vec3f(0,-1.0/1.333,0)-direction);
 return SurfaceSample(vec3f(0),${beyondInterface ? 'vec3f(0,1,0)' : 'normal'});
}`;
        const source = d.createBuffer({ size: 192, usage: 72 });
        const values = new Float32Array(48);
        values.set([2, 2, 1, 0], 36);
        if (beyondInterface) values[32] = -1;
        d.queue.writeBuffer(source, 0, values);
        const uniform = d.createBuffer({ size: 384, usage: 72 });
        const settings = new Float32Array(96);
        settings.set([0, 1, 0, 2], 48);
        settings.set([-10, 0, 2, 1], 80);
        if (beyondInterface) settings.set([0, 1, 2, 1], 80);
        settings.set([1.333, resolution, 0, 0], 84);
        d.queue.writeBuffer(uniform, 0, settings);
        const maps = Array.from({ length: 3 }, () =>
          d.createTexture({ size: [resolution, resolution], format: 'rgba16float', usage: 20 }),
        );
        const range = d.createBuffer({ size: 4, usage: 200 });
        d.queue.writeBuffer(range, 0, new Float32Array([1]));
        const module = d.createShaderModule({ code: causticBeams({ kind: 'fft', segments: 1, shader }, '') });
        const blend = {
          color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        };
        const pipeline = d.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'beamVertex' },
          fragment: { module, entryPoint: 'beamFragment', targets: maps.map(() => ({ format: 'rgba16float', blend })) },
        });
        const first = d.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: source } }],
        });
        const second = d.createBindGroup({
          layout: pipeline.getBindGroupLayout(1),
          entries: [
            { binding: 0, resource: { buffer: uniform } },
            { binding: 2, resource: { buffer: range } },
          ],
        });
        const count = resolution * resolution;
        const output = d.createBuffer({ size: count * 4, usage: 132 }),
          staging = d.createBuffer({ size: count * 4, usage: 9 });
        const reader = d.createShaderModule({
          code: `@group(0) @binding(0) var image:texture_2d<f32>;@group(0) @binding(1) var<storage,read_write> out:array<f32>;
@group(0) @binding(2) var<storage,read> range:array<f32>;
@compute @workgroup_size(8,8) fn sampleMap(@builtin(global_invocation_id) id:vec3u){out[id.y*${resolution}u+id.x]=textureLoad(image,vec2i(id.xy),0).y*range[0];}`,
        });
        const read = d.createComputePipeline({ layout: 'auto', compute: { module: reader, entryPoint: 'sampleMap' } });
        const readBind = d.createBindGroup({
          layout: read.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: maps[0].createView() },
            { binding: 1, resource: { buffer: output } },
            { binding: 2, resource: { buffer: range } },
          ],
        });
        const e = d.createCommandEncoder();
        if (!control) {
          const module = d.createShaderModule({ code: causticRange({ kind: 'fft', segments: 1, shader }) });
          for (const entryPoint of ['measure', 'reduce']) {
            const pipeline = d.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } });
            const pass = e.beginComputePass();
            pass.setPipeline(pipeline);
            if (entryPoint === 'measure')
              pass.setBindGroup(
                0,
                d.createBindGroup({
                  layout: pipeline.getBindGroupLayout(0),
                  entries: [{ binding: 0, resource: { buffer: source } }],
                }),
              );
            pass.setBindGroup(
              1,
              d.createBindGroup({
                layout: pipeline.getBindGroupLayout(1),
                entries:
                  entryPoint === 'measure'
                    ? [
                        { binding: 0, resource: { buffer: uniform } },
                        { binding: 2, resource: { buffer: range } },
                      ]
                    : [{ binding: 2, resource: { buffer: range } }],
              }),
            );
            pass.dispatchWorkgroups(1);
            pass.end();
          }
        }
        const p = e.beginRenderPass({
          colorAttachments: maps.map((map) => ({ view: map.createView(), loadOp: 'clear', storeOp: 'store' })),
        });
        p.setPipeline(pipeline);
        p.setBindGroup(0, first);
        p.setBindGroup(1, second);
        p.draw(12);
        p.end();
        const compute = e.beginComputePass();
        compute.setPipeline(read);
        compute.setBindGroup(0, readBind);
        compute.dispatchWorkgroups(resolution / 8, resolution / 8);
        compute.end();
        e.copyBufferToBuffer(output, 0, staging, 0, count * 4);
        d.queue.submit([e.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const image = Array.from(new Float32Array(staging.getMappedRange().slice(0)));
        staging.unmap();
        const eta = 1 / 1.333,
          t = [-1, -10, -1].map((v) => v / Math.sqrt(102)),
          n = [-t[0], -eta - t[1], -t[2]];
        const cosine = n[1] / Math.hypot(...n),
          transmitted = Math.sqrt(1 - eta * eta * (1 - cosine * cosine));
        const rs = (eta * cosine - transmitted) / (eta * cosine + transmitted),
          rp = (cosine - eta * transmitted) / (cosine + eta * transmitted);
        const expected = beyondInterface
            ? 4 * (1 - ((1.333 - 1) / (1.333 + 1)) ** 2)
            : 4 * (1 - (rs * rs + rp * rp) / 2),
          actual = image.reduce((sum, value) => sum + value, 0) * (4 / resolution) ** 2;
        const validation = await d.popErrorScope();
        for (const r of [source, uniform, output, staging, range, ...maps]) r.destroy();
        engine.dispose();
        return {
          resolution,
          beyondInterface,
          expected,
          actual,
          relativeError: Math.abs(actual - expected) / expected,
          lit: image.filter((v) => v > 0).length,
          finite: image.every(Number.isFinite),
          validation: validation?.message,
        };
      },
      { resolution, beyondInterface, control: process.argv.includes('--unscaled-control') },
    );
    reports.push(report);
    console.log(JSON.stringify(report));
  }
  await mkdir('test-results', { recursive: true });
  await writeFile(
    `test-results/water-caustics-energy-${process.argv.includes('--compat') ? 'compat' : 'webgpu'}.json`,
    JSON.stringify({ reports, hardware: browser.hardware }, null, 2),
  );
  for (const report of reports) {
    assert.equal(report.validation, undefined);
    assert.equal(report.finite, true);
    assert.ok(report.relativeError < 0.005, `collapsed-beam flux ${report.relativeError}`);
  }
} finally {
  await browser.close();
}
