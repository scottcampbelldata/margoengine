// Real-WebGPU check of @margoengine/clustered/shapes (after npm run build:packages; takes the GPU lock).
// 1. clusterShapeLighting, as ShapeLights declares it, runs in a compute shader for sphere, disc and tube lights at
//    receivers seen from several angles and roughnesses, wholly above and across the horizon; every value equals the
//    float64 mirror of the WGSL (packages/clustered/test/shapes-reference.js) within float32 rounding.
// 2. On a real engine a core floor under Clustered with ShapeLights renders without a validation error, brighter with
//    the lights than with an empty ShapeLights, which renders the same as none.
// Run: node scripts/shape-lights-gpu-check.js
import assert from 'node:assert/strict';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';
import { ShapeLights } from '../packages/clustered/dist/shapes.js';
import { shapes } from '../packages/clustered/test/shapes-reference.js';

const lights = [
  { shape: 'sphere', position: [0.5, 0.3, 2], radius: 0.4, color: [1, 0.8, 0.6], intensity: 3 },
  { shape: 'sphere', position: [2, 0, 0.2], radius: 0.6 },
  { shape: 'sphere', position: [0.01, -0.02, 40], radius: 0.05, intensity: 100 },
  { shape: 'disc', position: [0.2, 0.1, 1.5], direction: [-0.1, 0, -1], radius: 0.5 },
  { shape: 'disc', position: [1.2, 0, 0.1], direction: [-1, 0, 0.2], radius: 0.5, twoSided: true },
  { shape: 'disc', position: [0, 0, 2], direction: [0, 0, 1], radius: 0.5 },
  { shape: 'tube', start: [-1, 0.3, 1], end: [1, 0.3, 1.2], radius: 0.1, color: [0.6, 0.8, 1] },
  { shape: 'tube', start: [0, -0.5, 0.6], end: [0, 0.5, 0.6], radius: 0.08 },
  { shape: 'tube', start: [0, 0, 3], end: [0.05, 0, 1.5], radius: 0.2 },
];
const packed = (() => {
  const s = new ShapeLights({ lights: { setLights() {} } });
  s.setLights(lights);
  return Array.from(s.data.subarray(0, 4 + lights.length * 12));
})();
const view = (degrees) => [Math.sin((degrees * Math.PI) / 180), 0, Math.cos((degrees * Math.PI) / 180)];
// [light index, view degrees, roughness, metal]; receiver at the origin, normal +z.
const samples = [];
lights.forEach((_, i) => {
  for (const degrees of [0, 40, 80]) for (const roughness of [0.2, 0.7]) samples.push([i, degrees, roughness, i % 2]);
});
const base = [0.8, 0.6, 0.4];

