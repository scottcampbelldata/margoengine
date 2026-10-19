// Real-WebGPU check of clustered light decay and the angle/penumbra cone. Clustered.setLights packs the lights, the
// decay-aware light terms of clusteredSampling (packages/clustered/src/shader.ts) compute falloff and cone per sample
// in a compute shader, and both must match the definition shared with @margoengine/bvh's vertex-light bake: window / max(d^decay, 0.01), window =
// range > 0 ? clamp(1 - (d/range)^4, 0, 1)^2 : 1, cone = smoothstep(cos(angle), cos(angle * (1 - penumbra)), dot(-L,
// direction)) with penumbra 0 a hard edge, up to a pi/2 hemisphere. Lights without decay or angle must keep the original
// inverse-square term. The same holds for the light terms @margoengine/environment's VolumetricFog compiles for these
// lights on a real engine, whose whole froxel shader must build and run without a validation error.
// Run: node scripts/clustered-falloff-gpu-check.js (takes the GPU lock).
import assert from 'node:assert/strict';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';

const deg = Math.PI / 180,
  top = [0, 3, 0],
  down = [0, -1, 0];
// [light, sample position]: every light hangs at y = 3.
const cases = [
  [{ position: top, range: 5 }, [0, 1, 0]],
  [{ position: top, range: 0, decay: 1 }, [0, 1, 0]],
  [{ position: top, range: 3, decay: 0 }, [0, 1, 0]],
  [{ position: top, range: 0, decay: 2 }, [0, 2.95, 0]],
  [{ position: top, range: 0, decay: 1.5 }, [1, 0, 0.5]],
  [{ position: top, range: 4, direction: down, outerAngle: 0.6, innerAngle: 0.3 }, [Math.tan(0.45) * 2, 1, 0]],
  [{ position: top, range: 0, direction: down, angle: 30 * deg }, [Math.tan(29.5 * deg) * 2, 1, 0]],
  [{ position: top, range: 0, direction: down, angle: 30 * deg }, [Math.tan(30.5 * deg) * 2, 1, 0]],
  [{ position: top, range: 0, direction: down, angle: 30 * deg, penumbra: 0.5 }, [Math.tan(22.5 * deg) * 2, 1, 0]],
  [
    { position: top, range: 6, direction: [0.2, -1, 0.1], angle: 40 * deg, penumbra: 0.3, decay: 1.2 },
    [0.8, 0.5, -0.3],
  ],
  // A hemisphere (angle pi/2), lit just in front of its plane, dark just behind it, with and without a penumbra.
  [{ position: top, range: 0, direction: [1, 0, 0], angle: 90 * deg }, [0.02, 1, 0]],
  [{ position: top, range: 0, direction: [1, 0, 0], angle: 90 * deg }, [-0.02, 1, 0]],
  [{ position: top, range: 5, direction: [1, 0, 0], angle: 90 * deg, penumbra: 0.5 }, [1, 1.5, 0.5]],
  [{ position: top, range: 5, direction: [0, -1, 0], outerAngle: 90 * deg, innerAngle: 1 }, [2.5, 2.9, 0]],
];
const smoothstep = (low, high, x) => {
  if (x < low) return 0;
  if (x >= high) return 1;
  const t = (x - low) / (high - low);
  return t * t * (3 - 2 * t);
};
function expected(light, position) {
  const delta = light.position.map((v, i) => v - position[i]),
    d = Math.hypot(...delta),
    window = light.range > 0 ? Math.min(Math.max(1 - (d / light.range) ** 4, 0), 1) ** 2 : 1,
    fresh = light.decay !== undefined || light.angle !== undefined,
    falloff = window / Math.max(fresh ? d ** (light.decay ?? 2) : d * d, 0.01);
  if (!light.direction) return [falloff, 1];
  const length = Math.hypot(...light.direction),
    x = -delta.reduce((sum, v, i) => sum + (v / d) * (light.direction[i] / length), 0),
    outer = light.angle ?? light.outerAngle,
    inner = light.angle === undefined ? light.innerAngle : light.angle * (1 - (light.penumbra ?? 0));
  return [falloff, smoothstep(Math.cos(outer), Math.cos(inner), x)];
}

