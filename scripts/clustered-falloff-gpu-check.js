// Real-WebGPU check of clustered light decay and the angle/penumbra cone. Clustered.setLights packs the lights, the
// decay-aware light terms of clusteredSampling (packages/clustered/src/shader.ts) compute falloff and cone per sample
// in a compute shader, and both must match the definition shared with @margoengine/bvh's vertex-light bake: window / max(d^decay, 0.01), window =
// range > 0 ? clamp(1 - (d/range)^4, 0, 1)^2 : 1, cone = smoothstep(cos(angle), cos(angle * (1 - penumbra)), dot(-L,
// direction)) with penumbra 0 a hard edge, up to a pi/2 hemisphere. Lights without decay or angle must keep the original
// inverse-square term.
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
  const got = await browser.page.evaluate(async (cases) => {
    const { Clustered } = await import('/packages/clustered/src/index.ts');
    const { clusteredSampling } = await import('/packages/clustered/src/shader.ts');
    // The decay-aware light terms, cut from the shader clusteredSampling emits once a light sets decay or angle.
    const shader = clusteredSampling(0, undefined, undefined, false, true),
      decayTerms = shader.slice(shader.indexOf('let kind='), shader.indexOf('result+=', shader.indexOf('let kind=')));
    const lights = new Clustered().setLights(cases.map(([light]) => light)),
      packed = lights.data.slice(0, cases.length * 16),
      samples = new Float32Array(cases.flatMap(([, p]) => [...p, 1]));
    const adapter = await navigator.gpu.requestAdapter(),
      device = await adapter.requestDevice();
    device.pushErrorScope('validation');
    const module = device.createShaderModule({
      code: `struct ClusterLight {positionRange:vec4f,colorIntensity:vec4f,directionOuter:vec4f,params:vec4f}
@group(0) @binding(0) var<storage,read> lights:array<ClusterLight>;
@group(0) @binding(1) var<storage,read> samples:array<vec4f>;
@group(0) @binding(2) var<storage,read_write> result:array<vec2f>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u){
  let light=lights[id.x];let position=samples[id.x].xyz;
  let delta=light.positionRange.xyz-position;let distance=length(delta);let l=delta/max(distance,0.0001);
  ${decayTerms}
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
        size: cases.length * 8,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      }),
      read = device.createBuffer({ size: cases.length * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
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
    pass.dispatchWorkgroups(cases.length);
    pass.end();
    encoder.copyBufferToBuffer(result, 0, read, 0, cases.length * 8);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const values = [...new Float32Array(read.getMappedRange().slice(0))];
    const validation = await device.popErrorScope();
    if (validation) throw new Error(validation.message);
    return values;
  }, cases);
  let worst = 0;
  cases.forEach(([light, position], i) => {
    const want = expected(light, position);
    for (let k = 0; k < 2; k++) {
      const error = Math.abs(got[i * 2 + k] - want[k]) / Math.max(Math.abs(want[k]), 1e-3);
      worst = Math.max(worst, error);
      assert.ok(error < 1e-4, `case ${i} ${k ? 'cone' : 'falloff'}: GPU ${got[i * 2 + k]}, definition ${want[k]}`);
    }
  });
  assert.equal(got[1], 1, 'a point light has no cone');
  assert.deepEqual([got[13], got[15]], [1, 0], 'penumbra 0: a hard edge either side of 30 degrees');
  assert.deepEqual([got[21], got[23]], [1, 0], 'angle pi/2: lit in front of the plane, dark behind');
  console.log(
    `${cases.length} lights: GPU falloff and cone match the definition (worst relative error ${worst.toExponential(2)}) on ${browser.hardware.webgpu?.vendor} ${browser.hardware.webgpu?.architecture}`,
  );
} finally {
  await browser?.close();
  release();
}