const release = await acquire({ owner: 'shape-lights-gpu-check' });
let browser;
try {
  browser = await openBrowser({ startPath: '/tests/modern-game.html', port: 5241 });
  assert.equal(browser.hardware.webgpu?.fallback, false, 'Physical GPU required');
  const got = await browser.page.evaluate(
    async ({ packed, samples, base, count }) => {
      const { ShapeLights } = await import('/packages/clustered/dist/shapes.js');
      const adapter = await navigator.gpu.requestAdapter(),
        device = await adapter.requestDevice();
      const declarations = new ShapeLights({ lights: { setLights() {} } }).declarations(0);
      // One light per sample: the buffer header's count is 1 and each sample reads its own copy of the table.
      device.pushErrorScope('validation');
      const module = device.createShaderModule({
        code: `${declarations}
struct Sample {view:vec4f,material:vec4f}
@group(0) @binding(1) var<storage,read> samples:array<Sample>;
@group(0) @binding(2) var<storage,read_write> result:array<vec4f>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u){
  let s=samples[id.x];let v=s.view.xyz;let n=vec3f(0,0,1);
  result[id.x]=vec4f(clusterShapeLighting(vec3f(0),n,v,clamp(dot(n,v),0.0001,1.0),vec3f(${base.join(',')}),s.material.x,s.material.y,vec3f(0.04),1.0),0);
}`,
      });
      const errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error');
      if (errors.length) return { error: errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('\n') };
      const { ltcTable } = await import('/packages/clustered/src/ltc.ts'),
        table = ltcTable(),
        lutOffset = (4 + 64 * 12) * 4;
      const storage = (data, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST) => {
        const buffer = device.createBuffer({ size: data.byteLength, usage });
        device.queue.writeBuffer(buffer, 0, data);
        return buffer;
      };
      const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } }),
        out = [];
      for (const [index, degrees, roughness, metal] of samples) {
        const data = new ArrayBuffer(lutOffset + table.byteLength),
          f = new Float32Array(data);
        new Uint32Array(data)[0] = 1;
        f.set(packed.slice(4 + index * 12, 16 + index * 12), 4);
        new Uint16Array(data, lutOffset).set(table);
        const v = [Math.sin((degrees * Math.PI) / 180), 0, Math.cos((degrees * Math.PI) / 180), 0],
          result = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
          read = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
          encoder = device.createCommandEncoder(),
          pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(
          0,
          device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 150, resource: { buffer: storage(new Uint8Array(data)) } },
              { binding: 1, resource: { buffer: storage(new Float32Array([...v, roughness, metal, 0, 0])) } },
              { binding: 2, resource: { buffer: result } },
            ],
          }),
        );
        pass.dispatchWorkgroups(1);
        pass.end();
        encoder.copyBufferToBuffer(result, 0, read, 0, 16);
        device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        out.push([...new Float32Array(read.getMappedRange().slice(0)).slice(0, 3)]);
      }
      const validation = await device.popErrorScope();
      if (validation) return { error: validation.message };

      // A real engine: a core floor lit by Clustered and the shaped lights.
      const { EngineKernel } = await import('/packages/core/dist/index.js'),
        core = await import('/packages/core/dist/extension.js'),
        { Clustered } = await import('/packages/clustered/dist/index.js');
      const width = 128,
        canvas = document.createElement('canvas');
      canvas.style.cssText = `width:${width}px;height:${width}px`;
      document.body.append(canvas);
      const instance = await EngineKernel.create(canvas, {
          backend: 'webgpu',
          capacity: 4,
          camera: { position: [0, 6, 4], target: [0, 0, 0], fov: 50, near: 0.1, far: 40 },
        }),
        engine = core.engineRuntime(instance),
        uncaptured = [];
      instance.stop();
      engine.gpu.addEventListener('uncapturederror', (event) => uncaptured.push(event.error.message));
      instance
        .createMesh()
        .setGeometry(core.box())
        .setScale([8, 0.2, 8])
        .setPosition([0, -0.1, 0])
        .setMaterial(new core.PbrMaterial({ color: [0.6, 0.6, 0.6], roughness: 0.4 }));
      const lit = Clustered.attach(instance);
      lit.setLights([{ position: [0, 4, 0], range: 0.01, intensity: 0 }]);
      const render = async () => {
        const device = engine.gpu,
          context = canvas.getContext('webgpu'),
          format = navigator.gpu.getPreferredCanvasFormat(),
          bytesPerRow = width * 4;
        let current;
        context.configure({ device, format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
        const getCurrentTexture = context.getCurrentTexture.bind(context);
        context.getCurrentTexture = () => (current = getCurrentTexture());
        const read = device.createBuffer({
          size: bytesPerRow * width,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        instance.render({ culling: false });
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: current }, { buffer: read, bytesPerRow }, [width, width]);
        device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const bytes = new Uint8Array(read.getMappedRange()).slice();
        read.destroy();
        let sum = 0;
        for (let i = 0; i < bytes.length; i += 4) sum += bytes[i] + bytes[i + 1] + bytes[i + 2];
        return sum / (bytes.length / 4) / 3;
      };
      const none = await render(),
        shaped = ShapeLights.attach(instance, { lights: lit }),
        empty = await render();
      shaped.setLights([
        { shape: 'sphere', position: [-1.5, 1, 0], radius: 0.3, intensity: 20 },
        { shape: 'disc', position: [1.5, 1.5, 0], direction: [0, -1, 0], radius: 0.4, intensity: 20 },
        { shape: 'tube', start: [-1, 0.6, 1.5], end: [1, 0.6, 1.5], radius: 0.05, intensity: 40 },
      ]);
      const bright = await render();
      shaped.dispose();
      instance.dispose();
      canvas.remove();
      return { out, none, empty, bright, uncaptured, count };
    },
    { packed, samples, base, count: lights.length },
  );
  assert.equal(got.error, undefined, got.error);
  let worst = 0;
  samples.forEach(([index, degrees, roughness, metal], i) => {
    const want = shapes(
      packed.slice(4 + index * 12, 16 + index * 12),
      [0, 0, 0],
      [0, 0, 1],
      view(degrees),
      base,
      roughness,
      metal,
    ).total;
    const peak = Math.max(...want),
      radiance = Math.max(...packed.slice(12 + index * 12, 15 + index * 12));
    for (let k = 0; k < 3; k++) {
      // float32: the eigenvalue refinement keeps a few 1e-5 relative, so 1e-3 of the sample's largest channel bounds
      // it with room for the GPU's own transcendental functions. A horizon-clipped sliver is the small difference of
      // edge terms near 0.1 that float32 keeps to about 1e-7 each: 1e-6 of the light's radiance more.
      const error = Math.abs(got.out[i][k] - want[k]),
        bound = 1e-3 * peak + 1e-6 * radiance;
      worst = Math.max(worst, error / bound);
      assert.ok(
        error <= bound,
        `light ${index} view ${degrees} r${roughness} m${metal} ch${k}: GPU ${got.out[i][k]}, mirror ${want[k]}`,
      );
    }
  });
  assert.deepEqual(got.uncaptured, [], 'no validation error on the engine');
  assert.equal(got.empty, got.none, 'an empty ShapeLights renders as none');
  assert.ok(got.bright > got.none + 5, `the shaped lights brighten the floor: ${got.bright} vs ${got.none}`);
  console.log(
    `${samples.length} shaped-light samples (${got.count} lights): GPU equals the float64 mirror, worst error ${worst.toFixed(2)} of its bound; engine floor mean ${got.none.toFixed(1)} -> ${got.bright.toFixed(1)} on ${browser.hardware.webgpu?.vendor} ${browser.hardware.webgpu?.architecture}`,
  );
} finally {
  await browser?.close();
  release();
}
