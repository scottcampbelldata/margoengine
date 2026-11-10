import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { riverModel, riverStep } from './rivers-reference.js';

// Water/rivers on the GPU against the independent float64 model: a 10 m waterfall and a steep chute fed by one source near the brink,
// then the cost of the river solver against Water's own coast flow on a 256 x 256 map (diagnostic, this machine).
const width = 24,
  height = 8,
  ground = new Float64Array(width * height);
for (let z = 0; z < height; z++)
  for (let x = 0; x < width; x++)
    ground[z * width + x] = (z === 0 || z === height - 1 ? 30 : 0) + (x < 12 ? 20 : 10 - (x - 12) * 0.5);
const sources = [{ position: [9.5, 4], discharge: 6, radius: 1 }],
  frames = 240,
  substeps = 8;
const model = riverModel({ ground, width, height, cell: 1 });
const dt = Math.fround(Math.fround(1 / 30) / 3) * Math.fround(3 / substeps);
let peak = 0;
for (let i = 0; i < frames * substeps; i++) peak = Math.max(peak, riverStep(model, dt, sources));

const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' });
const errors = [];
browser.page.on('pageerror', (error) => errors.push(error.message));
browser.page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
try {
  const result = await browser.page.evaluate(
    async ({ ground, width, height, sources, frames, substeps }) => {
      const { EngineKernel } = await import('/packages/core/dist/index.js');
      const { Water } = await import('/packages/water/dist/index.js');
      const { Rivers } = await import('/packages/water/dist/rivers.js');
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:128px;height:96px';
      document.body.replaceChildren(canvas);
      const engine = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 4,
        camera: { position: [12, 40, 30], target: [12, 10, 4], near: 0.1, far: 500 },
      });
      const d = engine.gpu;
      d.pushErrorScope('validation');
      const heightmap = (w, h, values) => {
        const t = d.createTexture({ size: [w, h], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | 2 });
        d.queue.writeTexture({ texture: t }, new Float32Array(values), { bytesPerRow: w * 4 }, [w, h]);
        return t;
      };
      const read = async (texture) => {
        const count = texture.width * texture.height;
        const buffer = d.createBuffer({ size: count * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const staging = d.createBuffer({ size: count * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const pipeline = d.createComputePipeline({
          layout: 'auto',
          compute: {
            module: d.createShaderModule({
              code: `@group(0) @binding(0) var t:texture_2d<f32>;@group(0) @binding(1) var<storage,read_write> out:array<vec4f>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){let s=textureDimensions(t);if(any(id.xy>=s)){return;}out[id.y*s.x+id.x]=textureLoad(t,vec2i(id.xy),0);}`,
            }),
            entryPoint: 'main',
          },
        });
        const e = d.createCommandEncoder(),
          p = e.beginComputePass();
        p.setPipeline(pipeline);
        p.setBindGroup(
          0,
          d.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: texture.createView() },
              { binding: 1, resource: { buffer } },
            ],
          }),
        );
        p.dispatchWorkgroups(Math.ceil(texture.width / 8), Math.ceil(texture.height / 8));
        p.end();
        e.copyBufferToBuffer(buffer, 0, staging, 0, count * 16);
        d.queue.submit([e.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const data = new Float32Array(staging.getMappedRange().slice(0));
        staging.destroy();
        buffer.destroy();
        return data;
      };
      const terrain = heightmap(width, height, ground);
      const water = Water.attach(engine, {
        height: -100,
        size: [200, 200],
        segments: 32,
        waves: [{ direction: [1, 0], amplitude: 0, wavelength: 10 }],
        terrain: { heightmap: () => terrain, origin: [0, 0], size: [width, height] },
      });
      const rivers = Rivers.attach(water, { sources, substeps });
      for (let i = 0; i < frames; i++) engine.render({ delta: 1 / 30 });
      await d.queue.onSubmittedWorkDone();
      const state = await read(water.coastalDepthTexture);
      const depth = Array.from({ length: width * height }, (_, i) => state[i * 4]);
      // Disposal hands the coast back to Water's own solver, which restarts from the terrain.
      rivers.dispose();
      engine.render({ delta: 1 / 30 });
      await d.queue.onSubmittedWorkDone();
      const restarted = (await read(water.coastalDepthTexture)).filter((_, i) => i % 4 === 0);
      water.dispose();
      // Cost: 256 x 256 cells of 2 m over a sloped valley, the coast flow alone versus rivers at 8 substeps.
      const side = 256,
        valley = Array.from({ length: side * side }, (_, i) => {
          const x = i % side,
            z = Math.floor(i / side);
          return 200 - x * 0.6 + Math.abs(z - side / 2) * 0.5 + (x > 128 ? -20 : 0);
        });
      const big = heightmap(side, side, valley),
        timings = {};
      for (const mode of ['coast', 'rivers']) {
        const w = Water.attach(engine, {
          height: -100,
          size: [600, 600],
          segments: 32,
          waves: [{ direction: [1, 0], amplitude: 0, wavelength: 10 }],
          terrain: { heightmap: () => big, origin: [0, 0], size: [512, 512] },
        });
        const r =
          mode === 'rivers'
            ? Rivers.attach(w, { sources: [{ position: [4, 256], discharge: 200, radius: 6 }] })
            : undefined;
        for (let i = 0; i < 10; i++) engine.render({ delta: 1 / 30 });
        await d.queue.onSubmittedWorkDone();
        const start = performance.now();
        for (let i = 0; i < 60; i++) engine.render({ delta: 1 / 30 });
        await d.queue.onSubmittedWorkDone();
        timings[mode] = (performance.now() - start) / 60;
        r?.dispose();
        w.dispose();
      }
      const validation = await d.popErrorScope();
      return { depth, restarted, timings, validation: validation?.message };
    },
    { ground: Array.from(ground), width, height, sources, frames, substeps },
  );
  let worst = 0;
  for (let i = 0; i < width * height; i++) worst = Math.max(worst, Math.abs(result.depth[i] - model.depth[i]));
  const summary = {
    worst,
    reachedChute: result.depth[4 * width + 21],
    modelChute: model.depth[4 * width + 21],
    peak,
    restartedDry: result.restarted.every((v) => v === 0),
    timings: result.timings,
    validation: result.validation,
  };
  console.log(JSON.stringify(summary));
  assert.deepEqual(errors, []);
  assert.equal(result.validation, undefined);
  // float32 against float64 over 1920 substeps (8 s, long enough to fill the chute): under a millimetre of a 0.1..0.3 m river.
  assert.ok(worst < 1e-3, `GPU against model ${worst} m`);
  assert.ok(summary.reachedChute > 0.001, `chute depth ${summary.reachedChute}`);
  assert.ok(peak <= 0.5 / dt);
  assert.equal(summary.restartedDry, true);
  assert.ok(Object.values(result.timings).every((t) => Number.isFinite(t) && t > 0));
  await mkdir('test-results', { recursive: true });
  await writeFile(
    `test-results/water-rivers-${process.argv.includes('--compat') ? 'compat' : 'webgpu'}.json`,
    JSON.stringify({ ...summary, hardware: browser.hardware }, null, 2),
  );
} finally {
  await browser.close();
}