const release = await acquire({ owner: 'clustered-falloff-gpu-check' });
let browser;
try {
  browser = await openBrowser({ startPath: '/tests/modern-game.html', port: 5232 });
  assert.equal(browser.hardware.webgpu?.fallback, false, 'Physical GPU required');
  const legacy = cases.flatMap(([light], i) => (light.decay === undefined && light.angle === undefined ? [i] : []));
  const got = await browser.page.evaluate(
    async ({ cases, legacy }) => {
      const { Clustered } = await import('/packages/clustered/src/index.ts');
      const { clusteredSampling } = await import('/packages/clustered/src/shader.ts');
      const adapter = await navigator.gpu.requestAdapter(),
        device = await adapter.requestDevice();
      // Falloff and cone per [light, sample] from the WGSL `terms` (let falloff=...; var cone=...), lights packed by setLights.
      const measure = async (terms, list) => {
        const packed = new Clustered().setLights(list.map(([light]) => light)).data.slice(0, list.length * 16),
          samples = new Float32Array(list.flatMap(([, p]) => [...p, 1]));
        device.pushErrorScope('validation');
        const module = device.createShaderModule({
          code: `struct ClusterLight {positionRange:vec4f,colorIntensity:vec4f,directionOuter:vec4f,params:vec4f}
@group(0) @binding(0) var<storage,read> lights:array<ClusterLight>;
@group(0) @binding(1) var<storage,read> samples:array<vec4f>;
@group(0) @binding(2) var<storage,read_write> result:array<vec2f>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u){
  let light=lights[id.x];let position=samples[id.x].xyz;
  let delta=light.positionRange.xyz-position;let distance=length(delta);let l=delta/max(distance,0.0001);
  ${terms}
  result[id.x]=vec2f(falloff,cone);
}`,
        });
        const errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error');
        if (errors.length) throw new Error(errors.map((m) => m.message).join('\n'));
        const storage = (data) => {
          const buffer = device.createBuffer({
            size: data.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
          });
          device.queue.writeBuffer(buffer, 0, data);
          return buffer;
        };
        const result = device.createBuffer({
            size: list.length * 8,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
          }),
          read = device.createBuffer({
            size: list.length * 8,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          }),
          pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } }),
          encoder = device.createCommandEncoder(),
          pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(
          0,
          device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [storage(packed), storage(samples), result].map((buffer, binding) => ({
              binding,
              resource: { buffer },
            })),
          }),
        );
        pass.dispatchWorkgroups(list.length);
        pass.end();
        encoder.copyBufferToBuffer(result, 0, read, 0, list.length * 8);
        device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const values = [...new Float32Array(read.getMappedRange().slice(0))];
        const validation = await device.popErrorScope();
        if (validation) throw new Error(validation.message);
        return values;
      };
      // VolumetricFog's froxel shader as it builds and runs for these lights on a real engine (Tonemap capture,
      // Clustered), and the light terms cut from its localLight.
      const fogTerms = async (list) => {
        const { EngineKernel } = await import('/packages/core/dist/index.js'),
          { engineRuntime } = await import('/packages/core/dist/extension.js'),
          { Tonemap } = await import('/packages/tonemap/dist/index.js'),
          { VolumetricFog } = await import('/packages/environment/dist/volumetric.js'),
          lit = await import('/packages/clustered/dist/index.js');
        const canvas = document.createElement('canvas');
        canvas.style.cssText = 'width:64px;height:64px';
        document.body.append(canvas);
        const instance = await EngineKernel.create(canvas, {
            backend: 'webgpu',
            camera: { position: [0, 2, 6], target: [0, 1, 0] },
          }),
          gpu = engineRuntime(instance).gpu,
          create = gpu.createShaderModule.bind(gpu),
          modules = [];
        instance.stop();
        gpu.createShaderModule = (descriptor) => {
          const module = create(descriptor);
          if (descriptor.code.includes('fn inject')) modules.push([descriptor.code, module]);
          return module;
        };
        gpu.pushErrorScope('validation');
        Tonemap.attach(instance);
        const lights = lit.Clustered.attach(instance);
        lights.setLights(list.map(([light]) => light));
        VolumetricFog.attach(instance, { lights });
        instance.render();
        await gpu.queue.onSubmittedWorkDone();
        const validation = await gpu.popErrorScope(),
          [code, module] = modules[0],
          errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error');
        instance.dispose();
        canvas.remove();
        if (validation || errors.length)
          throw new Error(validation?.message ?? errors.map((m) => m.message).join('\n'));
        const local = code.slice(code.indexOf('fn localLight(')),
          from = local.indexOf('let l=delta/max(distance,0.0001);') + 'let l=delta/max(distance,0.0001);'.length;
        return local.slice(from, local.indexOf('result+=', from));
      };
      // The decay-aware light terms, cut from the shader clusteredSampling emits once a light sets decay or angle.
      const shader = clusteredSampling(0, undefined, undefined, false, true),
        decayTerms = shader.slice(shader.indexOf('let kind='), shader.indexOf('result+=', shader.indexOf('let kind=')));
      const old = legacy.map((i) => cases[i]),
        fog = await fogTerms(cases),
        oldFog = await fogTerms(old);
      return {
        clustered: await measure(decayTerms, cases),
        fog: await measure(fog, cases),
        oldFog: await measure(oldFog, old),
        decayAware: [fog.includes('let kind=light.params.y;'), oldFog.includes('let kind=')],
      };
    },
    { cases, legacy },
  );
  let worst = 0;
  const compare = (values, list, label) =>
    list.forEach(([light, position], i) => {
      const want = expected(light, position);
      for (let k = 0; k < 2; k++) {
        const error = Math.abs(values[i * 2 + k] - want[k]) / Math.max(Math.abs(want[k]), 1e-3);
        worst = Math.max(worst, error);
        assert.ok(
          error < 1e-4,
          `${label} ${i} ${k ? 'cone' : 'falloff'}: GPU ${values[i * 2 + k]}, definition ${want[k]}`,
        );
      }
    });
  compare(got.clustered, cases, 'clustered case');
  compare(got.fog, cases, 'volumetric fog case');
  compare(
    got.oldFog,
    legacy.map((i) => cases[i]),
    'volumetric fog with old-style lights only, light',
  );
  assert.deepEqual(got.decayAware, [true, false], 'the fog switches to the decay-aware terms only with such a light');
  for (const values of [got.clustered, got.fog]) {
    assert.equal(values[1], 1, 'a point light has no cone');
    assert.deepEqual([values[13], values[15]], [1, 0], 'penumbra 0: a hard edge either side of 30 degrees');
    assert.deepEqual([values[21], values[23]], [1, 0], 'angle pi/2: lit in front of the plane, dark behind');
  }
  console.log(
    `${cases.length} lights in clustered's light loop and in the volumetric fog's froxel loop (and its ${legacy.length} old-style lights alone): GPU falloff and cone match the definition (worst relative error ${worst.toExponential(2)}) on ${browser.hardware.webgpu?.vendor} ${browser.hardware.webgpu?.architecture}`,
  );
} finally {
  await browser?.close();
  release();
}
